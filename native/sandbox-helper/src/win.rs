use crate::pipe_io;
use crate::proto::{encode_event, parse_message, Event, Message, Request};
use crate::text::{command_line, environment_block, Utf8Chunker};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::{Error, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Security::Authorization::*;
use windows::Win32::Security::Isolation::*;
use windows::Win32::Security::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::JobObjects::*;
use windows::Win32::System::Pipes::{
    CreateNamedPipeW, CreatePipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
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

struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}
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

struct ProjectDrive {
    name: Vec<u16>,
    target: Vec<u16>,
    cwd: Vec<u16>,
    journaled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct DriveMapping {
    name: String,
    target: String,
}

// Letters a sandbox drive may use, picked from Z down so the usual removable-drive letters come last. Each run holds
// a project and a temporary drive, plus one for toolchains when they are staged; P to Z alone ran out at about four
// concurrent commands (#177). A, B (floppy) and C (system) are never used.
const DRIVE_LETTERS: std::ops::RangeInclusive<u8> = b'D'..=b'Z';

impl DriveMapping {
    // The caller holds PermissionLock through journaling and creation, so helpers cannot pick the same letter.
    // `taken` lists letters this run reserved but has not defined yet.
    fn reserve(path: &str, taken: &[&DriveMapping]) -> Result<Self> {
        let used = unsafe { GetLogicalDrives() };
        if used == 0 {
            return Err("cannot enumerate sandbox drive letters".into());
        }
        for letter in DRIVE_LETTERS.rev() {
            let name = format!("{}:", letter as char);
            if used & (1 << (letter - b'A')) == 0 && taken.iter().all(|other| other.name != name) {
                return Ok(Self {
                    name,
                    target: path.to_string(),
                });
            }
        }
        let running = recovery_records().map(|records| records.len()).unwrap_or(0);
        Err(format!(
            "no drive letter is available for the sandbox working directory: D: to Z: are all in use, and {running} \
             sandboxed command(s) of Patch hold two or three of them each. Wait for a background command to end, or \
             stop one, and try again"
        ))
    }

    fn remove(&self) -> Result<()> {
        let bytes = self.name.as_bytes();
        if bytes.len() != 2
            || !DRIVE_LETTERS.contains(&bytes[0])
            || bytes[1] != b':'
            || !Path::new(&self.target).is_absolute()
        {
            return Err("invalid sandbox project drive mapping".into());
        }
        let name = wide(&self.name);
        let target = wide(&format!(r"\??\{}", self.target));
        unsafe {
            DefineDosDeviceW(
                DDD_REMOVE_DEFINITION
                    | DDD_EXACT_MATCH_ON_REMOVE
                    | DDD_RAW_TARGET_PATH
                    | DDD_NO_BROADCAST_SYSTEM,
                PCWSTR(name.as_ptr()),
                PCWSTR(target.as_ptr()),
            )
        }
        .or_else(|error| {
            if error.code() == windows::core::HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|e| describe("remove sandbox project drive mapping", e))
    }
}

impl ProjectDrive {
    fn create(path: &str) -> Result<Self> {
        let _lock = PermissionLock::acquire()?;
        Self::define(&DriveMapping::reserve(path, &[])?, false)
    }

    fn define(mapping: &DriveMapping, journaled: bool) -> Result<Self> {
        let name = wide(&mapping.name);
        let target = wide(&format!(r"\??\{}", mapping.target));
        unsafe {
            DefineDosDeviceW(
                DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM,
                PCWSTR(name.as_ptr()),
                PCWSTR(target.as_ptr()),
            )
        }
        .map_err(|e| describe("create sandbox drive mapping", e))?;
        Ok(Self {
            name,
            target,
            cwd: wide(&format!("{}\\", mapping.name)),
            journaled,
        })
    }
}

impl Drop for ProjectDrive {
    fn drop(&mut self) {
        // The journal is the sole owner of project cleanup. Removing it twice could erase a new run's
        // mapping if it reused the same letter for the same project between undo and this destructor.
        if self.journaled {
            return;
        }
        unsafe {
            let _ = DefineDosDeviceW(
                DDD_REMOVE_DEFINITION
                    | DDD_EXACT_MATCH_ON_REMOVE
                    | DDD_RAW_TARGET_PATH
                    | DDD_NO_BROADCAST_SYSTEM,
                PCWSTR(self.name.as_ptr()),
                PCWSTR(self.target.as_ptr()),
            );
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
// Some(0) is preparation, None is cancellation, Some(handle) is a running job.
type Jobs = Arc<Mutex<HashMap<u64, Option<usize>>>>;

fn ensure_active(jobs: &Jobs, id: u64) -> Result<()> {
    if jobs.lock().unwrap().get(&id).copied().flatten().is_none() {
        Err("sandbox command stopped during preparation".to_string())
    } else {
        Ok(())
    }
}

pub fn serve() {
    let emitter = Emitter(Arc::new(Mutex::new(std::io::stdout())));
    let log = |code: &str, record: &str, failures: u32| {
        emitter.send(&Event::Log {
            code,
            record,
            failures,
        })
    };
    if let Err(message) = recover_abandoned_runs(&log) {
        emitter.send(&Event::Error {
            id: None,
            message: &message,
        });
        return;
    }
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
                jobs.lock().unwrap().insert(request.id, Some(0));
                workers.push(thread::spawn(move || {
                    let id = request.id;
                    if let Err(message) = run(&request, &emitter, &jobs) {
                        emitter.send(&Event::Error {
                            id: Some(id),
                            message: &message,
                        });
                    }
                    jobs.lock().unwrap().remove(&id);
                }));
            }
            // On a worker like a run, so a slow revoke (it waits for the permission lock) never delays reading the
            // next message, such as a kill for a command (#206). End of input still waits for it below.
            Ok(Message::Revoke(revoke)) => {
                let emitter = emitter.clone();
                workers.push(thread::spawn(move || {
                    if let Err(message) = revoke_project(&revoke.revoke_project) {
                        emitter.send(&Event::Error {
                            id: None,
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

// Starts one AppContainer process and splices this process's stdin/stdout/stderr to it (#87). The request is a JSON
// file (the same object a command sends on stdin), deleted after it is read so the sandboxed program never sees it.
pub fn serve_stdio(path: &str) {
    if let Err(message) = recover_abandoned_runs(&|_, _, _| {}) {
        eprintln!("Patch sandbox: {message}");
        std::process::exit(126);
    }
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) => {
            eprintln!("Patch sandbox: cannot read the sandbox request: {error}");
            std::process::exit(126);
        }
    };
    let _ = fs::remove_file(path);
    let request = match parse_message(&raw) {
        Ok(Message::Run(request)) => request,
        Ok(_) => {
            eprintln!("Patch sandbox: the stdio request must start a program");
            std::process::exit(126);
        }
        Err(message) => {
            eprintln!("Patch sandbox: {message}");
            std::process::exit(126);
        }
    };
    let jobs: Jobs = Arc::new(Mutex::new(HashMap::new()));
    jobs.lock().unwrap().insert(request.id, Some(0));
    match run_inner(&request, None, &jobs) {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("Patch sandbox: {message}");
            jobs.lock().unwrap().remove(&request.id);
            std::process::exit(126);
        }
    }
}

fn kill_job(jobs: &Jobs, id: Option<u64>) {
    for (job_id, job) in jobs.lock().unwrap().iter_mut() {
        if id.is_none() || id == Some(*job_id) {
            if let Some(handle) = *job {
                if handle != 0 {
                    unsafe {
                        let _ = TerminateJobObject(HANDLE(handle as *mut c_void), 1);
                    }
                }
            }
            *job = None;
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
const FILE_READ_EXECUTE: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;

// Adds or removes the container's access entries on a path. Folders pass it on to everything inside.
#[derive(Clone, Copy, PartialEq)]
enum Change {
    Grant,
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
        // Granting needs the same read access, so a path whose permissions can't be read never got the grant and
        // there is nothing to revoke; failing here would keep its recovery record, and every later start, failing.
        if change == Change::Revoke && status == ERROR_ACCESS_DENIED {
            return Ok(());
        }
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot read the permissions of {path} (error {})",
                status.0
            ));
        }
        let _descriptor = LocalMem(descriptor.0);
        if change == Change::Revoke && !acl_allows(old_dacl, sid)? {
            return Ok(());
        }
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: if change == Change::Revoke { 0 } else { access },
            grfAccessMode: match change {
                Change::Grant => GRANT_ACCESS,
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

// Stops the path inheriting from its parent, keeping today's entries as explicit copies except any for `strip`: the
// project capability's write grant, which would otherwise be copied in and make protected Git metadata writable.
fn protect_acl(path: &str, strip: PSID) -> Result<()> {
    let wpath = wide(path);
    unsafe {
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetNamedSecurityInfoW(
            PCWSTR(wpath.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
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
        let stripped = if dacl.is_null() {
            None
        } else {
            Some(acl_without(dacl, strip)?)
        };
        let status = SetNamedSecurityInfoW(
            PCWSTR(wpath.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            stripped.as_ref().map(|acl| acl.as_ptr() as *const ACL),
            None,
        );
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot protect the permissions of {path} (error {})",
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

fn copy_pipe(from: SendHandle, to: SendHandle) {
    let (from, to) = (from.0, to.0);
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let mut read = 0u32;
        let ok = unsafe {
            windows::Win32::Storage::FileSystem::ReadFile(
                from,
                Some(&mut buffer),
                Some(&mut read),
                None,
            )
        };
        if ok.is_err() || read == 0 {
            break;
        }
        let mut offset = 0usize;
        while offset < read as usize {
            let mut written = 0u32;
            let ok = unsafe {
                windows::Win32::Storage::FileSystem::WriteFile(
                    to,
                    Some(&buffer[offset..read as usize]),
                    Some(&mut written),
                    None,
                )
            };
            if ok.is_err() || written == 0 {
                break;
            }
            offset += written as usize;
        }
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

fn sid_string(sid: PSID) -> Result<String> {
    let mut text = PWSTR::null();
    unsafe { ConvertSidToStringSidW(sid, &mut text) }
        .map_err(|e| describe("ConvertSidToStringSid", e))?;
    let _text = LocalMem(text.0 as *mut c_void);
    unsafe { text.to_string() }.map_err(|_| "non-Unicode SID".to_string())
}

fn user_sid_string() -> Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| describe("OpenProcessToken", e))?;
        let token = Handle(token);
        let mut size = 0u32;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut size);
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut c_void),
            size,
            &mut size,
        )
        .map_err(|e| describe("GetTokenInformation", e))?;
        sid_string((*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid)
    }
}

// A pipe instance only this user, from inside this run's AppContainer, may open. The low integrity label lets the
// AppContainer write to it; without it, the default medium label refuses writes from below.
fn create_relay_pipe(name: &str, sddl: &str, first: bool) -> Result<pipe_io::Pipe> {
    let sddl = wide(sddl);
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|e| describe("build the network relay permissions", e))?;
    let _descriptor = LocalMem(descriptor.0);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let name = wide(name);
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            PIPE_ACCESS_DUPLEX
                | FILE_FLAG_OVERLAPPED
                | if first {
                    // Fails if anything else already owns the name.
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    FILE_FLAGS_AND_ATTRIBUTES(0)
                },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            Some(&attributes),
        )
    };
    if handle.is_invalid() {
        return Err(format!(
            "cannot create the network relay pipe: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(pipe_io::Pipe::from_handle(handle))
}

// The only way out of a command whose network is filtered by host (#97). The command has no network capability;
// net-bridge, inside the same AppContainer, forwards its loopback proxy port to this pipe, and every connection
// is relayed to Patch's filtering proxy. Stops accepting when dropped; connections in flight end with their peers.
struct ProxyRelay {
    name: String,
    stop: Arc<pipe_io::Event>,
}

impl ProxyRelay {
    fn start(profile: &str, container: PSID, proxy: &str) -> Result<Self> {
        let name = format!(r"\\.\pipe\patch-sbx-net-{profile}");
        let sddl = format!(
            "D:P(A;;GA;;;{})(A;;GRGW;;;{})S:(ML;;NW;;;LW)",
            user_sid_string()?,
            sid_string(container)?
        );
        let first = create_relay_pipe(&name, &sddl, true)?;
        let stop = Arc::new(
            pipe_io::Event::new().map_err(|e| format!("cannot start the network relay: {e}"))?,
        );
        let (accepting, pipe_name, proxy) = (stop.clone(), name.clone(), proxy.to_string());
        thread::spawn(move || {
            let mut next = Some(first);
            loop {
                let pipe = match next.take() {
                    Some(pipe) => pipe,
                    None => match create_relay_pipe(&pipe_name, &sddl, false) {
                        Ok(pipe) => pipe,
                        Err(_) => return,
                    },
                };
                if pipe.accept(&accepting).is_err() {
                    return;
                }
                let proxy = proxy.clone();
                thread::spawn(move || {
                    // A proxy that is gone lets nothing through: the bridge's client sees the connection close.
                    if let Ok(upstream) = pipe_io::connect(&proxy, Duration::from_secs(5)) {
                        pipe_io::relay(pipe, upstream);
                    }
                });
            }
        });
        Ok(Self { name, stop })
    }
}

impl Drop for ProxyRelay {
    fn drop(&mut self) {
        self.stop.set();
    }
}

// Written and flushed before any permission change. A sharing lock distinguishes a live run from
// an abandoned one without relying on PIDs (which Windows can reuse). Recovery knows the exact
// profile even after Windows has forgotten its SID-to-name mapping; unrelated container ACEs stay intact.
#[derive(Serialize, Deserialize)]
struct RecoveryRecord {
    name: String,
    granted: Vec<String>,
    protected: Vec<ProtectedPath>,
    // Deterministic private staging root; exact-target drive removal never touches another run's mapping.
    #[serde(default)]
    staged: Option<String>,
    // Writable runtime files and npm cache belong to this command, never the host temp/cache.
    #[serde(default)]
    temporary: Option<String>,
    // Exact letter and target, flushed before creation. Projects may be shared by multiple live runs.
    #[serde(default)]
    project_drive: Option<DriveMapping>,
    // The shared toolchain cache, mapped for this run alone; removed by exact letter like the project drive.
    #[serde(default)]
    toolchain_drive: Option<DriveMapping>,
    // Cache entries this run may use. Stale-entry removal skips any entry a live or abandoned record names.
    #[serde(default)]
    cached: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProtectedPath {
    path: String,
    dacl: String,
    // Whether the original DACL was protected from inheritance, so restoring sets the same flag (#195). Records
    // written before this field are of unprotected paths, the only ones snapshotted then.
    #[serde(default)]
    dacl_protected: bool,
}

impl ProtectedPath {
    fn restore(&self) -> Result<()> {
        let path = wide(&self.path);
        let dacl = wide(&self.dacl);
        unsafe {
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(dacl.as_ptr()),
                1,
                &mut descriptor,
                None,
            )
            .map_err(|e| describe("read original sandbox permissions", e))?;
            let _descriptor = LocalMem(descriptor.0);
            let mut acl = std::ptr::null_mut();
            let mut present = false.into();
            let mut defaulted = false.into();
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
                .map_err(|e| describe("GetSecurityDescriptorDacl", e))?;
            let status = SetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION
                    | if self.dacl_protected {
                        PROTECTED_DACL_SECURITY_INFORMATION
                    } else {
                        UNPROTECTED_DACL_SECURITY_INFORMATION
                    },
                None,
                None,
                Some(acl),
                None,
            );
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "cannot restore original sandbox permissions (error {})",
                    status.0
                ));
            }
        }
        Ok(())
    }
}

const TOOLCHAIN_ENTRIES: usize = 5000;
const TOOLCHAIN_BYTES: u64 = 256 * 1024 * 1024;
const INSPECTION_ENTRIES: usize = 100_000;

fn staging_path(name: &str) -> Result<PathBuf> {
    Ok(recovery_dir()?
        .parent()
        .ok_or("missing recovery parent")?
        .join("sandbox-toolchains")
        .join(name))
}

// Finished read-only toolchain copies, kept across commands (#108). Entries are named by toolchain_key and are only
// ever created by an atomic rename of a complete private copy, so an entry that exists is complete.
fn cache_root() -> Result<PathBuf> {
    Ok(recovery_dir()?
        .parent()
        .ok_or("missing recovery parent")?
        .join("sandbox-toolchains")
        .join("cache"))
}

// FNV-1a: stable across Rust releases, unlike DefaultHasher. Cache names need stability, not secrecy.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ byte as u64).wrapping_mul(0x0100_0000_01b3)
    })
}

// `<source>-<contents>`: one prefix per install folder, and a new name whenever any entry's name, size or write
// time changes (an upgrade), so a changed install is copied again instead of reusing old bytes.
fn toolchain_key(source: &str, mut entries: Vec<String>) -> String {
    entries.sort();
    format!(
        "{:016x}-{:016x}",
        fnv1a(&source.to_lowercase()),
        fnv1a(&entries.join("\n"))
    )
}

// The cache root is mapped as a drive root, so packages need to read it; it is never writable for them.
// Called under PermissionLock. The grant is made once, not per run.
fn prepare_cache_root(package: PSID) -> Result<()> {
    let cache = cache_root()?;
    fs::create_dir_all(&cache).map_err(|e| format!("cannot create toolchain cache: {e}"))?;
    if !package_access(&cache, package)?.0 {
        edit_acl(
            cache.to_str().ok_or("non-Unicode toolchain cache path")?,
            package,
            FILE_READ_EXECUTE,
            Change::Grant,
        )?;
    }
    Ok(())
}

fn cache_entry_ready(entry: &Path) -> bool {
    fs::symlink_metadata(entry).is_ok_and(|meta| {
        meta.is_dir() && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0
    })
}

// A copy unused this long belongs to an install that moved or was removed; it is deleted the next time the cache grows.
const CACHE_UNUSED_DAYS: u64 = 30;

// Each use stamps the entry's write time, which is what expiry compares. Best effort.
fn set_cache_entry_time(entry: &Path, time: SystemTime) -> std::io::Result<()> {
    OpenOptions::new()
        .access_mode(FILE_WRITE_ATTRIBUTES.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(entry)?
        .set_modified(time)
}

// Runs when a new copy is cached, the only time the cache grows. Older copies of the same install go, and so does any
// copy unused for CACHE_UNUSED_DAYS, unless a recovery record (a live run, or an abandoned one not yet recovered)
// still names it. Called under PermissionLock. Best effort: what cannot be removed now is retried next time.
fn remove_stale_cache_entries(cache: &Path, key: &str, in_use: &[String], now: SystemTime) {
    let Some((source, _)) = key.split_once('-') else {
        return;
    };
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let expiry = Duration::from_secs(CACHE_UNUSED_DAYS * 24 * 60 * 60);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let superseded = name
            .split_once('-')
            .is_some_and(|(prefix, _)| prefix == source);
        let expired = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|used| now.duration_since(used).is_ok_and(|age| age > expiry));
        if name != key
            && (superseded || expired)
            && !in_use.contains(&name)
            && cache_entry_ready(&entry.path())
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

// A SID copied out of a Windows allocation, so it can be kept and freed like any value.
struct OwnedSid(Vec<u32>);

impl OwnedSid {
    fn psid(&self) -> PSID {
        PSID(self.0.as_ptr() as *mut c_void)
    }
}

// One project's write grant goes to a capability derived from its path, not to each run's own AppContainer SID, so
// it is propagated through the project once instead of on every command (#103). Every sandboxed command for the
// project carries the capability; commands for other projects carry their own. Windows derives the SID from the name
// with SHA-256, so no folder name can be chosen to collide with another project's capability.
fn project_capability(cwd: &str) -> Result<OwnedSid> {
    let name = wide(&format!("patch.project.{}", cwd.to_lowercase()));
    let (mut groups, mut group_count) = (std::ptr::null_mut::<PSID>(), 0u32);
    let (mut sids, mut sid_count) = (std::ptr::null_mut::<PSID>(), 0u32);
    unsafe {
        DeriveCapabilitySidsFromName(
            PCWSTR(name.as_ptr()),
            &mut groups,
            &mut group_count,
            &mut sids,
            &mut sid_count,
        )
    }
    .map_err(|e| describe("derive the project capability", e))?;
    let copied = if sid_count == 0 {
        Err("no project capability was derived".to_string())
    } else {
        unsafe {
            let sid = *sids;
            let length = GetLengthSid(sid);
            let mut buffer = vec![0u32; (length as usize).div_ceil(4)];
            CopySid(length, PSID(buffer.as_mut_ptr() as *mut c_void), sid)
                .map(|_| OwnedSid(buffer))
                .map_err(|e| describe("copy the project capability", e))
        }
    };
    for (array, count) in [(groups, group_count), (sids, sid_count)] {
        if array.is_null() {
            continue;
        }
        unsafe {
            for index in 0..count as usize {
                LocalFree(Some(HLOCAL((*array.add(index)).0)));
            }
            LocalFree(Some(HLOCAL(array as *mut c_void)));
        }
    }
    copied
}

// Whether the DACL has an ordinary allow entry (inherited or explicit) for this SID.
unsafe fn acl_allows(dacl: *const ACL, sid: PSID) -> Result<bool> {
    if dacl.is_null() {
        return Ok(false);
    }
    for index in 0..(*dacl).AceCount as u32 {
        let mut ace = std::ptr::null_mut();
        GetAce(dacl, index, &mut ace).map_err(|e| describe("GetAce", e))?;
        // Our grants use ordinary ACCESS_ALLOWED_ACE (type 0), never object/callback ACEs.
        let allowed = ace as *const ACCESS_ALLOWED_ACE;
        if (*allowed).Header.AceType == 0
            && EqualSid(
                PSID(std::ptr::addr_of!((*allowed).SidStart) as *mut c_void),
                sid,
            )
            .is_ok()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn path_allows(path: &str, sid: PSID) -> Result<bool> {
    let wpath = wide(path);
    unsafe {
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetNamedSecurityInfoW(
            PCWSTR(wpath.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
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
        acl_allows(dacl, sid)
    }
}

// A copy of the DACL without allow or deny entries for this SID, inherited ones included.
unsafe fn acl_without(dacl: *const ACL, sid: PSID) -> Result<Vec<u32>> {
    let mut info = ACL_SIZE_INFORMATION::default();
    GetAclInformation(
        dacl,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
        AclSizeInformation,
    )
    .map_err(|e| describe("GetAclInformation", e))?;
    // Removing entries only shrinks the list, so the original size is enough. ACLs need 4-byte alignment.
    let mut buffer = vec![0u32; (info.AclBytesInUse as usize).div_ceil(4)];
    let acl = buffer.as_mut_ptr() as *mut ACL;
    let revision = ACE_REVISION((*dacl).AclRevision as u32);
    InitializeAcl(acl, (buffer.len() * 4) as u32, revision)
        .map_err(|e| describe("InitializeAcl", e))?;
    for index in 0..(*dacl).AceCount as u32 {
        let mut ace = std::ptr::null_mut();
        GetAce(dacl, index, &mut ace).map_err(|e| describe("GetAce", e))?;
        let header = ace as *const ACE_HEADER;
        // Allow (0) and deny (1) entries share the layout with the SID at SidStart.
        if matches!((*header).AceType, 0 | 1)
            && EqualSid(
                PSID(
                    std::ptr::addr_of!((*(ace as *const ACCESS_ALLOWED_ACE)).SidStart)
                        as *mut c_void,
                ),
                sid,
            )
            .is_ok()
        {
            continue;
        }
        AddAce(acl, revision, u32::MAX, ace, (*header).AceSize as u32)
            .map_err(|e| describe("AddAce", e))?;
    }
    Ok(buffer)
}

#[derive(Serialize, Deserialize)]
struct ProjectGrant {
    path: String,
    complete: bool,
}

fn project_grant_marker(cwd: &str) -> Result<PathBuf> {
    Ok(recovery_dir()?
        .parent()
        .ok_or("missing recovery parent")?
        .join("sandbox-projects")
        .join(format!("{:016x}.json", fnv1a(&cwd.to_lowercase()))))
}

fn write_project_grant(marker: &Path, cwd: &str, complete: bool) -> Result<()> {
    let mut file = File::create(marker).map_err(|e| format!("cannot record project grant: {e}"))?;
    serde_json::to_writer(
        &mut file,
        &ProjectGrant {
            path: cwd.to_string(),
            complete,
        },
    )
    .map_err(|e| format!("cannot record project grant: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("cannot flush project grant: {e}"))
}

// Grants the project capability write access through the project once. The marker is flushed as incomplete before
// propagation starts and as complete after it ends, so a helper killed half-way leaves a marker the next run sees as
// unfinished and repeats (granting twice is harmless). Called under PermissionLock.
fn ensure_project_grant(cwd: &str, capability: PSID) -> Result<()> {
    let marker = project_grant_marker(cwd)?;
    let recorded = fs::read(&marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ProjectGrant>(&bytes).ok())
        // Compared with the same Unicode lowercasing that names the capability, so a non-ASCII path in another case is
        // not granted again on every run (#195).
        .is_some_and(|grant| grant.complete && grant.path.to_lowercase() == cwd.to_lowercase());
    // The root check notices permissions reset by the user since the grant.
    if recorded && path_allows(cwd, capability)? {
        return Ok(());
    }
    fs::create_dir_all(marker.parent().ok_or("missing project grant folder")?)
        .map_err(|e| format!("cannot create project grant folder: {e}"))?;
    write_project_grant(&marker, cwd, false)?;
    edit_acl(cwd, capability, FILE_MODIFY, Change::Grant)?;
    write_project_grant(&marker, cwd, true)
}

// Removes the project's lasting grant when the user closes or removes the project in Patch. Startup recovery has
// already ended abandoned runs, so a remaining record is a live command: the grant is kept for it and the next
// close retries. Revoking an ungranted project changes nothing.
fn revoke_project(cwd: &str) -> Result<()> {
    let _lock = PermissionLock::acquire()?;
    let live = recovery_records()?.iter().any(|record| {
        record
            .project_drive
            .as_ref()
            .is_some_and(|drive| drive.target.eq_ignore_ascii_case(cwd))
    });
    if live {
        return Err("sandboxed commands still run in this project; its grant is kept".into());
    }
    if Path::new(cwd).is_dir() {
        edit_acl(cwd, project_capability(cwd)?.psid(), 0, Change::Revoke)?;
    }
    match fs::remove_file(project_grant_marker(cwd)?) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("cannot remove project grant record: {error}"))
        }
        _ => Ok(()),
    }
}

fn temporary_path(name: &str) -> Result<PathBuf> {
    Ok(recovery_dir()?
        .parent()
        .ok_or("missing recovery parent")?
        .join("sandbox-temp")
        .join(name))
}

// Compute effective package rights, not just the presence of a package ACE. Generic and inherit-only ACEs matter.
fn package_access(path: &Path, package: PSID) -> Result<(bool, bool)> {
    let text = wide(path.to_str().ok_or("non-Unicode toolchain path")?);
    unsafe {
        let mut acl = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetNamedSecurityInfoW(
            PCWSTR(text.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut acl),
            None,
            &mut descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot inspect toolchain permissions (error {})",
                status.0
            ));
        }
        let _descriptor = LocalMem(descriptor.0);
        let mut control = SECURITY_DESCRIPTOR_CONTROL::default();
        let mut revision = 0;
        GetSecurityDescriptorControl(descriptor, &mut control.0, &mut revision)
            .map_err(|e| describe("inspect toolchain inheritance", e))?;
        let protected = control.contains(SE_DACL_PROTECTED);
        if acl.is_null() {
            return Ok((true, protected));
        }
        let trustee = TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: PWSTR(package.0 as *mut u16),
            ..Default::default()
        };
        let mut rights = 0;
        let status = GetEffectiveRightsFromAclW(acl, &trustee, &mut rights);
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot evaluate package permissions (error {})",
                status.0
            ));
        }
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ.0,
            GenericWrite: FILE_GENERIC_WRITE.0,
            GenericExecute: FILE_GENERIC_EXECUTE.0,
            GenericAll: FILE_ALL_ACCESS.0,
        };
        MapGenericMask(&mut rights, &mapping);
        Ok((rights & FILE_READ_EXECUTE == FILE_READ_EXECUTE, protected))
    }
}

#[cfg(test)]
fn package_readable(path: &Path, package: PSID) -> Result<bool> {
    package_access(path, package).map(|(readable, _)| readable)
}

// Whether the folder and every entry directly inside it are package-readable.
fn directly_readable(root: &Path, package: PSID, check: &impl Fn() -> Result<()>) -> Result<bool> {
    if !package_access(root, package)?.0 {
        return Ok(false);
    }
    for (count, entry) in fs::read_dir(root)
        .map_err(|e| format!("cannot list toolchain: {e}"))?
        .enumerate()
    {
        check()?;
        if count >= INSPECTION_ENTRIES {
            return Err("toolchain inspection exceeds its entry limit".to_string());
        }
        let path = entry
            .map_err(|e| format!("cannot list toolchain entry: {e}"))?
            .path();
        if !package_access(&path, package)?.0 {
            return Ok(false);
        }
    }
    Ok(true)
}

struct ToolchainPlan {
    source: String,
    files: Vec<PathBuf>,
    stage: bool,
    // Name of this exact install's cached copy under cache_root.
    key: String,
}

// Inspection is bounded separately from copying: large already-readable installs (e.g. Python) need no grant.
fn inspect_toolchain(
    source: &str,
    package: PSID,
    check: impl Fn() -> Result<()>,
) -> Result<Option<ToolchainPlan>> {
    let root = Path::new(source);
    // PATH finds commands directly in this folder. When the folder and its direct entries are already readable, no
    // grant is needed, and a large install (Python, .NET) is not walked on every command. Granting nothing cannot
    // widen access, so this fast path needs none of the link checks below.
    if directly_readable(root, package, &check)? {
        return Ok(None);
    }
    let canonical = fs::canonicalize(root).map_err(|e| format!("cannot resolve toolchain: {e}"))?;
    // Canonical spelling can differ because CI uses an 8.3 TEMP alias; that is not a link. Inspect actual
    // ancestor attributes instead of treating every canonical-name difference as a reparse point.
    for ancestor in root.ancestors() {
        let meta = fs::symlink_metadata(ancestor)
            .map_err(|e| format!("cannot inspect toolchain ancestor: {e}"))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err("toolchain resolves through an ancestor reparse point".to_string());
        }
    }
    // First pass, cheap: names, sizes, write times and reparse flags come from the directory listing itself, with no
    // per-entry security query. That is enough to name the install's cached copy (#108).
    let started = Instant::now();
    let mut pending = vec![root.to_path_buf()];
    let root_meta =
        fs::symlink_metadata(root).map_err(|e| format!("cannot inspect toolchain: {e}"))?;
    let mut files = vec![root.to_path_buf()];
    let mut fingerprint = vec![format!("|true|0|{}", root_meta.last_write_time())];
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        check()?;
        if started.elapsed() > Duration::from_secs(15) {
            return Err("toolchain inspection exceeds its time limit".to_string());
        }
        for entry in fs::read_dir(&directory).map_err(|e| format!("cannot list toolchain: {e}"))? {
            if files.len() >= INSPECTION_ENTRIES {
                return Err("toolchain inspection exceeds its entry limit".to_string());
            }
            let entry = entry.map_err(|e| format!("cannot list toolchain entry: {e}"))?;
            let path = entry.path();
            let meta = entry
                .metadata()
                .map_err(|e| format!("cannot inspect toolchain: {e}"))?;
            if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
                return Err("toolchain contains a reparse point or escaping path".to_string());
            }
            if meta.is_dir() {
                pending.push(path.clone());
            } else {
                bytes = bytes
                    .checked_add(meta.len())
                    .ok_or("toolchain size overflow")?;
            }
            fingerprint.push(format!(
                "{}|{}|{}|{}",
                path.strip_prefix(root)
                    .map_err(|_| "toolchain path escaped")?
                    .to_string_lossy()
                    .to_lowercase(),
                meta.is_dir(),
                meta.len(),
                meta.last_write_time()
            ));
            files.push(path);
        }
    }
    let key = toolchain_key(source, fingerprint);
    // A finished copy of exactly these contents exists: the command uses it and never reads the source, so the
    // per-entry checks below would protect nothing. Were the copy removed before use, copy_toolchain validates
    // every opened entry itself.
    if cache_entry_ready(&cache_root()?.join(&key)) {
        return Ok(Some(ToolchainPlan {
            key,
            source: source.to_string(),
            files,
            stage: true,
        }));
    }
    // Second pass, only without a cached copy: links and effective package rights on every entry.
    let mut readable = true;
    let mut protected = false;
    for path in &files {
        check()?;
        if started.elapsed() > Duration::from_secs(15) {
            return Err("toolchain inspection exceeds its time limit".to_string());
        }
        let meta =
            fs::symlink_metadata(path).map_err(|e| format!("cannot inspect toolchain: {e}"))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
            || !fs::canonicalize(path)
                .map_err(|e| format!("cannot resolve toolchain entry: {e}"))?
                .starts_with(&canonical)
        {
            return Err("toolchain contains a reparse point or escaping path".to_string());
        }
        let (package_readable, acl_protected) = package_access(path, package)?;
        readable &= package_readable;
        // Protected descendants do not inherit a grant placed on their install directory.
        protected |= acl_protected;
    }
    if readable {
        return Ok(None);
    }
    if files.len().saturating_sub(1) > TOOLCHAIN_ENTRIES || bytes > TOOLCHAIN_BYTES {
        return Err("inaccessible toolchain exceeds the 5000-entry/256 MiB limit".to_string());
    }
    let text = wide(source);
    let writable = unsafe {
        CreateFileW(
            PCWSTR(text.as_ptr()),
            WRITE_DAC.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    }
    .map(Handle)
    .is_ok();
    Ok(Some(ToolchainPlan {
        key,
        source: source.to_string(),
        files,
        stage: !writable || protected,
    }))
}

fn recovery_dir() -> Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is missing")?;
    Ok(PathBuf::from(local).join("Patch").join("sandbox-recovery"))
}

// Serialize only ACL setup/cleanup, never command execution. Every overlapping run carries the original
// inheritance snapshot; the last remaining record restores it, including after forced termination.
struct PermissionLock(Handle);

// How long a run waits for the lock before it says why it is waiting.
const LOCK_NOTICE_AFTER: Duration = Duration::from_secs(5);

impl PermissionLock {
    fn acquire() -> Result<Self> {
        Self::acquire_while(|| Ok(()), || {})
    }

    // Waits as long as the holder lives, with no fixed limit: a project's first grant walks every file in it and can
    // take minutes in a large project (#176). A holder that dies abandons the mutex, which Windows hands to the next
    // waiter, so a crashed helper never blocks the others. `check` ends the wait (a stopped command), and `slow` is
    // called once when the wait passes LOCK_NOTICE_AFTER.
    fn acquire_while(check: impl Fn() -> Result<()>, slow: impl FnOnce()) -> Result<Self> {
        let handle = Handle(
            unsafe {
                CreateMutexW(
                    None,
                    false,
                    windows::core::w!("Local\\PatchSandboxPermissions"),
                )
            }
            .map_err(|e| describe("create sandbox permission lock", e))?,
        );
        let started = Instant::now();
        let mut slow = Some(slow);
        loop {
            match unsafe { WaitForSingleObject(handle.0, 250) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => return Ok(Self(handle)),
                WAIT_TIMEOUT => {
                    check()?;
                    if started.elapsed() >= LOCK_NOTICE_AFTER {
                        if let Some(slow) = slow.take() {
                            slow();
                        }
                    }
                }
                _ => {
                    return Err(describe(
                        "wait for the sandbox permission lock",
                        Error::from_thread(),
                    ))
                }
            }
        }
    }
}

impl Drop for PermissionLock {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0 .0);
        }
    }
}

fn recovery_records() -> Result<Vec<RecoveryRecord>> {
    records_in(&recovery_dir()?)
}

fn records_in(dir: &Path) -> Result<Vec<RecoveryRecord>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in
        fs::read_dir(dir).map_err(|e| format!("cannot read sandbox recovery folder: {e}"))?
    {
        let path = entry
            .map_err(|e| format!("cannot read recovery entry: {e}"))?
            .path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let bytes = fs::read(&path)
                .map_err(|e| format!("cannot read sandbox protection owner: {e}"))?;
            // A live run publishes its record complete (written as .pending, then renamed), so one that can't be
            // parsed belongs to no running command. Startup recovery quarantines it; until then it is ignored.
            if let Ok(record) = serde_json::from_slice(&bytes) {
                records.push(record);
            }
        }
    }
    Ok(records)
}

fn lock_record(path: &Path, create: bool) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
        .open(path)
}

fn record_sid(name: &str) -> Result<Sid> {
    let name = wide(name);
    unsafe { DeriveAppContainerSidFromAppContainerName(PCWSTR(name.as_ptr())) }
        .map(Sid)
        .map_err(|e| describe("DeriveAppContainerSidFromAppContainerName", e))
}

impl RecoveryRecord {
    fn undo(&self, sid: PSID) -> Result<()> {
        let others = recovery_records()?;
        // Try every path even if one is unavailable. Keep the record for a later retry on any error.
        let mut result = Ok(());
        for path in self.granted.iter().rev() {
            if Path::new(path).exists() {
                if let Err(error) = edit_acl(path, sid, 0, Change::Revoke) {
                    result = Err(error);
                }
            }
        }
        for path in self.protected.iter().rev() {
            let shared = others.iter().any(|record| {
                record.name != self.name
                    && record
                        .protected
                        .iter()
                        .any(|other| other.path.eq_ignore_ascii_case(&path.path))
            });
            if !shared && Path::new(&path.path).exists() {
                if let Err(error) = path.restore() {
                    result = Err(error);
                }
            }
        }
        for mapping in [&self.project_drive, &self.toolchain_drive]
            .into_iter()
            .flatten()
        {
            if let Err(error) = mapping.remove() {
                result = Err(error);
            }
        }
        for (directory, expected, kind) in [
            (&self.staged, staging_path(&self.name)?, "staging"),
            (&self.temporary, temporary_path(&self.name)?, "temporary"),
        ] {
            let Some(directory) = directory else { continue };
            if Path::new(directory) != expected {
                return Err(format!("invalid sandbox {kind} path"));
            }
            for letter in DRIVE_LETTERS {
                let name = wide(&format!("{}:", letter as char));
                let target = wide(&format!(r"\??\{directory}"));
                unsafe {
                    // EXACT_MATCH prevents removing a drive now owned by another run.
                    let _ = DefineDosDeviceW(
                        DDD_REMOVE_DEFINITION
                            | DDD_EXACT_MATCH_ON_REMOVE
                            | DDD_RAW_TARGET_PATH
                            | DDD_NO_BROADCAST_SYSTEM,
                        PCWSTR(name.as_ptr()),
                        PCWSTR(target.as_ptr()),
                    );
                }
            }
            if expected.exists() {
                if let Err(error) = fs::remove_dir_all(&expected) {
                    result = Err(format!("cannot remove sandbox {kind} files: {error}"));
                }
            }
        }
        result?;
        let name = wide(&self.name);
        unsafe { DeleteAppContainerProfile(PCWSTR(name.as_ptr())) }
            .or_else(|error| {
                if error.code() == windows::core::HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|e| describe("DeleteAppContainerProfile", e))
    }
}

// Starts a record survives before it is set aside in quarantine\ and stops being retried.
const RECOVERY_ATTEMPTS: u32 = 5;

// Reports a recovery outcome to Patch's log: a code, the record's name and its failure count.
type RecoveryLog<'a> = &'a dyn Fn(&str, &str, u32);

fn recover_abandoned_runs(log: RecoveryLog) -> Result<()> {
    let _lock = PermissionLock::acquire()?;
    recover_records(
        &recovery_dir()?,
        |record| record.undo(record_sid(&record.name)?.0),
        log,
    )
}

// A record that can't be undone must not stop the helper, or one bad record disables the sandbox until it is deleted
// by hand: it is skipped, retried on later starts and quarantined after RECOVERY_ATTEMPTS failures. A record that
// can't be parsed or names an invalid profile can never be undone, so it is quarantined at once.
fn recover_records(
    dir: &Path,
    undo: impl Fn(&RecoveryRecord) -> Result<()>,
    log: RecoveryLog,
) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| format!("cannot create sandbox recovery folder: {e}"))?;
    for entry in
        fs::read_dir(dir).map_err(|e| format!("cannot read sandbox recovery folder: {e}"))?
    {
        let path = entry
            .map_err(|e| format!("cannot read sandbox recovery record: {e}"))?
            .path();
        let extension = path.extension().and_then(|s| s.to_str());
        if !matches!(extension, Some("json" | "pending")) {
            continue;
        }
        let mut file = match lock_record(&path, false) {
            Ok(file) => file,
            Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION.0 as i32) => {
                continue
            }
            // Another helper may have finished recovery while we were opening it.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot lock sandbox recovery record: {error}")),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| format!("cannot read sandbox recovery record: {e}"))?;
        // Pending writes cannot have changed permissions. A published record must remain intact.
        if extension == Some("json") {
            let stem = path.file_stem().and_then(|s| s.to_str());
            let record = serde_json::from_slice::<RecoveryRecord>(&bytes)
                .ok()
                .filter(|record| {
                    record.name.starts_with("patch.sbx.") && stem == Some(record.name.as_str())
                });
            let Some(record) = record else {
                drop(file);
                quarantine_record(dir, &path, "record-unreadable", 0, log);
                continue;
            };
            if undo(&record).is_err() {
                drop(file);
                note_failed_recovery(dir, &path, &record.name, log);
                continue;
            }
            let _ = fs::remove_file(failures_path(dir, &record.name));
        }
        fs::remove_file(&path)
            .map_err(|e| format!("cannot remove sandbox recovery record: {e}"))?;
    }
    Ok(())
}

fn failures_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.failures"))
}

// Best effort: the record stays where it is when the count or the move fails, and is simply retried next time.
fn note_failed_recovery(dir: &Path, record: &Path, name: &str, log: RecoveryLog) {
    let counter = failures_path(dir, name);
    let failures = fs::read_to_string(&counter)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .unwrap_or(0)
        + 1;
    if failures < RECOVERY_ATTEMPTS {
        log("recovery-failed", name, failures);
        let _ = fs::write(&counter, failures.to_string());
    } else if quarantine_record(dir, record, "recovery-quarantined", failures, log) {
        let _ = fs::remove_file(counter);
    }
}

// Moves a record into quarantine\, where recovery no longer reads it and the user can still inspect it.
fn quarantine_record(
    dir: &Path,
    record: &Path,
    code: &str,
    failures: u32,
    log: RecoveryLog,
) -> bool {
    let name = record
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let quarantine = dir.join("quarantine");
    let moved = fs::create_dir_all(&quarantine)
        .and_then(|()| fs::rename(record, quarantine.join(name)))
        .is_ok();
    let record_name = name.strip_suffix(".json").unwrap_or(name);
    log(
        if moved { code } else { "quarantine-failed" },
        record_name,
        failures,
    );
    moved
}

fn original_inheritance(path: &str) -> Result<Option<ProtectedPath>> {
    let wpath = wide(path);
    unsafe {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetNamedSecurityInfoW(
            PCWSTR(wpath.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            &mut descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot read sandbox permission inheritance (error {})",
                status.0
            ));
        }
        let _descriptor = LocalMem(descriptor.0);
        let mut control = SECURITY_DESCRIPTOR_CONTROL::default();
        let mut revision = 0;
        GetSecurityDescriptorControl(descriptor, &mut control.0, &mut revision)
            .map_err(|e| describe("GetSecurityDescriptorControl", e))?;
        if control.contains(SE_DACL_PROTECTED) {
            return Ok(None);
        }
        let mut sddl = PWSTR::null();
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            1,
            DACL_SECURITY_INFORMATION,
            &mut sddl,
            None,
        )
        .map_err(|e| describe("save original sandbox permissions", e))?;
        let _sddl = LocalMem(sddl.0 as *mut c_void);
        Ok(Some(ProtectedPath {
            path: path.to_string(),
            dacl_protected: control.contains(SE_DACL_PROTECTED),
            dacl: sddl
                .to_string()
                .map_err(|e| describe("decode original sandbox permissions", e.into()))?,
        }))
    }
}

// Normal exits undo immediately. Forced termination releases the lock for the next helper to recover.
struct Cleanup {
    record: RecoveryRecord,
    sid: Sid,
    path: PathBuf,
    _file: File,
    finished: bool,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(_lock) = PermissionLock::acquire() {
            if self.record.undo(self.sid.0).is_ok() {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

// Copies file bytes, never source ACLs or links. Hold a no-write/no-delete handle while validating and reading.
fn copy_toolchain(
    plan: &ToolchainPlan,
    target: &Path,
    started: Instant,
    copied: &mut u64,
    check: impl Fn() -> Result<()>,
) -> Result<()> {
    fs::create_dir(target).map_err(|e| format!("cannot create staged toolchain: {e}"))?;
    let canonical =
        fs::canonicalize(&plan.source).map_err(|e| format!("cannot resolve toolchain: {e}"))?;
    // Retain directory handles without delete sharing so a parent cannot be swapped mid-copy.
    let mut directories = Vec::new();
    for path in &plan.files {
        check()?;
        if started.elapsed() > Duration::from_secs(30) {
            return Err("toolchain copy exceeds 30 seconds".to_string());
        }
        let relative = path
            .strip_prefix(&plan.source)
            .map_err(|_| "toolchain path escaped")?;
        let destination = target.join(relative);
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
            .map_err(|e| format!("cannot open toolchain entry: {e}"))?;
        let meta = file
            .metadata()
            .map_err(|e| format!("cannot inspect opened toolchain entry: {e}"))?;
        let mut final_path = vec![0u16; 32768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                HANDLE(file.as_raw_handle()),
                &mut final_path,
                FILE_NAME_NORMALIZED,
            )
        } as usize;
        if length == 0 || length >= final_path.len() {
            return Err("cannot resolve opened toolchain handle".to_string());
        }
        let opened = PathBuf::from(
            String::from_utf16(&final_path[..length])
                .map_err(|_| "non-Unicode opened toolchain path")?,
        );
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
            || !opened.starts_with(&canonical)
        {
            return Err("toolchain changed to a reparse point or escaping path".to_string());
        }
        if meta.is_dir() {
            if !relative.as_os_str().is_empty() {
                fs::create_dir_all(&destination)
                    .map_err(|e| format!("cannot create staged subdirectory: {e}"))?;
            }
            directories.push(file);
        } else {
            *copied = copied
                .checked_add(meta.len())
                .ok_or("toolchain copy size overflow")?;
            if *copied > TOOLCHAIN_BYTES {
                return Err("toolchain copies exceed 256 MiB".to_string());
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create staged parent: {e}"))?;
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|e| format!("cannot create staged file: {e}"))?;
            let count = std::io::copy(&mut file.take(meta.len() + 1), &mut output)
                .map_err(|e| format!("cannot copy toolchain: {e}"))?;
            if count != meta.len() {
                return Err("toolchain file changed during copy".to_string());
            }
        }
    }
    Ok(())
}

// Expands 8.3 aliases (C:\Users\RUNNER~1) of an existing path. Others, and failures, keep their spelling.
fn long_path(path: &str) -> String {
    let short = wide(path);
    let size = unsafe { GetLongPathNameW(PCWSTR(short.as_ptr()), None) };
    if size == 0 {
        return path.to_string();
    }
    let mut long = vec![0u16; size as usize];
    let written = unsafe { GetLongPathNameW(PCWSTR(short.as_ptr()), Some(&mut long)) };
    if written == 0 || written >= size {
        return path.to_string();
    }
    String::from_utf16_lossy(&long[..written as usize])
}

// Mapped sources come from realpath (long names); PATH entries and commands may use 8.3 aliases of them.
fn mapped_path(path: &str, mappings: &[(String, String)]) -> String {
    let full = long_path(path).replace('/', "\\");
    let lower = full.to_ascii_lowercase();
    for (source, target) in mappings {
        let source = long_path(source)
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_ascii_lowercase();
        if lower == source {
            return target.clone();
        }
        if lower.starts_with(&format!("{source}\\")) {
            return format!("{}{}", target.trim_end_matches('\\'), &full[source.len()..]);
        }
    }
    path.to_string()
}

fn path_within(path: &Path, boundary: &Path) -> bool {
    let path = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let boundary = boundary
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    path == boundary || path.starts_with(&format!("{boundary}\\"))
}

// This is deliberately independent of the Electron caller. It runs before locks, recovery, staging, or ACL work.
fn validate_project_root(cwd: &str, workspace: bool) -> Result<PathBuf> {
    let project =
        fs::canonicalize(cwd).map_err(|e| format!("cannot resolve sandbox project root: {e}"))?;
    if project.parent().is_none() {
        return Err("sandbox refused a volume root; choose a narrower project root or run with explicitly approved unsandboxed access".into());
    }
    let home = std::env::var_os("USERPROFILE")
        .ok_or_else(|| "USERPROFILE is missing".to_string())
        .and_then(|path| {
            fs::canonicalize(path).map_err(|e| format!("cannot resolve USERPROFILE: {e}"))
        })?;
    if path_within(&home, &project) {
        return Err("sandbox refused a project root containing the user profile; choose a narrower project root or run with explicitly approved unsandboxed access".into());
    }
    let mut sensitive = Vec::new();
    for name in ["APPDATA", "LOCALAPPDATA"] {
        let path = std::env::var_os(name).ok_or_else(|| format!("{name} is missing"))?;
        sensitive.push(fs::canonicalize(path).map_err(|e| format!("cannot resolve {name}: {e}"))?);
    }
    if let Some(path) = std::env::var_os("PATCH_USER_DATA").filter(|path| !path.is_empty()) {
        sensitive.push(
            fs::canonicalize(path).map_err(|e| format!("cannot resolve PATCH_USER_DATA: {e}"))?,
        );
    }
    let executable =
        std::env::current_exe().map_err(|e| format!("cannot resolve helper install path: {e}"))?;
    let install = executable
        .parent()
        .ok_or("helper install path has no parent")?;
    // Cargo's development helper lives inside the repository; it is not an installed application boundary.
    let cargo_build = install
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name.eq_ignore_ascii_case("target"));
    if !cargo_build {
        sensitive.push(install.parent().unwrap_or(install).to_path_buf());
    }
    let nested = sensitive
        .iter()
        .any(|boundary| path_within(&project, boundary) && !path_within(boundary, &project));
    let overlaps = sensitive
        .iter()
        .any(|boundary| path_within(&project, boundary) || path_within(boundary, &project));
    // A sandboxed MCP server's folder lives under userData (#87). That is a nested application-data path, never
    // the profile or the application-data root itself.
    if overlaps && !(workspace && nested) {
        return Err("sandbox refused a project root overlapping application data or installation files; choose a narrower project root or run with explicitly approved unsandboxed access".into());
    }
    Ok(project)
}

// Where net-bridge.exe ships: next to the helper.
fn bridge_source() -> Result<PathBuf> {
    let executable =
        std::env::current_exe().map_err(|e| format!("cannot resolve helper install path: {e}"))?;
    let bridge = executable
        .parent()
        .ok_or("helper install path has no parent")?
        .join("net-bridge.exe");
    if bridge.is_file() {
        Ok(bridge)
    } else {
        Err("the network bridge (net-bridge.exe) is missing next to the sandbox helper".into())
    }
}

fn run(request: &Request, emitter: &Emitter, jobs: &Jobs) -> Result<()> {
    run_inner(request, Some(emitter), jobs).map(|_| ())
}

fn run_inner(request: &Request, emitter: Option<&Emitter>, jobs: &Jobs) -> Result<i32> {
    let stdio = emitter.is_none();
    let _project = validate_project_root(&request.cwd, request.workspace)?;
    let bridge = match &request.proxy {
        Some(_) if request.network => {
            return Err(
                "a command gets either network access or the filtering proxy, not both".into(),
            )
        }
        Some(_) => Some(bridge_source()?),
        None => None,
    };
    let id = request.id;
    let mut package = PSID::default();
    unsafe { ConvertStringSidToSidW(windows::core::w!("S-1-15-2-1"), &mut package) }
        .map_err(|e| describe("create package SID", e))?;
    let _package = LocalMem(package.0);
    if request.toolchains.len() > 32 {
        return Err("too many Program Files toolchain candidates (maximum 32)".to_string());
    }
    // Toolchains are optional: one that cannot be inspected, granted or copied stays unreadable, as it was before
    // toolchain support, and the command still runs. Skipping one never widens access; the command's output says
    // which folders were left out and why. Inspection only reads, so it runs before the permission lock.
    let mut warnings = Vec::new();
    let mut toolchains = Vec::new();
    let mut entries = 0usize;
    let preparation = Instant::now();
    for source in &request.toolchains {
        let inspected = inspect_toolchain(source, package, || {
            ensure_active(jobs, id)?;
            if preparation.elapsed() > Duration::from_secs(30) {
                return Err("toolchain preparation exceeds 30 seconds".to_string());
            }
            Ok(())
        });
        match inspected {
            Ok(Some(plan)) => {
                let count = plan.files.len().saturating_sub(1);
                if entries + count > TOOLCHAIN_ENTRIES {
                    warnings.push(format!(
                        "{source}: inaccessible toolchains exceed 5000 entries per command"
                    ));
                    continue;
                }
                entries += count;
                toolchains.push(plan);
            }
            Ok(None) => {}
            Err(message) => {
                ensure_active(jobs, id)?;
                warnings.push(format!("{source}: {message}"));
            }
        }
    }
    let profile = profile_name();
    let staged = if toolchains.is_empty() {
        None
    } else {
        Some(
            staging_path(&profile)?
                .to_str()
                .ok_or("non-Unicode staging path")?
                .to_string(),
        )
    };
    let permission_lock = PermissionLock::acquire_while(
        || ensure_active(jobs, id),
        || {
            if let Some(emitter) = emitter {
                emitter.send(&Event::Stderr {
                    id,
                    data: "Patch sandbox: waiting for another sandboxed command to finish setting up permissions. A \
                           project's first command grants access to every file in it, which can take minutes in a large \
                           project.\n",
                })
            }
        },
    )?;
    let owners = recovery_records()?;
    let git = Path::new(&request.cwd).join(".git");
    let git = git.to_string_lossy().into_owned();
    let readonly_git = request
        .deny_write
        .iter()
        .any(|path| path.eq_ignore_ascii_case(&git));
    if readonly_git {
        // Validate every reservation/pointer/metadata root under the permission lock, before project grants.
        for path in &request.deny_write {
            let metadata = fs::symlink_metadata(path)
                .map_err(|e| format!("Protected Git metadata is required: {e}"))?;
            if (!metadata.is_dir() && !metadata.is_file())
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
            {
                return Err("Git metadata must be a regular directory or gitfile".into());
            }
        }
    }
    let mut record = RecoveryRecord {
        name: profile.clone(),
        // The project itself is granted to its capability, which outlives the run (#103).
        granted: request
            .read_only
            .iter()
            .chain(&request.read_write)
            .filter(|path| Path::new(path).exists() && !path.eq_ignore_ascii_case(&request.cwd))
            .cloned()
            .collect(),
        protected: request
            .deny_write
            .iter()
            .filter(|path| Path::new(path).exists())
            .map(|path| {
                let shared = owners
                    .iter()
                    .flat_map(|owner| &owner.protected)
                    .find(|other| other.path.eq_ignore_ascii_case(path))
                    .cloned();
                match shared {
                    Some(snapshot) => Ok(Some(snapshot)),
                    None => original_inheritance(path),
                }
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect(),
        staged,
        temporary: Some(
            temporary_path(&profile)?
                .to_str()
                .ok_or("non-Unicode temporary path")?
                .to_string(),
        ),
        project_drive: Some(DriveMapping::reserve(&request.cwd, &[])?),
        toolchain_drive: None,
        cached: toolchains.iter().map(|plan| plan.key.clone()).collect(),
    };
    if !toolchains.is_empty() {
        let cache = cache_root()?;
        let cache = cache.to_str().ok_or("non-Unicode toolchain cache path")?;
        let taken: Vec<&DriveMapping> = record.project_drive.iter().collect();
        record.toolchain_drive = Some(DriveMapping::reserve(cache, &taken)?);
    }
    // Journal candidate grants before attempting them. A failed grant is safe to revoke idempotently.
    for plan in &toolchains {
        if !plan.stage {
            record.granted.push(plan.source.clone());
        }
    }
    let name = wide(&record.name);
    let sid = record_sid(&record.name)?;
    let pending = recovery_dir()?.join(format!("{}.pending", record.name));
    let path = pending.with_extension("json");
    let mut file = lock_record(&pending, true)
        .map_err(|e| format!("cannot create sandbox recovery record: {e}"))?;
    serde_json::to_writer(&mut file, &record)
        .map_err(|e| format!("cannot write sandbox recovery record: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("cannot flush sandbox recovery record: {e}"))?;
    fs::rename(&pending, &path)
        .map_err(|e| format!("cannot publish sandbox recovery record: {e}"))?;
    let mut cleanup = Cleanup {
        record,
        sid,
        path,
        _file: file,
        finished: false,
    };
    // The record is durable before the DOS device exists, and selection/creation stay under the same lock.
    let project_drive = ProjectDrive::define(
        cleanup
            .record
            .project_drive
            .as_ref()
            .ok_or("missing project drive")?,
        true,
    )?;
    // Defined whenever it is journaled: a reserved but undefined letter could later hold another run's mapping of
    // the same cache, which this record's exact-match removal would then delete.
    let toolchain_drive = match &cleanup.record.toolchain_drive {
        Some(mapping) => {
            prepare_cache_root(package)?;
            Some(ProjectDrive::define(mapping, true)?)
        }
        None => None,
    };
    let sid = unsafe {
        CreateAppContainerProfile(
            PCWSTR(name.as_ptr()),
            windows::core::w!("Patch sandbox"),
            windows::core::w!("Temporary profile for one Patch command"),
            None,
        )
        .map_err(|e| describe("CreateAppContainerProfile", e))?
    };
    let _created_sid = Sid(sid);

    // Package-SID deny ACEs do not override the restricted token's inherited project grant.
    // Stop that grant from inheriting into sensitive paths instead, then restore inheritance on cleanup.
    let capability = project_capability(&request.cwd)?;
    for path in &cleanup.record.protected {
        protect_acl(&path.path, capability.psid())?;
    }
    // After protection, so the one-time propagation never enters protected metadata.
    ensure_project_grant(&request.cwd, capability.psid())?;

    for (paths, access, required) in [
        (&request.read_only, FILE_READ_EXECUTE, false),
        (&request.read_write, FILE_MODIFY, true),
    ] {
        for path in paths {
            // The project's own write grant belongs to its capability (above), not to this run.
            if !Path::new(path).exists() || path.eq_ignore_ascii_case(&request.cwd) {
                continue;
            }
            if let Err(message) = edit_acl(path, sid, access, Change::Grant) {
                if required
                    || (readonly_git
                        && request
                            .deny_write
                            .iter()
                            .any(|protected| protected.eq_ignore_ascii_case(path)))
                {
                    return Err(message);
                }
            }
        }
    }
    // Program Files folders are shared with other runs, so they are granted under the permission lock.
    for plan in toolchains.iter_mut() {
        if !plan.stage {
            // WRITE_DAC was checked before journaling. A concurrent permissions change can still deny the grant.
            plan.stage = edit_acl(&plan.source, sid, FILE_READ_EXECUTE, Change::Grant).is_err();
        }
    }
    drop(permission_lock);

    // Toolchains are copied once and then reused from the shared cache (#108). A copy is made in this run's private
    // staging folder (removed by cleanup and recovery), so a partial copy never appears in the cache. Copies can
    // take seconds, so they are made without the lock.
    let mut mappings = Vec::new();
    let cache = cache_root()?;
    let started = Instant::now();
    let mut copied = 0u64;
    let mut staging_created = false;
    for (index, plan) in toolchains.iter().enumerate() {
        if !plan.stage {
            continue;
        }
        let entry = cache.join(&plan.key);
        if !cache_entry_ready(&entry) {
            let staged = cleanup
                .record
                .staged
                .as_ref()
                .ok_or("missing staged toolchain root")?;
            let root = Path::new(staged);
            if !staging_created {
                fs::create_dir_all(root.parent().ok_or("missing staging parent")?)
                    .map_err(|e| format!("cannot create staging parent: {e}"))?;
                fs::create_dir(root).map_err(|e| format!("cannot create staging root: {e}"))?;
                // Copies inherit this as they are written, so publishing needs no ACL propagation. Packages may
                // read and execute the copy, never write it.
                edit_acl(staged, package, FILE_READ_EXECUTE, Change::Grant)?;
                staging_created = true;
            }
            let target = root.join(index.to_string());
            if let Err(message) = copy_toolchain(plan, &target, started, &mut copied, || {
                ensure_active(jobs, id)
            }) {
                ensure_active(jobs, id)?;
                warnings.push(format!("{}: {message}", plan.source));
                continue;
            }
            // Directory rename is atomic. If another run published the same key first, use its copy instead.
            if let Err(error) = fs::rename(&target, &entry) {
                if !cache_entry_ready(&entry) {
                    warnings.push(format!(
                        "{}: cannot cache toolchain copy: {error}",
                        plan.source
                    ));
                    continue;
                }
            } else {
                let _lock = PermissionLock::acquire()?;
                let in_use: Vec<String> = recovery_records()?
                    .into_iter()
                    .flat_map(|record| record.cached)
                    .collect();
                remove_stale_cache_entries(&cache, &plan.key, &in_use, SystemTime::now());
            }
        }
        let _ = set_cache_entry_time(&entry, SystemTime::now());
        let drive = toolchain_drive
            .as_ref()
            .ok_or("missing toolchain cache drive")?;
        let prefix = String::from_utf16_lossy(&drive.cwd[..drive.cwd.len() - 1]);
        mappings.push((plan.source.clone(), format!("{prefix}{}", plan.key)));
    }
    let mut capability_sid = PSID::default();
    let mut capabilities = vec![SID_AND_ATTRIBUTES {
        Sid: capability.psid(),
        Attributes: SE_GROUP_ENABLED,
    }];
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
    // EOF pipe rather than a NUL device handle: Git for Windows reopens NUL on hosts that deny device access
    // to AppContainers. A closed input pipe preserves non-interactive stdin without granting device permissions.
    let stdin = make_pipe()?;
    unsafe {
        SetHandleInformation(stdin.read.0, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
            .map_err(|e| describe("inherit stdin pipe", e))?;
    }
    let Pipe {
        read: input,
        write: input_write,
    } = stdin;
    let input_write = if stdio { Some(input_write) } else { None };
    let mut inherited = [input.0, stdout.write.0, stderr.write.0];

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
    startup.StartupInfo.hStdInput = input.0;
    startup.StartupInfo.hStdOutput = stdout.write.0;
    startup.StartupInfo.hStdError = stderr.write.0;
    startup.lpAttributeList = list;

    // An ordinary AppContainer cannot traverse a Windows 11 volume root, even when its project
    // itself is granted. A temporary drive makes that project the root without exposing its parents.
    let project_prefix =
        String::from_utf16_lossy(&project_drive.cwd[..project_drive.cwd.len() - 1]);
    mappings.push((request.cwd.clone(), project_prefix));
    // This path is journaled before creation. A unique drive avoids granting or traversing host temp ancestors.
    let temporary = cleanup
        .record
        .temporary
        .as_ref()
        .ok_or("missing temporary root")?;
    let temporary_root = Path::new(temporary);
    fs::create_dir_all(temporary_root.parent().ok_or("missing temporary parent")?)
        .map_err(|e| format!("cannot create temporary parent: {e}"))?;
    fs::create_dir(temporary_root).map_err(|e| format!("cannot create temporary root: {e}"))?;
    for name in ["tmp", "npm-cache"] {
        fs::create_dir(temporary_root.join(name))
            .map_err(|e| format!("cannot create temporary subdirectory: {e}"))?;
    }
    fs::write(temporary_root.join("npmrc"), "")
        .map_err(|e| format!("cannot create empty npm user config: {e}"))?;
    edit_acl(temporary, sid, FILE_MODIFY, Change::Grant)?;
    let temporary_drive = ProjectDrive::create(temporary)?;
    let temporary_prefix =
        String::from_utf16_lossy(&temporary_drive.cwd[..temporary_drive.cwd.len() - 1]);
    // Filtered network (#97): the command starts under net-bridge, copied into its private temporary folder (an
    // AppContainer cannot run it from the install folder), and has no network capability of its own.
    let relay = match (&request.proxy, &bridge) {
        (Some(proxy), Some(bridge)) => {
            fs::copy(bridge, temporary_root.join("net-bridge.exe"))
                .map_err(|e| format!("cannot prepare the network bridge: {e}"))?;
            Some(ProxyRelay::start(&profile, sid, proxy)?)
        }
        _ => None,
    };
    let command = mapped_path(&request.command, &mappings);
    // A sandboxed MCP server names its script by path (#87); inside, the project is only reachable as the mapped drive.
    let program_args: Vec<String> = request
        .args
        .iter()
        .map(|arg| {
            if stdio {
                mapped_path(arg, &mappings)
            } else {
                arg.clone()
            }
        })
        .collect();
    let (application, line) = match &relay {
        Some(relay) => {
            let bridge = format!("{temporary_prefix}net-bridge.exe");
            let mut args = vec![
                "0".to_string(),
                relay.name.clone(),
                "--".to_string(),
                command,
            ];
            args.extend(program_args.iter().cloned());
            let line = command_line(&bridge, &args);
            (bridge, line)
        }
        None => {
            let line = command_line(&command, &program_args);
            (command, line)
        }
    };
    let mut cmdline = wide(&line);
    let application = wide(&application);
    // Process creation in a container fails (ERROR_ENVVAR_NOT_FOUND) without LOCALAPPDATA, which Windows rewrites.
    let mut vars = request.env.clone();
    let private_names = [
        "TEMP",
        "TMP",
        "TMPDIR",
        "NPM_CONFIG_CACHE",
        "NPM_CONFIG_USERCONFIG",
    ];
    vars.retain(|key, _| {
        !private_names
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name))
    });
    for name in ["TEMP", "TMP", "TMPDIR"] {
        vars.insert(name.to_string(), format!("{temporary_prefix}tmp"));
    }
    vars.insert(
        "NPM_CONFIG_CACHE".to_string(),
        format!("{temporary_prefix}npm-cache"),
    );
    vars.insert(
        "NPM_CONFIG_USERCONFIG".to_string(),
        format!("{temporary_prefix}npmrc"),
    );
    for (key, value) in &mut vars {
        if key.eq_ignore_ascii_case("PATH") {
            *value = value
                .split(';')
                .map(|entry| mapped_path(entry, &mappings))
                .collect::<Vec<_>>()
                .join(";");
        } else if key.eq_ignore_ascii_case("HOME") || key.eq_ignore_ascii_case("USERPROFILE") {
            // A sandboxed MCP server's HOME is its own folder, which is the mapped working directory (#87).
            *value = mapped_path(value, &mappings);
        }
    }
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
            PCWSTR(project_drive.cwd.as_ptr()),
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
    {
        let mut active = jobs.lock().unwrap();
        if active.get(&id).copied().flatten().is_none() {
            unsafe {
                let _ = TerminateProcess(process.0, 1);
            }
            return Err("sandbox command stopped during preparation".to_string());
        }
        active.insert(id, Some(job.0 .0 as usize));
    }

    // Only the command holds the write ends now, so the readers end when it and its children are gone.
    let Pipe {
        read: out_read,
        write: out_write,
    } = stdout;
    let Pipe {
        read: err_read,
        write: err_write,
    } = stderr;
    drop((out_write, err_write, input));
    let readers = if stdio {
        let our_out = Handle(HANDLE(std::io::stdout().as_raw_handle()));
        let our_err = Handle(HANDLE(std::io::stderr().as_raw_handle()));
        let our_in = SendHandle(HANDLE(std::io::stdin().as_raw_handle()));
        let input_write = input_write.expect("stdio keeps the input pipe");
        let to_in = SendHandle(input_write.0);
        let from_out = SendHandle(out_read.0);
        let to_out = SendHandle(our_out.0);
        let from_err = SendHandle(err_read.0);
        let to_err = SendHandle(our_err.0);
        vec![
            thread::spawn(move || {
                copy_pipe(our_in, to_in);
                drop(input_write);
            }),
            thread::spawn(move || {
                copy_pipe(from_out, to_out);
                drop((out_read, our_out));
            }),
            thread::spawn(move || {
                copy_pipe(from_err, to_err);
                drop((err_read, our_err));
            }),
        ]
    } else {
        drop(input_write);
        let json = emitter.cloned().expect("command mode has an event stream");
        vec![
            {
                let emitter = json.clone();
                thread::spawn(move || pump(id, out_read, emitter, false))
            },
            {
                let emitter = json;
                thread::spawn(move || pump(id, err_read, emitter, true))
            },
        ]
    };

    // Before the command runs, so no output can arrive ahead of Started (#195).
    if let Some(emitter) = emitter {
        emitter.send(&Event::Started {
            id,
            pid: info.dwProcessId,
        });
    }
    unsafe { ResumeThread(thread_handle.0) };
    if let Some(emitter) = emitter {
        for warning in &warnings {
            emitter.send(&Event::Stderr {
                id,
                data: &format!("Patch sandbox: not readable in this command: {warning}\n"),
            });
        }
    }

    let timeout = if request.limits.timeout_ms > 0 {
        request.limits.timeout_ms.min(u32::MAX as u64 - 1) as u32
    } else {
        INFINITE
    };
    let waited = unsafe { WaitForSingleObject(process.0, timeout) };
    let mut timed_out = waited == WAIT_TIMEOUT;
    // Also ends anything the command left running.
    let exited = unsafe {
        let _ = TerminateJobObject(job.0, 1);
        WaitForSingleObject(process.0, 5000)
    } == WAIT_OBJECT_0;
    let mut code = 0u32;
    unsafe {
        let _ = GetExitCodeProcess(process.0, &mut code);
    }
    // A process still running after the terminate has no exit code yet (GetExitCodeProcess would report
    // STILL_ACTIVE, 259), and may still hold its pipes, so its readers are left to end on their own (#195).
    let exit_code = if exited {
        code as i64
    } else {
        timed_out = true;
        -1
    };
    if exited {
        for reader in readers {
            let _ = reader.join();
        }
    }
    jobs.lock().unwrap().remove(&id);
    drop(job);
    drop(toolchain_drive);
    // Cleanup runs under the permission lock, like setup. A failure is reported with the command's output, not
    // instead of its exit code: the journal stays, and the next helper start retries it.
    let cleaned = PermissionLock::acquire().and_then(|_lock| {
        cleanup.record.undo(cleanup.sid.0)?;
        fs::remove_file(&cleanup.path)
            .map_err(|e| format!("cannot remove sandbox recovery record: {e}"))
    });
    cleanup.finished = true;
    drop(cleanup);
    if let Err(message) = cleaned {
        if let Some(emitter) = emitter {
            emitter.send(&Event::Stderr {
                id,
                data: &format!(
                    "\nPatch sandbox: cleanup failed ({message}); it is retried when the next command starts.\n"
                ),
            });
        }
    }
    if let Some(emitter) = emitter {
        emitter.send(&Event::Exit {
            id,
            exit_code,
            timed_out,
        });
    }
    Ok(exit_code.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_path_comparison_is_component_aware_and_case_insensitive() {
        assert!(path_within(
            Path::new(r"C:\Users\ME\AppData\project"),
            Path::new(r"c:\users\me\appdata")
        ));
        assert!(!path_within(
            Path::new(r"C:\Users\me\AppData-safe"),
            Path::new(r"C:\Users\me\AppData")
        ));
    }

    #[test]
    fn unsafe_roots_are_refused_at_run_entry_without_permission_changes() {
        let home = fs::canonicalize(std::env::var_os("USERPROFILE").unwrap()).unwrap();
        let data = fs::canonicalize(std::env::var_os("LOCALAPPDATA").unwrap()).unwrap();
        let fixture = data.join(profile_name());
        fs::create_dir(&fixture).unwrap();
        fs::write(fixture.join("sentinel"), b"unchanged").unwrap();
        let before = original_inheritance(fixture.to_str().unwrap())
            .unwrap()
            .map(|snapshot| snapshot.dacl);
        let emitter = Emitter(Arc::new(Mutex::new(std::io::stdout())));
        let jobs: Jobs = Arc::new(Mutex::new(HashMap::new()));
        let volume = home.ancestors().last().unwrap();
        for root in [&home, home.parent().unwrap(), volume, &data, &fixture] {
            let request: Request = serde_json::from_value(serde_json::json!({
                "id": 7, "command": "not-a-program", "cwd": root,
                "readWrite": [root]
            }))
            .unwrap();
            assert!(run(&request, &emitter, &jobs)
                .unwrap_err()
                .contains("sandbox refused"));
        }
        assert!(jobs.lock().unwrap().is_empty());
        assert_eq!(fs::read(fixture.join("sentinel")).unwrap(), b"unchanged");
        assert_eq!(
            original_inheritance(fixture.to_str().unwrap())
                .unwrap()
                .map(|snapshot| snapshot.dacl),
            before
        );
        fs::remove_dir_all(fixture).unwrap();
        let safe = home.join(profile_name());
        fs::create_dir(&safe).unwrap();
        assert!(validate_project_root(safe.to_str().unwrap(), false).is_ok());
        fs::remove_dir(safe).unwrap();
    }

    #[test]
    fn a_workspace_folder_may_sit_inside_application_data() {
        let data = fs::canonicalize(std::env::var_os("LOCALAPPDATA").unwrap()).unwrap();
        let fixture = data.join(profile_name());
        fs::create_dir(&fixture).unwrap();
        assert!(validate_project_root(fixture.to_str().unwrap(), false)
            .unwrap_err()
            .contains("sandbox refused"));
        assert!(validate_project_root(fixture.to_str().unwrap(), true).is_ok());
        assert!(validate_project_root(data.to_str().unwrap(), true)
            .unwrap_err()
            .contains("sandbox refused"));
        fs::remove_dir(fixture).unwrap();
    }

    #[test]
    fn the_permission_lock_wait_ends_when_stopped_and_survives_a_dead_holder() {
        let (held_tx, held_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = thread::spawn(move || {
            let lock = PermissionLock::acquire().unwrap();
            held_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            drop(lock);
        });
        held_rx.recv().unwrap();
        // A stopped command ends the wait, and the notice says why it was waiting.
        let noticed = std::cell::Cell::new(false);
        let stopped = PermissionLock::acquire_while(
            || {
                if noticed.get() {
                    Err("stopped".to_string())
                } else {
                    Ok(())
                }
            },
            || noticed.set(true),
        );
        assert_eq!(stopped.err().as_deref(), Some("stopped"));
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        // A holder that exits without releasing abandons the mutex; the next waiter gets it.
        thread::spawn(|| std::mem::forget(PermissionLock::acquire().unwrap()))
            .join()
            .unwrap();
        let started = Instant::now();
        let deadline = || {
            if started.elapsed() > Duration::from_secs(30) {
                Err("timed out".to_string())
            } else {
                Ok(())
            }
        };
        assert!(PermissionLock::acquire_while(deadline, || {}).is_ok());
    }

    #[test]
    fn short_names_are_not_treated_as_reparse_points() {
        let root = std::env::temp_dir().join(profile_name());
        fs::create_dir(&root).unwrap();
        let path = wide(root.to_str().unwrap());
        let mut short = vec![0u16; 32768];
        let length = unsafe { GetShortPathNameW(PCWSTR(path.as_ptr()), Some(&mut short)) } as usize;
        assert!(length > 0 && length < short.len());
        let short = String::from_utf16(&short[..length]).unwrap();
        let mut package = PSID::default();
        unsafe {
            ConvertStringSidToSidW(windows::core::w!("S-1-15-2-1"), &mut package).unwrap();
        }
        let _package = LocalMem(package.0);
        let result = inspect_toolchain(&short, package, || Ok(()));
        assert!(result.is_ok());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn cancelled_preparation_never_registers_a_running_command() {
        let jobs: Jobs = Arc::new(Mutex::new(HashMap::from([(7, Some(0))])));
        ensure_active(&jobs, 7).unwrap();
        kill_job(&jobs, Some(7));
        assert!(ensure_active(&jobs, 7)
            .unwrap_err()
            .contains("stopped during preparation"));
        assert_eq!(jobs.lock().unwrap().get(&7), Some(&None));
    }

    #[test]
    fn old_recovery_records_default_to_no_staging() {
        let record: RecoveryRecord =
            serde_json::from_str(r#"{"name":"patch.sbx.test","granted":[],"protected":[]}"#)
                .unwrap();
        assert!(record.staged.is_none());
        assert!(record.temporary.is_none());
        assert!(record.project_drive.is_none());
    }

    #[test]
    fn mapped_paths_preserve_boundaries_and_case_insensitive_path_order() {
        let mappings = vec![(r"C:\Program Files\nodejs".to_string(), r"Z:\0".to_string())];
        assert_eq!(
            mapped_path(r"c:\PROGRAM FILES\NODEJS\node.exe", &mappings),
            r"Z:\0\node.exe"
        );
        assert_eq!(
            mapped_path(r"C:\Program Files\nodejs-other", &mappings),
            r"C:\Program Files\nodejs-other"
        );
        assert_eq!(
            mapped_path(r"C:\Windows\System32", &mappings),
            r"C:\Windows\System32"
        );
    }

    fn sid_text(sid: PSID) -> String {
        let mut text = PWSTR::null();
        unsafe {
            ConvertSidToStringSidW(sid, &mut text).unwrap();
            let _text = LocalMem(text.0 as *mut c_void);
            text.to_string().unwrap()
        }
    }

    #[test]
    fn project_capabilities_are_stable_per_project_and_distinct_between_projects() {
        let project = project_capability(r"C:\Users\ada\project").unwrap();
        assert!(sid_text(project.psid()).starts_with("S-1-15-3-1024-"));
        assert_eq!(
            sid_text(project_capability(r"c:\users\ADA\Project").unwrap().psid()),
            sid_text(project.psid())
        );
        assert_ne!(
            sid_text(project_capability(r"C:\Users\ada\project2").unwrap().psid()),
            sid_text(project.psid())
        );
    }

    #[test]
    fn protection_strips_only_the_project_capability_and_revoke_removes_the_grant() {
        let root = std::env::temp_dir().join(profile_name());
        let git = root.join(".git");
        fs::create_dir_all(git.join("hooks")).unwrap();
        let cwd = root.to_str().unwrap();
        let capability = project_capability(cwd).unwrap();
        ensure_project_grant(cwd, capability.psid()).unwrap();
        let hooks = git.join("hooks");
        assert!(path_allows(hooks.to_str().unwrap(), capability.psid()).unwrap());
        // A second run finds the finished grant and changes nothing.
        ensure_project_grant(cwd, capability.psid()).unwrap();

        protect_acl(git.to_str().unwrap(), capability.psid()).unwrap();
        assert!(!path_allows(git.to_str().unwrap(), capability.psid()).unwrap());
        assert!(!path_allows(hooks.to_str().unwrap(), capability.psid()).unwrap());
        assert!(path_allows(cwd, capability.psid()).unwrap());
        // Everything else was kept: the user can still write inside the protected folder.
        fs::write(hooks.join("pre-commit"), "user").unwrap();

        revoke_project(cwd).unwrap();
        assert!(!path_allows(cwd, capability.psid()).unwrap());
        assert!(!project_grant_marker(cwd).unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn toolchain_keys_follow_the_install_and_its_contents() {
        let entries = |size: u64| vec!["|true|0|1".to_string(), format!("node.exe|false|{size}|2")];
        let key = toolchain_key(r"C:\Program Files\nodejs", entries(10));
        // Walk order and source spelling do not matter.
        let mut reversed = entries(10);
        reversed.reverse();
        assert_eq!(toolchain_key(r"c:\program files\NODEJS", reversed), key);
        // An upgrade changes the contents part only; another install changes the source part.
        let upgraded = toolchain_key(r"C:\Program Files\nodejs", entries(11));
        assert_ne!(upgraded, key);
        assert_eq!(
            upgraded.split_once('-').unwrap().0,
            key.split_once('-').unwrap().0
        );
        let other = toolchain_key(r"C:\Program Files\Go\bin", entries(10));
        assert_ne!(
            other.split_once('-').unwrap().0,
            key.split_once('-').unwrap().0
        );
    }

    #[test]
    fn stale_cache_removal_keeps_the_current_copy_entries_in_use_and_recently_used_installs() {
        let cache = std::env::temp_dir().join(profile_name());
        let now = SystemTime::now();
        let old = now - Duration::from_secs((CACHE_UNUSED_DAYS + 1) * 24 * 60 * 60);
        for name in ["aaaa-1", "aaaa-2", "aaaa-3", "bbbb-1", "cccc-1", "dddd-1"] {
            fs::create_dir_all(cache.join(name)).unwrap();
            fs::write(cache.join(name).join("node.exe"), name).unwrap();
        }
        // Other installs: one unused past the expiry, one equally old but named by a live record.
        for name in ["cccc-1", "dddd-1"] {
            set_cache_entry_time(&cache.join(name), old).unwrap();
        }
        let in_use = ["aaaa-3".to_string(), "dddd-1".to_string()];
        remove_stale_cache_entries(&cache, "aaaa-1", &in_use, now);
        let mut left: Vec<String> = fs::read_dir(&cache)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["aaaa-1", "aaaa-3", "bbbb-1", "dddd-1"]);
        fs::remove_dir_all(cache).unwrap();
    }

    #[test]
    fn drive_reservation_skips_letters_this_run_already_reserved() {
        let first = DriveMapping::reserve(r"C:\first", &[]).unwrap();
        let second = DriveMapping::reserve(r"C:\second", &[&first]).unwrap();
        assert_ne!(first.name, second.name);
    }

    #[test]
    fn mapped_paths_match_short_name_aliases_of_the_source() {
        let root = std::env::temp_dir().join(format!("{} long name", profile_name()));
        fs::create_dir_all(root.join("bin")).unwrap();
        let long = root.to_str().unwrap().to_string();
        let source = wide(&long);
        let mut short = vec![0u16; 1024];
        let size = unsafe { GetShortPathNameW(PCWSTR(source.as_ptr()), Some(&mut short)) } as usize;
        let short = String::from_utf16_lossy(&short[..size]);
        // Volumes can disable 8.3 names (CI runners keep them: C:\Users\RUNNER~1).
        if size > 0 && !short.eq_ignore_ascii_case(&long) {
            let mappings = vec![(long.clone(), r"Q:\".to_string())];
            assert_eq!(mapped_path(&format!(r"{short}\bin"), &mappings), r"Q:\bin");
            assert_eq!(mapped_path(&short, &mappings), r"Q:\");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn package_readability_requires_effective_read_execute_rights() {
        let root = std::env::temp_dir().join(profile_name());
        fs::create_dir(&root).unwrap();
        let path = root.to_str().unwrap();
        let mut package = PSID::default();
        unsafe {
            ConvertStringSidToSidW(windows::core::w!("S-1-15-2-1"), &mut package).unwrap();
        }
        let _package = LocalMem(package.0);
        let mut other = PSID::default();
        unsafe {
            ConvertStringSidToSidW(windows::core::w!("S-1-15-2-2"), &mut other).unwrap();
        }
        let _other = LocalMem(other.0);
        // A different package group or a partial allow ACE is not enough.
        edit_acl(path, package, 0, Change::Revoke).unwrap();
        edit_acl(path, other, FILE_READ_EXECUTE, Change::Grant).unwrap();
        assert!(!package_readable(&root, package).unwrap());
        edit_acl(path, package, FILE_GENERIC_READ.0, Change::Grant).unwrap();
        assert!(!package_readable(&root, package).unwrap());
        edit_acl(path, package, FILE_READ_EXECUTE, Change::Grant).unwrap();
        assert!(package_readable(&root, package).unwrap());
        fs::write(root.join("fixture"), "test").unwrap();
        assert!(inspect_toolchain(path, package, || Ok(()))
            .unwrap()
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_readable_folder_is_not_walked_so_a_nested_link_does_not_fail_it() {
        let root = std::env::temp_dir().join(profile_name());
        fs::create_dir(&root).unwrap();
        let path = root.to_str().unwrap();
        let mut package = PSID::default();
        unsafe {
            ConvertStringSidToSidW(windows::core::w!("S-1-15-2-1"), &mut package).unwrap();
        }
        let _package = LocalMem(package.0);
        // Created after the grant, so every entry inherits read/execute, as in an install that keeps package access.
        edit_acl(path, package, FILE_READ_EXECUTE, Change::Grant).unwrap();
        fs::create_dir(root.join("lib")).unwrap();
        fs::write(root.join("tool.exe"), "binary").unwrap();
        let junction = root.join("lib").join("link");
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(std::env::temp_dir())
            .output()
            .unwrap();
        assert!(made.status.success());
        // The full walk refuses links; a folder whose own entries are readable needs no grant and is not walked.
        assert!(inspect_toolchain(path, package, || Ok(()))
            .unwrap()
            .is_none());
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staging_recovery_removes_only_its_exact_mapping_and_directory() {
        let name = profile_name();
        let staged = staging_path(&name).unwrap();
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("partial-copy"), "bytes").unwrap();
        let drive = ProjectDrive::create(staged.to_str().unwrap()).unwrap();
        let mut record = RecoveryRecord {
            name,
            granted: vec![],
            protected: vec![],
            staged: Some(staged.to_str().unwrap().to_string()),
            temporary: None,
            project_drive: None,
            toolchain_drive: None,
            cached: vec![],
        };
        let sid = record_sid(&record.name).unwrap();
        record.undo(sid.0).unwrap();
        assert!(!staged.exists());
        record.undo(sid.0).unwrap();
        drop(drive);
        record.staged = Some(std::env::temp_dir().to_str().unwrap().to_string());
        assert!(record
            .undo(sid.0)
            .unwrap_err()
            .contains("invalid sandbox staging path"));
    }

    #[test]
    fn temporary_recovery_removes_only_its_exact_mapping_and_directory() {
        let name = profile_name();
        let temporary = temporary_path(&name).unwrap();
        let other = temporary_path(&profile_name()).unwrap();
        fs::create_dir_all(&temporary).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(temporary.join("cache"), "private").unwrap();
        fs::write(other.join("cache"), "other run").unwrap();
        let drive = ProjectDrive::create(temporary.to_str().unwrap()).unwrap();
        let other_drive = ProjectDrive::create(other.to_str().unwrap()).unwrap();
        let mut record = RecoveryRecord {
            name,
            granted: vec![],
            protected: vec![],
            staged: None,
            temporary: Some(temporary.to_str().unwrap().to_string()),
            project_drive: None,
            toolchain_drive: None,
            cached: vec![],
        };
        let sid = record_sid(&record.name).unwrap();
        record.undo(sid.0).unwrap();
        assert!(!temporary.exists());
        assert_eq!(
            fs::read_to_string(other.join("cache")).unwrap(),
            "other run"
        );
        assert!(
            unsafe { GetFileAttributesW(PCWSTR(other_drive.cwd.as_ptr())) }
                != INVALID_FILE_ATTRIBUTES
        );
        record.undo(sid.0).unwrap();
        drop(drive);
        drop(other_drive);
        fs::remove_dir_all(other).unwrap();
        record.temporary = Some(std::env::temp_dir().to_str().unwrap().to_string());
        assert!(record
            .undo(sid.0)
            .unwrap_err()
            .contains("invalid sandbox temporary path"));
    }

    #[test]
    fn project_recovery_preserves_shared_projects_and_reused_letters() {
        let _lock = PermissionLock::acquire().unwrap();
        let root = std::env::temp_dir().join(profile_name());
        let project = root.join("project");
        let unrelated = root.join("unrelated");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(project.join("keep"), "project bytes").unwrap();
        fs::write(unrelated.join("keep"), "unrelated bytes").unwrap();
        let crashed = ProjectDrive::create(project.to_str().unwrap()).unwrap();
        let live = ProjectDrive::create(project.to_str().unwrap()).unwrap();
        let mapping = DriveMapping {
            name: String::from_utf16_lossy(&crashed.name[..crashed.name.len() - 1]),
            target: project.to_str().unwrap().to_string(),
        };
        let record = RecoveryRecord {
            name: profile_name(),
            granted: vec![],
            protected: vec![],
            staged: None,
            temporary: None,
            project_drive: Some(mapping.clone()),
            toolchain_drive: None,
            cached: vec![],
        };
        let sid = record_sid(&record.name).unwrap();
        let mapped_file = |drive: &ProjectDrive| {
            PathBuf::from(String::from_utf16_lossy(&drive.cwd[..drive.cwd.len() - 1])).join("keep")
        };
        assert_eq!(
            fs::read_to_string(mapped_file(&crashed)).unwrap(),
            "project bytes"
        );
        record.undo(sid.0).unwrap();
        assert!(!mapped_file(&crashed).exists());
        assert_eq!(
            fs::read_to_string(mapped_file(&live)).unwrap(),
            "project bytes"
        );
        assert_eq!(
            fs::read_to_string(project.join("keep")).unwrap(),
            "project bytes"
        );
        record.undo(sid.0).unwrap();
        // A user or another run can reuse the recovered letter. An old record must not remove it.
        let replacement = {
            let _lock = PermissionLock::acquire().unwrap();
            ProjectDrive::define(
                &DriveMapping {
                    name: mapping.name,
                    target: unrelated.to_str().unwrap().to_string(),
                },
                false,
            )
            .unwrap()
        };
        record.undo(sid.0).unwrap();
        assert_eq!(
            fs::read_to_string(mapped_file(&replacement)).unwrap(),
            "unrelated bytes"
        );
        drop(crashed);
        assert_eq!(
            fs::read_to_string(mapped_file(&replacement)).unwrap(),
            "unrelated bytes"
        );
        drop(replacement);
        drop(live);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn journal_owned_drive_does_not_remove_a_reused_project_mapping() {
        let _lock = PermissionLock::acquire().unwrap();
        let root = std::env::temp_dir().join(profile_name());
        fs::create_dir(&root).unwrap();
        let mapping = DriveMapping::reserve(root.to_str().unwrap(), &[]).unwrap();
        let old = ProjectDrive::define(&mapping, true).unwrap();
        mapping.remove().unwrap();
        let new = ProjectDrive::define(&mapping, false).unwrap();
        drop(old);
        assert!(unsafe { GetFileAttributesW(PCWSTR(new.cwd.as_ptr())) } != INVALID_FILE_ATTRIBUTES);
        drop(new);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn project_recovery_rejects_out_of_range_drive_letters() {
        let mapping = DriveMapping {
            name: "C:".into(),
            target: std::env::temp_dir().to_str().unwrap().to_string(),
        };
        assert!(mapping
            .remove()
            .unwrap_err()
            .contains("invalid sandbox project drive mapping"));
    }

    #[test]
    fn copy_is_bounded_and_preserves_file_bytes_without_copying_source_acls() {
        let root = std::env::temp_dir().join(profile_name());
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("file"), "payload").unwrap();
        let plan = ToolchainPlan {
            source: source.to_str().unwrap().to_string(),
            files: vec![source.clone(), source.join("file")],
            stage: true,
            key: String::new(),
        };
        let mut copied = 0;
        copy_toolchain(&plan, &target, Instant::now(), &mut copied, || Ok(())).unwrap();
        assert_eq!(copied, 7);
        assert_eq!(fs::read(target.join("file")).unwrap(), b"payload");
        let mut copied = TOOLCHAIN_BYTES;
        assert!(copy_toolchain(
            &plan,
            &root.join("overflow"),
            Instant::now(),
            &mut copied,
            || Ok(())
        )
        .unwrap_err()
        .contains("256 MiB"));
        assert!(copy_toolchain(
            &plan,
            &root.join("timeout"),
            Instant::now() - Duration::from_secs(31),
            &mut 0,
            || Ok(()),
        )
        .unwrap_err()
        .contains("30 seconds"));
        assert!(copy_toolchain(
            &plan,
            &root.join("cancelled"),
            Instant::now(),
            &mut 0,
            || Err("cancelled".to_string())
        )
        .unwrap_err()
        .contains("cancelled"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_record_that_cannot_be_undone_does_not_stop_recovery_of_the_others() {
        let dir = std::env::temp_dir().join(profile_name());
        fs::create_dir(&dir).unwrap();
        let names = [profile_name(), profile_name(), profile_name()];
        let failing = names[1].clone();
        let write_records = || {
            for name in &names {
                let record = format!(r#"{{"name":"{name}","granted":[],"protected":[]}}"#);
                fs::write(dir.join(format!("{name}.json")), record).unwrap();
            }
        };
        let undo = |record: &RecoveryRecord| {
            if record.name == failing {
                Err("cannot read the permissions".to_string())
            } else {
                Ok(())
            }
        };
        let logged = std::cell::RefCell::new(Vec::new());
        let log = |code: &str, record: &str, failures: u32| {
            logged
                .borrow_mut()
                .push((code.to_string(), record.to_string(), failures))
        };
        write_records();
        recover_records(&dir, undo, &log).unwrap();
        for name in &names {
            assert_eq!(dir.join(format!("{name}.json")).exists(), *name == failing);
        }
        assert_eq!(
            fs::read_to_string(failures_path(&dir, &failing)).unwrap(),
            "1"
        );
        for _ in 1..RECOVERY_ATTEMPTS {
            recover_records(&dir, undo, &log).unwrap();
        }
        assert!(!dir.join(format!("{failing}.json")).exists());
        assert!(!failures_path(&dir, &failing).exists());
        assert!(dir
            .join("quarantine")
            .join(format!("{failing}.json"))
            .exists());
        let mut expected: Vec<_> = (1..RECOVERY_ATTEMPTS)
            .map(|n| ("recovery-failed".to_string(), failing.clone(), n))
            .collect();
        expected.push((
            "recovery-quarantined".to_string(),
            failing.clone(),
            RECOVERY_ATTEMPTS,
        ));
        assert_eq!(*logged.borrow(), expected);
        // A record that recovers after failing loses its failure count.
        write_records();
        recover_records(
            &dir,
            |record| undo(record).and(Err("once".to_string())),
            &log,
        )
        .unwrap();
        recover_records(&dir, |_| Ok(()), &log).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn records_that_cannot_be_parsed_are_quarantined_and_ignored() {
        let dir = std::env::temp_dir().join(profile_name());
        fs::create_dir(&dir).unwrap();
        let (good, truncated, renamed) = (profile_name(), profile_name(), profile_name());
        let record = |name: &str| format!(r#"{{"name":"{name}","granted":[],"protected":[]}}"#);
        fs::write(dir.join(format!("{good}.json")), record(&good)).unwrap();
        fs::write(
            dir.join(format!("{truncated}.json")),
            r#"{"name":"patch.sb"#,
        )
        .unwrap();
        // A valid record whose file name doesn't match the profile it names can't be trusted to undo.
        fs::write(dir.join(format!("{renamed}.json")), record(&good)).unwrap();
        assert_eq!(records_in(&dir).unwrap().len(), 2);
        let undone = std::cell::RefCell::new(Vec::new());
        let logged = std::cell::RefCell::new(Vec::new());
        recover_records(
            &dir,
            |record| {
                undone.borrow_mut().push(record.name.clone());
                Ok(())
            },
            &|code, record, failures| {
                logged
                    .borrow_mut()
                    .push((code.to_string(), record.to_string(), failures))
            },
        )
        .unwrap();
        assert_eq!(*undone.borrow(), vec![good.clone()]);
        let mut logged = logged.into_inner();
        logged.sort();
        let mut expected = vec![
            ("record-unreadable".to_string(), truncated.clone(), 0),
            ("record-unreadable".to_string(), renamed.clone(), 0),
        ];
        expected.sort();
        assert_eq!(logged, expected);
        for name in [&truncated, &renamed] {
            assert!(dir.join("quarantine").join(format!("{name}.json")).exists());
        }
        assert!(records_in(&dir).unwrap().is_empty());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn revoking_on_a_path_whose_permissions_cannot_be_read_is_a_no_op() {
        let root = std::env::temp_dir().join(profile_name());
        fs::create_dir(&root).unwrap();
        let path = root.to_str().unwrap().to_string();
        let set_dacl = |sddl: &str| {
            let (wpath, sddl) = (wide(&path), wide(sddl));
            unsafe {
                let mut descriptor = PSECURITY_DESCRIPTOR::default();
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(sddl.as_ptr()),
                    1,
                    &mut descriptor,
                    None,
                )
                .unwrap();
                let _descriptor = LocalMem(descriptor.0);
                // Unlike SetNamedSecurityInfoW, this needs only WRITE_DAC, not reading the current permissions.
                SetFileSecurityW(
                    PCWSTR(wpath.as_ptr()),
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    descriptor,
                )
                .ok()
                .unwrap();
            }
        };
        // OWNER RIGHTS replaces the owner's implicit READ_CONTROL: only changing and deleting stay allowed.
        set_dacl("D:P(A;;WDSD;;;OW)");
        let sid = record_sid(&profile_name()).unwrap();
        assert!(edit_acl(&path, sid.0, FILE_MODIFY, Change::Grant)
            .unwrap_err()
            .contains("cannot read the permissions"));
        edit_acl(&path, sid.0, 0, Change::Revoke).unwrap();
        set_dacl("D:P(A;OICI;FA;;;OW)");
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn recovery_is_idempotent_even_after_the_profile_has_been_deleted() {
        let name = profile_name();
        let root = std::env::temp_dir().join(&name);
        fs::create_dir(&root).unwrap();
        let path = root.to_str().unwrap().to_string();
        let wname = wide(&name);
        let sid = Sid(unsafe {
            CreateAppContainerProfile(
                PCWSTR(wname.as_ptr()),
                windows::core::w!("Patch test"),
                windows::core::w!("Patch test"),
                None,
            )
            .unwrap()
        });
        let record = RecoveryRecord {
            name,
            granted: vec![path.clone()],
            protected: vec![],
            staged: None,
            temporary: None,
            project_drive: None,
            toolchain_drive: None,
            cached: vec![],
        };
        let other_name = wide(&profile_name());
        let other = Sid(unsafe {
            CreateAppContainerProfile(
                PCWSTR(other_name.as_ptr()),
                windows::core::w!("Patch test"),
                windows::core::w!("Patch test"),
                None,
            )
            .unwrap()
        });
        // SDDL always uses SID strings, independent of account-name lookup and OS language.
        let permissions = || {
            let wpath = wide(&path);
            unsafe {
                let mut descriptor = PSECURITY_DESCRIPTOR::default();
                assert_eq!(
                    GetNamedSecurityInfoW(
                        PCWSTR(wpath.as_ptr()),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        None,
                        None,
                        None,
                        None,
                        &mut descriptor
                    ),
                    ERROR_SUCCESS
                );
                let _descriptor = LocalMem(descriptor.0);
                let mut sddl = PWSTR::null();
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    1,
                    DACL_SECURITY_INFORMATION,
                    &mut sddl,
                    None,
                )
                .unwrap();
                let _sddl = LocalMem(sddl.0 as *mut c_void);
                sddl.to_string().unwrap()
            }
        };
        edit_acl(&path, other.0, FILE_READ_EXECUTE, Change::Grant).unwrap();
        let unrelated = permissions();
        edit_acl(&path, sid.0, FILE_MODIFY, Change::Grant).unwrap();
        assert_ne!(permissions(), unrelated);
        unsafe { DeleteAppContainerProfile(PCWSTR(wname.as_ptr())).unwrap() };
        let derived = record_sid(&record.name).unwrap();
        record.undo(derived.0).unwrap();
        assert_eq!(permissions(), unrelated);
        record.undo(derived.0).unwrap();
        assert_eq!(permissions(), unrelated);
        edit_acl(&path, other.0, 0, Change::Revoke).unwrap();
        unsafe { DeleteAppContainerProfile(PCWSTR(other_name.as_ptr())).unwrap() };
        fs::remove_dir(&root).unwrap();
    }
}
