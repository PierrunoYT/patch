// Named-pipe I/O for the Windows network bridge (#97), shared by sandbox-helper and net-bridge. Handles are opened
// for overlapped I/O: on a synchronous handle every call is serialized, so a read waiting for data would block the
// write going the other way. Every wait also watches a stop event, so one side ending can end the other.
use std::io;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Pipes::{ConnectNamedPipe, WaitNamedPipeW};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn io_error(error: windows::core::Error) -> io::Error {
    io::Error::from_raw_os_error((error.code().0 & 0xffff) as i32)
}

// A manual-reset event: once set, every wait that includes it returns at once.
pub struct Event(HANDLE);
unsafe impl Send for Event {}
unsafe impl Sync for Event {}

impl Event {
    pub fn new() -> io::Result<Self> {
        unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
            .map(Event)
            .map_err(io_error)
    }

    pub fn set(&self) {
        unsafe {
            let _ = SetEvent(self.0);
        }
    }

    pub fn handle(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub struct Pipe(HANDLE);
unsafe impl Send for Pipe {}
unsafe impl Sync for Pipe {}

impl Drop for Pipe {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// Errors that mean the other end has gone, which a reader treats as end of input.
fn closed(error: &windows::core::Error) -> bool {
    [ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, ERROR_NO_DATA]
        .iter()
        .any(|code| error.code() == code.to_hresult())
}

impl Pipe {
    // Takes ownership of a handle opened with FILE_FLAG_OVERLAPPED.
    pub fn from_handle(handle: HANDLE) -> Self {
        Pipe(handle)
    }

    // Runs one overlapped operation to completion, or cancels it when `stop` is set first.
    fn complete(
        &self,
        stop: &Event,
        start: impl FnOnce(*mut OVERLAPPED) -> windows::core::Result<()>,
    ) -> windows::core::Result<u32> {
        let done = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map(Event)?;
        let mut overlapped = OVERLAPPED {
            hEvent: done.handle(),
            ..Default::default()
        };
        match start(&mut overlapped) {
            Ok(()) => {}
            Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => {}
            Err(error) => return Err(error),
        }
        let waited =
            unsafe { WaitForMultipleObjects(&[done.handle(), stop.handle()], false, INFINITE) };
        if waited != WAIT_OBJECT_0 {
            unsafe {
                let _ = CancelIoEx(self.0, Some(&overlapped));
            }
        }
        let mut count = 0u32;
        // Waits for the cancellation too: the OVERLAPPED must outlive the operation.
        unsafe { GetOverlappedResult(self.0, &overlapped, &mut count, true) }.map(|()| count)
    }

    // Waits for a client on a server instance; an error when `stop` was set first.
    pub fn accept(&self, stop: &Event) -> io::Result<()> {
        self.complete(stop, |overlapped| unsafe {
            match ConnectNamedPipe(self.0, Some(overlapped)) {
                // A client that connected before the call: nothing is pending, so signal completion here.
                Err(error) if error.code() == ERROR_PIPE_CONNECTED.to_hresult() => {
                    SetEvent((*overlapped).hEvent)
                }
                other => other,
            }
        })
        .map(|_| ())
        .map_err(io_error)
    }

    // Bytes read; 0 at end of input.
    pub fn read(&self, buffer: &mut [u8], stop: &Event) -> io::Result<usize> {
        match self.complete(stop, |overlapped| unsafe {
            ReadFile(self.0, Some(buffer), None, Some(overlapped))
        }) {
            Ok(count) => Ok(count as usize),
            Err(error) if closed(&error) => Ok(0),
            Err(error) => Err(io_error(error)),
        }
    }

    pub fn write_all(&self, mut buffer: &[u8], stop: &Event) -> io::Result<()> {
        while !buffer.is_empty() {
            let written = self
                .complete(stop, |overlapped| unsafe {
                    WriteFile(self.0, Some(buffer), None, Some(overlapped))
                })
                .map_err(io_error)?;
            if written == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            buffer = &buffer[written as usize..];
        }
        Ok(())
    }
}

// Opens the client end of a pipe, waiting up to `wait` while every instance is busy. Identification-level
// impersonation only: the server learns who connected, and cannot act as them.
pub fn connect(name: &str, wait: Duration) -> io::Result<Pipe> {
    let path = wide(name);
    let deadline = Instant::now() + wait;
    loop {
        let opened = unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                None,
            )
        };
        match opened {
            Ok(handle) => return Ok(Pipe(handle)),
            Err(error) if error.code() == ERROR_PIPE_BUSY.to_hresult() => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io_error(error));
                }
                unsafe {
                    let _ = WaitNamedPipeW(
                        PCWSTR(path.as_ptr()),
                        left.as_millis().min(u32::MAX as u128) as u32,
                    );
                }
            }
            Err(error) => return Err(io_error(error)),
        }
    }
}

// Copies both ways until either side ends or fails, then ends the other: pipes have no half-close.
pub fn relay(a: Pipe, b: Pipe) {
    let (Ok(stop), a, b) = (Event::new(), Arc::new(a), Arc::new(b)) else {
        return;
    };
    let stop = Arc::new(stop);
    let copy = |from: Arc<Pipe>, to: Arc<Pipe>, stop: Arc<Event>| {
        let mut buffer = vec![0u8; 64 * 1024];
        while let Ok(count) = from.read(&mut buffer, &stop) {
            if count == 0 || to.write_all(&buffer[..count], &stop).is_err() {
                break;
            }
        }
        stop.set();
    };
    let forward = {
        let (a, b, stop) = (a.clone(), b.clone(), stop.clone());
        thread::spawn(move || copy(a, b, stop))
    };
    copy(b, a, stop);
    let _ = forward.join();
}
