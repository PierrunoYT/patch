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

struct ProjectDrive {
    name: Vec<u16>,
    target: Vec<u16>,
    cwd: Vec<u16>,
}

impl ProjectDrive {
    fn create(path: &str) -> Result<Self> {
        let used = unsafe { GetLogicalDrives() };
        let target = wide(&format!(r"\??\{path}"));
        for letter in (b'P'..=b'Z').rev() {
            if used & (1 << (letter - b'A')) != 0 {
                continue;
            }
            let name = wide(&format!("{}:", letter as char));
            let defined = unsafe {
                DefineDosDeviceW(
                    DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM,
                    PCWSTR(name.as_ptr()),
                    PCWSTR(target.as_ptr()),
                )
            };
            if defined.is_ok() {
                return Ok(Self {
                    name,
                    target,
                    cwd: wide(&format!("{}:\\", letter as char)),
                });
            }
        }
        Err("no drive letter is available for the sandbox working directory".to_string())
    }
}

impl Drop for ProjectDrive {
    fn drop(&mut self) {
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
    if let Err(message) = recover_abandoned_runs() {
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
        if status != ERROR_SUCCESS {
            return Err(format!(
                "cannot read the permissions of {path} (error {})",
                status.0
            ));
        }
        let _descriptor = LocalMem(descriptor.0);
        if change == Change::Revoke {
            let mut present = false;
            if !old_dacl.is_null() {
                for index in 0..(*old_dacl).AceCount as u32 {
                    let mut ace = std::ptr::null_mut();
                    GetAce(old_dacl, index, &mut ace).map_err(|e| describe("GetAce", e))?;
                    // Our grants use ordinary ACCESS_ALLOWED_ACE (type 0), never object/callback ACEs.
                    let allowed = ace as *const ACCESS_ALLOWED_ACE;
                    if (*allowed).Header.AceType == 0
                        && EqualSid(
                            PSID(std::ptr::addr_of!((*allowed).SidStart) as *mut c_void),
                            sid,
                        )
                        .is_ok()
                    {
                        present = true;
                        break;
                    }
                }
            }
            if !present {
                return Ok(());
            }
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

fn set_acl_protected(path: &str, protected: bool) -> Result<()> {
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
        let protection = if protected {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            UNPROTECTED_DACL_SECURITY_INFORMATION
        };
        let status = SetNamedSecurityInfoW(
            PCWSTR(wpath.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | protection,
            None,
            None,
            Some(dacl),
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
}

#[derive(Serialize, Deserialize)]
struct ProtectedPath {
    path: String,
    dacl: String,
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
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
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

struct ToolchainPlan {
    source: String,
    files: Vec<PathBuf>,
    stage: bool,
}

// Inspection is bounded separately from copying: large already-readable installs (e.g. Python) need no grant.
fn inspect_toolchain(
    source: &str,
    package: PSID,
    check: impl Fn() -> Result<()>,
) -> Result<Option<ToolchainPlan>> {
    let root = Path::new(source);
    let canonical = fs::canonicalize(root).map_err(|e| format!("cannot resolve toolchain: {e}"))?;
    let resolved = canonical
        .to_str()
        .ok_or("non-Unicode resolved toolchain")?
        .strip_prefix(r"\\?\")
        .unwrap_or(canonical.to_str().ok_or("non-Unicode resolved toolchain")?);
    if !resolved.eq_ignore_ascii_case(
        source
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .as_str(),
    ) {
        return Err("toolchain resolves through an ancestor reparse point".to_string());
    }
    let started = Instant::now();
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut readable = true;
    let mut protected = false;
    let mut bytes = 0u64;
    while let Some(path) = pending.pop() {
        check()?;
        if files.len() >= INSPECTION_ENTRIES || started.elapsed() > Duration::from_secs(15) {
            return Err("toolchain inspection exceeds its entry/time limit".to_string());
        }
        let meta =
            fs::symlink_metadata(&path).map_err(|e| format!("cannot inspect toolchain: {e}"))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
            || !fs::canonicalize(&path)
                .map_err(|e| format!("cannot resolve toolchain entry: {e}"))?
                .starts_with(&canonical)
        {
            return Err("toolchain contains a reparse point or escaping path".to_string());
        }
        let (package_readable, acl_protected) = package_access(&path, package)?;
        readable &= package_readable;
        // Protected descendants do not inherit a grant placed on their install directory.
        protected |= acl_protected;
        if meta.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| format!("cannot list toolchain: {e}"))? {
                if files.len() + pending.len() >= INSPECTION_ENTRIES {
                    return Err("toolchain inspection exceeds its entry limit".to_string());
                }
                pending.push(
                    entry
                        .map_err(|e| format!("cannot list toolchain entry: {e}"))?
                        .path(),
                );
            }
        } else {
            bytes = bytes
                .checked_add(meta.len())
                .ok_or("toolchain size overflow")?;
        }
        files.push(path);
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
        source: source.to_string(),
        files,
        stage: !writable || protected,
    }))
}

fn recovery_dir() -> Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is missing")?;
    Ok(PathBuf::from(local).join("Patch").join("sandbox-recovery"))
}

fn lock_record(path: &Path, create: bool) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create)
        .share_mode(FILE_SHARE_DELETE.0)
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
            if Path::new(&path.path).exists() {
                if let Err(error) = path.restore() {
                    result = Err(error);
                }
            }
        }
        if let Some(staged) = &self.staged {
            let expected = staging_path(&self.name)?;
            if Path::new(staged) != expected {
                return Err("invalid sandbox staging path".to_string());
            }
            for letter in b'P'..=b'Z' {
                let name = wide(&format!("{}:", letter as char));
                let target = wide(&format!(r"\??\{staged}"));
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
                    result = Err(format!("cannot remove staged toolchain: {error}"));
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

fn recover_abandoned_runs() -> Result<()> {
    let dir = recovery_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create sandbox recovery folder: {e}"))?;
    for entry in
        fs::read_dir(&dir).map_err(|e| format!("cannot read sandbox recovery folder: {e}"))?
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
        let mut text = String::new();
        file.read_to_string(&mut text)
            .map_err(|e| format!("cannot read sandbox recovery record: {e}"))?;
        // Pending writes cannot have changed permissions. A published record must remain intact.
        if extension == Some("json") {
            let record: RecoveryRecord = serde_json::from_str(&text)
                .map_err(|e| format!("invalid sandbox recovery record: {e}"))?;
            if !record.name.starts_with("patch.sbx.")
                || path.file_stem().and_then(|s| s.to_str()) != Some(&record.name)
            {
                return Err("invalid sandbox recovery profile".to_string());
            }
            let sid = record_sid(&record.name)?;
            record.undo(sid.0)?;
        }
        fs::remove_file(&path)
            .map_err(|e| format!("cannot remove sandbox recovery record: {e}"))?;
    }
    Ok(())
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
        if !self.finished && self.record.undo(self.sid.0).is_ok() {
            let _ = fs::remove_file(&self.path);
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

fn mapped_path(path: &str, mappings: &[(String, String)]) -> String {
    let lower = path.replace('/', "\\").to_ascii_lowercase();
    for (source, target) in mappings {
        let source = source
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_ascii_lowercase();
        if lower == source {
            return target.clone();
        }
        if lower.starts_with(&format!("{source}\\")) {
            return format!("{}{}", target.trim_end_matches('\\'), &path[source.len()..]);
        }
    }
    path.to_string()
}

fn run(request: &Request, emitter: &Emitter, jobs: &Jobs) -> Result<()> {
    let id = request.id;
    let mut package = PSID::default();
    unsafe { ConvertStringSidToSidW(windows::core::w!("S-1-15-2-1"), &mut package) }
        .map_err(|e| describe("create package SID", e))?;
    let _package = LocalMem(package.0);
    if request.toolchains.len() > 32 {
        return Err("too many Program Files toolchain candidates (maximum 32)".to_string());
    }
    let mut toolchains = Vec::new();
    let mut entries = 0usize;
    let preparation = Instant::now();
    for source in &request.toolchains {
        if let Some(plan) = inspect_toolchain(source, package, || {
            ensure_active(jobs, id)?;
            if preparation.elapsed() > Duration::from_secs(30) {
                return Err("toolchain preparation exceeds 30 seconds".to_string());
            }
            Ok(())
        })? {
            entries += plan.files.len().saturating_sub(1);
            if entries > TOOLCHAIN_ENTRIES {
                return Err("inaccessible toolchains exceed 5000 entries per command".to_string());
            }
            toolchains.push(plan);
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
    let mut record = RecoveryRecord {
        name: profile,
        granted: request
            .read_only
            .iter()
            .chain(&request.read_write)
            .filter(|path| Path::new(path).exists())
            .cloned()
            .collect(),
        protected: request
            .deny_write
            .iter()
            .filter(|path| Path::new(path).exists())
            .map(|path| original_inheritance(path))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect(),
        staged,
    };
    // Journal candidate grants before attempting them. A failed grant is safe to revoke idempotently.
    for plan in &toolchains {
        if !plan.stage {
            record.granted.push(plan.source.clone());
        }
    }
    if let Some(staged) = &record.staged {
        record.granted.push(staged.clone());
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
    for path in &cleanup.record.protected {
        set_acl_protected(&path.path, true)?;
    }

    for (paths, access, required) in [
        (&request.read_only, FILE_READ_EXECUTE, false),
        (&request.read_write, FILE_MODIFY, true),
    ] {
        for path in paths {
            if !Path::new(path).exists() {
                continue;
            }
            if let Err(message) = edit_acl(path, sid, access, Change::Grant) {
                if required {
                    return Err(message);
                }
            }
        }
    }
    let mut mappings = Vec::new();
    let mut staging_drive = None;
    let started = Instant::now();
    let mut copied = 0u64;
    for (index, plan) in toolchains.iter_mut().enumerate() {
        if !plan.stage {
            // WRITE_DAC was checked before journaling. A concurrent permissions change can still deny the grant.
            plan.stage = edit_acl(&plan.source, sid, FILE_READ_EXECUTE, Change::Grant).is_err();
        }
        if plan.stage {
            let staged = cleanup
                .record
                .staged
                .as_ref()
                .ok_or("missing staged toolchain root")?;
            let root = Path::new(staged);
            if staging_drive.is_none() {
                fs::create_dir_all(root.parent().ok_or("missing staging parent")?)
                    .map_err(|e| format!("cannot create staging parent: {e}"))?;
                fs::create_dir(root).map_err(|e| format!("cannot create staging root: {e}"))?;
                staging_drive = Some(ProjectDrive::create(staged)?);
            }
            let target = root.join(index.to_string());
            copy_toolchain(plan, &target, started, &mut copied, || {
                ensure_active(jobs, id)
            })?;
            let drive = staging_drive.as_ref().ok_or("missing staging drive")?;
            let prefix = String::from_utf16_lossy(&drive.cwd[..drive.cwd.len() - 1]);
            mappings.push((plan.source.clone(), format!("{prefix}{index}")));
        }
    }
    if let Some(staged) = &cleanup.record.staged {
        if Path::new(staged).exists() {
            edit_acl(staged, sid, FILE_READ_EXECUTE, Change::Grant)?;
        }
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

    let command = mapped_path(&request.command, &mappings);
    let mut cmdline = wide(&command_line(&command, &request.args));
    let application = wide(&command);
    // An ordinary AppContainer cannot traverse a Windows 11 volume root, even when its project
    // itself is granted. A temporary drive makes that project the root without exposing its parents.
    let project_drive = ProjectDrive::create(&request.cwd)?;
    // Process creation in a container fails (ERROR_ENVVAR_NOT_FOUND) without LOCALAPPDATA, which Windows rewrites.
    let mut vars = request.env.clone();
    for (key, value) in &mut vars {
        if key.eq_ignore_ascii_case("PATH") {
            *value = value
                .split(';')
                .map(|entry| mapped_path(entry, &mappings))
                .collect::<Vec<_>>()
                .join(";");
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
    drop(staging_drive);
    // Report cleanup failures rather than claiming success; the journal remains for the next startup to retry.
    cleanup.record.undo(cleanup.sid.0)?;
    fs::remove_file(&cleanup.path)
        .map_err(|e| format!("cannot remove sandbox recovery record: {e}"))?;
    cleanup.finished = true;
    drop(cleanup);
    emitter.send(&Event::Exit {
        id,
        exit_code: code as i64,
        timed_out,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
