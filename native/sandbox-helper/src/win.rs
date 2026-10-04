use crate::proto::{encode_event, parse_message, Event, Message, Request};
use crate::text::{command_line, environment_block, Utf8Chunker};
use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{Error, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Security::Authorization::*;
use windows::Win32::Security::Isolation::*;
use windows::Win32::Security::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::JobObjects::*;
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::*;

// SE_GROUP_ENABLED from winnt.h.
const SE_GROUP_ENABLED: u32 = 0x4;

type Result<T> = std::result::Result<T, String>;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn describe(what: &str, error: Error) -> String {
    format!("{what} failed: {error}")
}

// Every handle, SID and job is closed on every path out of a run.
struct Handle(HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_invalid() && !self.0 .0.is_null() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

struct Sid(PSID);
impl Drop for Sid {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.0);
        }
    }
}

struct LocalMem(*mut c_void);
impl Drop for LocalMem {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(Some(HLOCAL(self.0)));
            }
        }
    }
}

#[derive(Clone)]
pub struct Emitter(Arc<Mutex<std::io::Stdout>>);

impl Emitter {
    fn send(&self, event: &Event) {
        let mut out = self.0.lock().unwrap();
        let _ = writeln!(out, "{}", encode_event(event));
        let _ = out.flush();
    }
}

// Jobs of the commands in flight, so end of input or a kill message can stop them.
type Jobs = Arc<Mutex<HashMap<u64, usize>>>;

pub fn serve() {
    let emitter = Emitter(Arc::new(Mutex::new(std::io::stdout())));
    let jobs: Jobs = Arc::new(Mutex::new(HashMap::new()));
    let mut workers = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match parse_message(&line) {
            Ok(Message::Run(request)) => {
                let (emitter, jobs) = (emitter.clone(), jobs.clone());
                workers.push(thread::spawn(move || {
                    let id = request.id;
                    if let Err(message) = run(&request, &emitter, &jobs) {
                        emitter.send(&Event::Error {
                            id: Some(id),
                            message: &message,
                        });
                    }
                }));
            }
            Ok(Message::Kill(kill)) => {
                if kill.kill {
                    kill_job(&jobs, Some(kill.id));
                }
            }
            Err(message) => emitter.send(&Event::Error {
                id: None,
                message: &message,
            }),
        }
    }
    // Patch closed its end (or died): nothing may keep running.
    kill_job(&jobs, None);
    for worker in workers {
        let _ = worker.join();
    }
}

fn kill_job(jobs: &Jobs, id: Option<u64>) {
    for (job_id, job) in jobs.lock().unwrap().iter() {
        if id.is_none() || id == Some(*job_id) {
            unsafe {
                let _ = TerminateJobObject(HANDLE(*job as *mut c_void), 1);
            }
        }
    }
}

fn profile_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "patch.sbx.{:x}.{:x}",
        std::process::id(),
        nanos & 0xffff_ffff_ffff
    )
}

const FILE_MODIFY: u32 =
    FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0 | DELETE.0;
const FILE_DENY_WRITE: u32 = FILE_GENERIC_WRITE.0 | DELETE.0 | FILE_DELETE_CHILD.0;
const FILE_READ_EXECUTE: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;

// Adds, denies or removes the container's access entries on a path. Folders pass it on to
// everything inside.
#[derive(Clone, Copy, PartialEq)]
enum Change {
    Grant,
    Deny,
    Revoke,
}

fn edit_acl(path: &str, sid: PSID, access: u32, change: Change) -> Result<()> {
    let wpath = wide(path);
    let target = PCWSTR(wpath.as_ptr());
    let is_dir = Path::new(path).is_dir();
    unsafe {
        let mut old_dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetNamedSecurityInfoW(
            target,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old_dacl),
            None,
            &mut descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot read the permissions of {path} (error {})",
                status.0
            ));
        }
        let _descriptor = LocalMem(descriptor.0);
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: if change == Change::Revoke { 0 } else { access },
            grfAccessMode: match change {
                Change::Grant => GRANT_ACCESS,
                Change::Deny => DENY_ACCESS,
                Change::Revoke => REVOKE_ACCESS,
            },
            grfInheritance: if is_dir {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            },
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: PWSTR(sid.0 as *mut u16),
                ..Default::default()
            },
        };
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let status = SetEntriesInAclW(Some(&[entry]), Some(old_dacl), &mut new_dacl);
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot build the new permissions of {path} (error {})",
                status.0
            ));
        }
        let _new = LocalMem(new_dacl as *mut c_void);
        let status = SetNamedSecurityInfoW(
            target,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_dacl),
            None,
        );
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot change the permissions of {path} (error {})",
                status.0
            ));
        }
    }
    Ok(())
}

struct Pipe {
    read: Handle,
    write: Handle,
}

fn make_pipe() -> Result<Pipe> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        bInheritHandle: true.into(),
        lpSecurityDescriptor: std::ptr::null_mut(),
    };
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    unsafe {
        CreatePipe(&mut read, &mut write, Some(&attributes), 0)
            .map_err(|e| describe("CreatePipe", e))?;
        // The command inherits only its end.
        SetHandleInformation(read, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0))
            .map_err(|e| describe("SetHandleInformation", e))?;
    }
    Ok(Pipe {
        read: Handle(read),
        write: Handle(write),
    })
}

fn open_nul() -> Result<Handle> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        bInheritHandle: true.into(),
        lpSecurityDescriptor: std::ptr::null_mut(),
    };
    let name = wide("NUL");
    unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            Some(&attributes),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .map(Handle)
        .map_err(|e| describe("open NUL", e))
    }
}

fn pump(id: u64, pipe: Handle, emitter: Emitter, stderr: bool) {
    let mut chunker = Utf8Chunker::default();
    let mut buffer = [0u8; 16 * 1024];
    let send = |emitter: &Emitter, text: &str| {
        if text.is_empty() {
            return;
        }
        emitter.send(&if stderr {
            Event::Stderr { id, data: text }
        } else {
            Event::Stdout { id, data: text }
        });
    };
    loop {
        let mut read = 0u32;
        let ok = unsafe {
            windows::Win32::Storage::FileSystem::ReadFile(
                pipe.0,
                Some(&mut buffer),
                Some(&mut read),
                None,
            )
        };
        if ok.is_err() || read == 0 {
            break;
        }
        send(&emitter, &chunker.push(&buffer[..read as usize]));
    }
    send(&emitter, &chunker.finish());
}

fn make_job(request: &Request) -> Result<Handle> {
    unsafe {
        let job = Handle(
            CreateJobObjectW(None, PCWSTR::null()).map_err(|e| describe("CreateJobObject", e))?,
        );
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if request.limits.processes > 0 {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = request.limits.processes;
        }
        if request.limits.memory_mb > 0 {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit =
                (request.limits.memory_mb as usize).saturating_mul(1024 * 1024);
        }
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of_val(&info) as u32,
        )
        .map_err(|e| describe("SetInformationJobObject", e))?;
        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_EXITWINDOWS,
        };
        SetInformationJobObject(
            job.0,
            JobObjectBasicUIRestrictions,
            &ui as *const _ as *const c_void,
            std::mem::size_of_val(&ui) as u32,
        )
        .map_err(|e| describe("SetInformationJobObject (UI)", e))?;
        Ok(job)
    }
}

// Removes the container's access entries and its profile when the run ends, however it ends.
struct Cleanup {
    name: Vec<u16>,
    sid: Option<Sid>,
    // In the order applied; undone in reverse.
    granted: Vec<(String, u32)>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(sid) = &self.sid {
            for (path, access) in self.granted.iter().rev() {
                let _ = edit_acl(path, sid.0, *access, Change::Revoke);
            }
        }
        unsafe {
            let _ = DeleteAppContainerProfile(PCWSTR(self.name.as_ptr()));
        }
    }
}

fn run(request: &Request, emitter: &Emitter, jobs: &Jobs) -> Result<()> {
    let id = request.id;
    let name = wide(&profile_name());
    let sid = unsafe {
        CreateAppContainerProfile(
            PCWSTR(name.as_ptr()),
            windows::core::w!("Patch sandbox"),
            windows::core::w!("Temporary profile for one Patch command"),
            None,
        )
        .map_err(|e| describe("CreateAppContainerProfile", e))?
    };
    let mut cleanup = Cleanup {
        name,
        sid: Some(Sid(sid)),
        granted: Vec::new(),
    };

    for (paths, access, required) in [
        (&request.read_only, FILE_READ_EXECUTE, false),
        (&request.read_write, FILE_MODIFY, true),
    ] {
        for path in paths {
            if !Path::new(path).exists() {
                continue;
            }
            // Record first: a half-applied change must still be undone.
            cleanup.granted.push((path.clone(), access));
            if let Err(message) = edit_acl(path, sid, access, Change::Grant) {
                if required {
                    return Err(message);
                }
            }
        }
    }
    for path in &request.deny_write {
        if !Path::new(path).exists() {
            continue;
        }
        cleanup.granted.push((path.clone(), FILE_DENY_WRITE));
        edit_acl(path, sid, FILE_DENY_WRITE, Change::Deny)?;
    }

    let mut capability_sid = PSID::default();
    let mut capabilities = Vec::new();
    if request.network {
        // internetClient: outgoing connections only.
        unsafe { ConvertStringSidToSidW(windows::core::w!("S-1-15-3-1"), &mut capability_sid) }
            .map_err(|e| describe("ConvertStringSidToSid", e))?;
        capabilities.push(SID_AND_ATTRIBUTES {
            Sid: capability_sid,
            Attributes: SE_GROUP_ENABLED,
        });
    }
    let _capability = LocalMem(capability_sid.0);
    let mut security = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: if capabilities.is_empty() {
            std::ptr::null_mut()
        } else {
            capabilities.as_mut_ptr()
        },
        CapabilityCount: capabilities.len() as u32,
        Reserved: 0,
    };

    let stdout = make_pipe()?;
    let stderr = make_pipe()?;
    let nul = open_nul()?;
    let mut inherited = [nul.0, stdout.write.0, stderr.write.0];

    let mut list_size = 0usize;
    unsafe {
        let _ = InitializeProcThreadAttributeList(None, 2, None, &mut list_size);
    }
    let mut list_buffer = vec![0u8; list_size];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(list_buffer.as_mut_ptr() as *mut c_void);
    unsafe {
        InitializeProcThreadAttributeList(Some(list), 2, None, &mut list_size)
            .map_err(|e| describe("InitializeProcThreadAttributeList", e))?;
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(&mut security as *mut _ as *const c_void),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .map_err(|e| describe("UpdateProcThreadAttribute (container)", e))?;
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(inherited.as_mut_ptr() as *const c_void),
            std::mem::size_of_val(&inherited),
            None,
            None,
        )
        .map_err(|e| describe("UpdateProcThreadAttribute (handles)", e))?;
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nul.0;
    startup.StartupInfo.hStdOutput = stdout.write.0;
    startup.StartupInfo.hStdError = stderr.write.0;
    startup.lpAttributeList = list;

    let mut cmdline = wide(&command_line(&request.command, &request.args));
    let application = wide(&request.command);
    let cwd = wide(&request.cwd);
    // Process creation in a container fails (ERROR_ENVVAR_NOT_FOUND) without LOCALAPPDATA, which Windows rewrites.
    let mut vars = request.env.clone();
    if !vars
        .keys()
        .any(|key| key.eq_ignore_ascii_case("LOCALAPPDATA"))
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            vars.insert("LOCALAPPDATA".to_string(), local);
        }
    }
    let env = environment_block(&vars);
    let mut info = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(cmdline.as_mut_ptr())),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW,
            Some(env.as_ptr() as *const c_void),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    };
    unsafe { DeleteProcThreadAttributeList(list) };
    created.map_err(|e| describe(&format!("Starting {}", request.command), e))?;
    let process = Handle(info.hProcess);
    let thread_handle = Handle(info.hThread);

    // Never let the command run outside the limits: a failure here ends it before it executes anything.
    let job = match make_job(request).and_then(|job| {
        unsafe { AssignProcessToJobObject(job.0, process.0) }
            .map_err(|e| describe("AssignProcessToJobObject", e))?;
        Ok(job)
    }) {
        Ok(job) => job,
        Err(message) => {
            unsafe {
                let _ = TerminateProcess(process.0, 1);
            }
            return Err(message);
        }
    };
    jobs.lock().unwrap().insert(id, job.0 .0 as usize);

    // Only the command holds the write ends now, so the readers end when it and its children are gone.
    let Pipe {
        read: out_read,
        write: out_write,
    } = stdout;
    let Pipe {
        read: err_read,
        write: err_write,
    } = stderr;
    drop((out_write, err_write, nul));
    let readers = [
        {
            let emitter = emitter.clone();
            thread::spawn(move || pump(id, out_read, emitter, false))
        },
        {
            let emitter = emitter.clone();
            thread::spawn(move || pump(id, err_read, emitter, true))
        },
    ];

    unsafe { ResumeThread(thread_handle.0) };
    emitter.send(&Event::Started {
        id,
        pid: info.dwProcessId,
    });

    let timeout = if request.limits.timeout_ms > 0 {
        request.limits.timeout_ms.min(u32::MAX as u64 - 1) as u32
    } else {
        INFINITE
    };
    let waited = unsafe { WaitForSingleObject(process.0, timeout) };
    let timed_out = waited == WAIT_TIMEOUT;
    unsafe {
        // Also ends anything the command left running.
        let _ = TerminateJobObject(job.0, 1);
        WaitForSingleObject(process.0, 5000);
    }
    let mut code = 0u32;
    unsafe {
        let _ = GetExitCodeProcess(process.0, &mut code);
    }
    for reader in readers {
        let _ = reader.join();
    }
    jobs.lock().unwrap().remove(&id);
    drop(job);
    drop(cleanup);
    emitter.send(&Event::Exit {
        id,
        exit_code: code as i64,
        timed_out,
    });
    Ok(())
}
