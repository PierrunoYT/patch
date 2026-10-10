use std::cell::RefCell;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
    io::AsRawHandle,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use windows::Win32::{
    Foundation::{LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL},
    Security::{
        Authorization::{GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT},
        GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
        UNPROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{
        FileBasicInfo, FileDispositionInfo, FileRenameInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_BASIC_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_RENAME_INFO, FILE_SHARE_READ,
        FILE_SHARE_WRITE, WRITE_DAC,
    },
};

pub struct Root {
    path: PathBuf,
    // In a cell so a replacement can swap it for a handle that shares writing (`share_writes`).
    handle: RefCell<File>,
}

pub struct Pending {
    parts: Vec<String>,
    path: PathBuf,
    _parents: Vec<File>,
    file: Option<File>,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    // What apply did, so undo can put it back (#242).
    created_dirs: Vec<PathBuf>,
    created_file: bool,
    written: bool,
    deleted: bool,
}

// Marks the file behind a handle for deletion when its last handle closes, or takes the mark back.
fn set_delete_on_close(file: &File, delete: bool) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO {
        DeleteFile: delete.into(),
    };
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            &disposition as *const _ as *const _,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(|e| invalid(&e.to_string()))
}

// Read, write and DELETE, so a file this helper created can be removed again through its own handle.
const CREATED_FILE_ACCESS: u32 = 0x8000_0000 | 0x4000_0000 | 0x0001_0000;

// Attributes a replacement keeps from the file it replaces: hidden, system, archive, not content indexed.
const KEPT_ATTRIBUTES: u32 = 0x2 | 0x4 | 0x20 | 0x2000;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn basic_info(file: &File) -> io::Result<FILE_BASIC_INFO> {
    let mut info = FILE_BASIC_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileBasicInfo,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    }
    .map_err(|e| invalid(&e.to_string()))?;
    Ok(info)
}

// Gives `to` the permissions of `from`, protected from inheritance when they were, so a replacement is exactly as
// writable as the file it replaces. The Windows sandbox protects some project files with their own permissions while a
// command runs; a fresh file would inherit the project's write grant instead.
fn copy_permissions(from: &File, to: &File) -> io::Result<()> {
    unsafe {
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let status = GetSecurityInfo(
            HANDLE(from.as_raw_handle()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        );
        if status != ERROR_SUCCESS {
            return Err(invalid(&format!(
                "cannot read the file's permissions (error {})",
                status.0
            )));
        }
        let result = (|| {
            let mut control = 0u16;
            let mut revision = 0u32;
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision)
                .map_err(|e| invalid(&e.to_string()))?;
            let protected = control & SE_DACL_PROTECTED.0 != 0;
            let status = SetSecurityInfo(
                HANDLE(to.as_raw_handle()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION
                    | if protected {
                        PROTECTED_DACL_SECURITY_INFORMATION
                    } else {
                        UNPROTECTED_DACL_SECURITY_INFORMATION
                    },
                None,
                None,
                (!dacl.is_null()).then_some(dacl as *const ACL),
                None,
            );
            if status != ERROR_SUCCESS {
                return Err(invalid(&format!(
                    "cannot copy the file's permissions (error {})",
                    status.0
                )));
            }
            Ok(())
        })();
        LocalFree(Some(HLOCAL(descriptor.0)));
        result
    }
}

// Renames the file behind `file` to `target`, replacing what is there.
fn rename_over(file: &File, target: &Path) -> io::Result<()> {
    let name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let size = std::mem::size_of::<FILE_RENAME_INFO>() + name.len() * 2;
    // u64 words keep the structure aligned.
    let mut buffer = vec![0u64; size.div_ceil(8)];
    unsafe {
        let info = buffer.as_mut_ptr() as *mut FILE_RENAME_INFO;
        (*info).Anonymous.ReplaceIfExists = true;
        (*info).RootDirectory = HANDLE::default();
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileRenameInfo,
            info as *const _,
            size as u32,
        )
    }
    .map_err(|e| io::Error::from_raw_os_error(e.code().0 & 0xFFFF))
}

fn write_in_place(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(bytes)
}

// Opens the target again after a failed replacement, as prepare does, and checks it still holds `expected`.
fn reopen(path: &Path, expected: &[u8]) -> io::Result<File> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    regular(&file, true)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if bytes != expected {
        return Err(invalid("File changed during the operation; read it again."));
    }
    Ok(file)
}

fn identity(file: &File) -> io::Result<(u32, u32, u32)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|e| invalid(&e.to_string()))?;
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

// Renaming a file into a folder opens the folder for writing, which a held folder handle does not share. Swaps the
// handle for one of the same folder that shares writing but still not deletion: the folder still cannot be renamed or
// replaced, and NTFS refuses to make a folder that is not empty a reparse point, and this one holds the file being
// replaced. Only done for an existing file's folder: a folder this helper just created is empty for a moment.
fn share_writes(held: &mut File, path: &Path) -> io::Result<()> {
    let shared = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    let metadata = shared.metadata()?;
    if !metadata.is_dir()
        || metadata.file_attributes() & 0x400 != 0
        || identity(&shared)? != identity(held)?
    {
        return Err(invalid("File operation refused a replaced folder."));
    }
    *held = shared;
    Ok(())
}

// Replaces the content of the existing file in `change` with `bytes`: written to a new file next to it, flushed and
// renamed over it, so a crash or power loss leaves the old file or the new one, never a short one (#259). The new file
// keeps the old one's permissions, attributes and creation time. When no file can be created next to it, or another
// program holds it open so that it cannot be replaced, it is written in place as before. `expected` is its content now.
fn replace(root: &Root, change: &mut Pending, bytes: &[u8], expected: &[u8]) -> io::Result<()> {
    let dir = change
        .path
        .parent()
        .ok_or_else(|| invalid("File has no parent folder."))?;
    let temp_path = dir.join(format!(
        ".patch-tmp-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let old = change
        .file
        .as_mut()
        .ok_or_else(|| invalid("Missing the file to replace."))?;
    let mut temp = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(CREATED_FILE_ACCESS | WRITE_DAC.0)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(&temp_path)
    {
        Ok(temp) => temp,
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return write_in_place(old, bytes),
        Err(e) => return Err(e),
    };
    let prepared = (|| {
        temp.write_all(bytes)?;
        copy_permissions(old, &temp)?;
        let info = basic_info(old)?;
        let kept = FILE_BASIC_INFO {
            CreationTime: info.CreationTime,
            FileAttributes: info.FileAttributes & KEPT_ATTRIBUTES,
            ..Default::default()
        };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(temp.as_raw_handle()),
                FileBasicInfo,
                &kept as *const _ as *const _,
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        }
        .map_err(|e| invalid(&e.to_string()))?;
        temp.sync_all()
    })();
    if let Err(e) = prepared {
        let _ = set_delete_on_close(&temp, true);
        return Err(e);
    }
    let shared = match change._parents.last_mut() {
        Some(parent) => share_writes(parent, dir),
        None => share_writes(&mut root.handle.borrow_mut(), dir),
    };
    if let Err(e) = shared {
        let _ = set_delete_on_close(&temp, true);
        return Err(e);
    }
    // The held handle shares no delete access, which keeps other programs from replacing the file and would stop this
    // rename too, so it is closed first. Whatever takes the name in between is replaced, never followed.
    change.file = None;
    match rename_over(&temp, &change.path) {
        Ok(()) => {
            change.file = Some(temp);
            Ok(())
        }
        Err(e) => {
            let _ = set_delete_on_close(&temp, true);
            drop(temp);
            // Access denied or a sharing violation: another program has the file open.
            if e.raw_os_error() != Some(5) && e.raw_os_error() != Some(32) {
                return Err(e);
            }
            let mut file = reopen(&change.path, expected)?;
            write_in_place(&mut file, bytes)?;
            change.file = Some(file);
            Ok(())
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

// Retain every directory handle without FILE_SHARE_WRITE/DELETE. While held, another process cannot rename it,
// replace it with a junction, or open it for a reparse-point mutation. Ordinary access to its children still works.
fn directory(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err(invalid("File operation refused a directory reparse point."));
    }
    Ok(file)
}

fn regular(file: &File, writable: bool) -> io::Result<()> {
    let metadata = file.metadata()?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|e| invalid(&e.to_string()))?;
    if !metadata.is_file()
        || metadata.file_attributes() & 0x400 != 0
        || (writable && info.nNumberOfLinks != 1)
    {
        return Err(invalid(
            "File operation refused a non-regular, reparse-point or hard-linked target.",
        ));
    }
    Ok(())
}

impl Root {
    pub fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(invalid("Project root must be absolute."));
        }
        Ok(Self {
            path: path.to_owned(),
            handle: RefCell::new(directory(path)?),
        })
    }

    // Folders it creates (with `create`) are added to `created`, outermost first.
    fn parent(
        &self,
        parts: &[String],
        create: bool,
        created: &mut Vec<PathBuf>,
    ) -> io::Result<(PathBuf, Vec<File>)> {
        let mut path = self.path.clone();
        let mut handles = Vec::new();
        for component in &parts[..parts.len() - 1] {
            path.push(component);
            match directory(&path) {
                Ok(handle) => handles.push(handle),
                Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                    match std::fs::create_dir(&path) {
                        Ok(()) => created.push(path.clone()),
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                        Err(e) => return Err(e),
                    }
                    handles.push(directory(&path)?);
                }
                Err(e) => return Err(e),
            }
        }
        path.push(parts.last().unwrap());
        Ok((path, handles))
    }

    pub fn read(&self, parts: &[String]) -> io::Result<Option<Vec<u8>>> {
        let (path, _parents) = match self.parent(parts, false, &mut Vec::new()) {
            Ok(value) => value,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut file = match OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        regular(&file, false)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    pub fn prepare(
        &self,
        parts: Vec<String>,
        before: Option<Vec<u8>>,
        after: Option<Vec<u8>>,
    ) -> io::Result<Pending> {
        let (path, parents) = match self.parent(&parts, false, &mut Vec::new()) {
            Ok(value) => value,
            Err(e) if e.kind() == io::ErrorKind::NotFound && before.is_none() => {
                return Ok(Pending {
                    path: self.path.join(parts.join("\\")),
                    parts,
                    _parents: Vec::new(),
                    file: None,
                    before,
                    after,
                    created_dirs: Vec::new(),
                    created_file: false,
                    written: false,
                    deleted: false,
                })
            }
            Err(e) => return Err(e),
        };
        let mut options = OpenOptions::new();
        options
            .read(true)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
        if after.is_some() {
            options.write(true);
        } else {
            options.access_mode(FILE_GENERIC_READ.0 | 0x10000);
        } // DELETE, for handle-based disposition.
        let mut file = match options.open(&path) {
            Ok(file) => Some(file),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let current = if let Some(file) = &mut file {
            regular(file, true)?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Some(bytes)
        } else {
            None
        };
        if current != before {
            return Err(invalid("File changed before the operation; read it again."));
        }
        Ok(Pending {
            parts,
            path,
            _parents: parents,
            file,
            before,
            after,
            created_dirs: Vec::new(),
            created_file: false,
            written: false,
            deleted: false,
        })
    }

    pub fn apply(&self, change: &mut Pending) -> io::Result<()> {
        if let Some(bytes) = &change.after {
            if change.file.is_none() {
                // Rewalk (and retain) any previously missing parents before creating the file exclusively.
                let (path, parents) = self.parent(&change.parts, true, &mut change.created_dirs)?;
                change.path = path;
                change._parents = parents;
                change.file = Some(
                    OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .access_mode(CREATED_FILE_ACCESS)
                        .share_mode(FILE_SHARE_READ.0)
                        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
                        .open(&change.path)?,
                );
                change.created_file = true;
            }
            let file = change.file.as_mut().unwrap();
            regular(file, true)?;
            change.written = true;
            if change.created_file {
                // A new file holds nothing yet, so there is nothing a crash could cut short.
                file.write_all(bytes)?;
            } else {
                let (bytes, before) = (bytes.clone(), change.before.clone().unwrap_or_default());
                replace(self, change, &bytes, &before)?;
            }
        } else if let Some(file) = &change.file {
            // The file goes when the handle closes at the end of the request, so undo can still keep it.
            set_delete_on_close(file, true)?;
            change.deleted = true;
        }
        Ok(())
    }

    // Puts back what apply did when a later change in the same request failed (#242): an edited file gets its old
    // bytes, a created file and the folders created for it are removed, and a deletion is taken back.
    pub fn undo(&self, change: &mut Pending) -> io::Result<()> {
        if change.deleted {
            if let Some(file) = &change.file {
                set_delete_on_close(file, false)?;
            }
            change.deleted = false;
        } else if change.created_file {
            if let Some(file) = change.file.take() {
                set_delete_on_close(&file, true)?;
            }
            change.created_file = false;
            // The folders' own handles are closed first; a folder another change still uses stays.
            change._parents.clear();
            for dir in change.created_dirs.drain(..).rev() {
                let _ = std::fs::remove_dir(dir);
            }
        } else if change.written {
            let (Some(before), Some(after)) = (change.before.clone(), change.after.clone()) else {
                return Err(invalid("Missing the original content to restore."));
            };
            replace(self, change, &before, &after)?;
            change.written = false;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_handles_block_parent_and_target_replacement() {
        let base = std::env::temp_dir().join(format!("patch-file-handles-{}", std::process::id()));
        let project = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir_all(project.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(project.join("sub/x"), b"inside").unwrap();
        std::fs::write(outside.join("x"), b"outside").unwrap();
        let root = Root::open(&project).unwrap();
        let mut change = root
            .prepare(
                vec!["sub".into(), "x".into()],
                Some(b"inside".to_vec()),
                Some(b"updated".to_vec()),
            )
            .unwrap();
        assert!(std::fs::rename(project.join("sub"), project.join("held")).is_err());
        assert!(std::fs::rename(project.join("sub/x"), outside.join("moved")).is_err());
        assert!(std::fs::write(project.join("sub/x"), b"replacement").is_err());
        root.apply(&mut change).unwrap();
        assert_eq!(std::fs::read(project.join("sub/x")).unwrap(), b"updated");
        // The replacement is held like the file it replaced, and no temporary file is left (#259).
        assert!(std::fs::rename(project.join("sub/x"), outside.join("moved")).is_err());
        assert!(std::fs::rename(project.join("sub"), project.join("held")).is_err());
        assert_eq!(std::fs::read_dir(project.join("sub")).unwrap().count(), 1);
        drop(change);
        let mut deletion = root
            .prepare(
                vec!["sub".into(), "x".into()],
                Some(b"updated".to_vec()),
                None,
            )
            .unwrap();
        assert!(std::fs::rename(project.join("sub"), project.join("held")).is_err());
        root.apply(&mut deletion).unwrap();
        assert_eq!(std::fs::read(outside.join("x")).unwrap(), b"outside");
        // The file goes when the request ends and its handle closes, so a failure before that could keep it (#242).
        drop(deletion);
        assert!(!project.join("sub/x").exists());
        drop(root);
        // The same rename succeeds once the helper releases its handles.
        std::fs::rename(project.join("sub"), project.join("held")).unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }

    fn file_id(path: &Path) -> u64 {
        let file = File::open(path).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.unwrap();
        (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64
    }

    fn acl(path: &Path) -> String {
        let output = std::process::Command::new("icacls")
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn a_replacement_keeps_protected_permissions_and_undo_restores_the_bytes() {
        let base = std::env::temp_dir().join(format!("patch-file-replace-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("AGENTS.md");
        std::fs::write(&file, b"rules").unwrap();
        // Protected from inheritance, as the Windows sandbox leaves a protected project file while a command runs.
        let status = std::process::Command::new("icacls")
            .arg(&file)
            .arg("/inheritance:d")
            .output()
            .unwrap()
            .status;
        assert!(status.success());
        assert!(!acl(&file).contains("(I)"));
        let root = Root::open(&base).unwrap();
        let mut change = root
            .prepare(
                vec!["AGENTS.md".into()],
                Some(b"rules".to_vec()),
                Some(b"new rules".to_vec()),
            )
            .unwrap();
        let original = file_id(&file);
        root.apply(&mut change).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new rules");
        // A new file took its place, rather than the old one being cut short and rewritten.
        assert_ne!(file_id(&file), original);
        // A fresh file would have inherited the folder's permissions.
        assert!(!acl(&file).contains("(I)"), "{}", acl(&file));
        root.undo(&mut change).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"rules");
        assert!(!acl(&file).contains("(I)"));
        drop(change);
        drop(root);
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 1);
        std::fs::remove_dir_all(base).unwrap();
    }
}
