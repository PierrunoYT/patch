use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::{
    fs::{MetadataExt, OpenOptionsExt},
    io::AsRawHandle,
};
use std::path::{Path, PathBuf};
use windows::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_READ,
    },
};

pub struct Root {
    path: PathBuf,
    _handle: File,
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
            _handle: directory(path)?,
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
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            file.write_all(bytes)?;
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
            let (Some(file), Some(before)) = (change.file.as_mut(), &change.before) else {
                return Err(invalid("Missing the original content to restore."));
            };
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            file.write_all(before)?;
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
}
