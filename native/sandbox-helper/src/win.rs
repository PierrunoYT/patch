use crate::proto::{encode_event, parse_message, Event, Message, Request};
use crate::text::{command_line, environment_block, Utf8Chunker};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
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
type Jobs = Arc<Mutex<HashMap<u64, usize>>>;

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
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.record.undo(self.sid.0).is_ok() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn run(request: &Request, emitter: &Emitter, jobs: &Jobs) -> Result<()> {
    let id = request.id;
    let record = RecoveryRecord {
        name: profile_name(),
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
    };
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
    let cleanup = Cleanup {
        record,
        sid,
        path,
        _file: file,
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
    // An ordinary AppContainer cannot traverse a Windows 11 volume root, even when its project
    // itself is granted. A temporary drive makes that project the root without exposing its parents.
    let project_drive = ProjectDrive::create(&request.cwd)?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
