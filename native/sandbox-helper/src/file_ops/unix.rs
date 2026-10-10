use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct Root(File);

pub struct Pending {
    parts: Vec<String>,
    parent: Option<File>,
    file: Option<File>,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    // What apply did, so undo can put it back (#242).
    created_dirs: Vec<(File, String)>,
    created_file: bool,
    written: bool,
    deleted: bool,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn name(value: &str) -> io::Result<CString> {
    CString::new(value).map_err(|_| invalid("Invalid file name."))
}

fn open_at(parent: &File, leaf: &str, flags: i32) -> io::Result<File> {
    let leaf = name(leaf)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            leaf.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o666,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn write_in_place(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(bytes)
}

// Replaces the content of the existing file in `change` with `bytes`: written to a new file in the same (held) folder,
// flushed and renamed over it, so a crash or power loss leaves the old file or the new one, never a short one (#259).
// The new file gets the old one's mode, and its owner where that is allowed. When no file can be created in the folder
// (it is not writable), it is written in place as before.
fn replace(change: &mut Pending, bytes: &[u8]) -> io::Result<()> {
    let leaf = change.parts.last().unwrap().clone();
    let (Some(parent), Some(old)) = (change.parent.as_ref(), change.file.as_mut()) else {
        return Err(invalid("Missing the file to replace."));
    };
    let temp_name = format!(
        ".patch-tmp-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut temp = match open_at(
        parent,
        &temp_name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
    ) {
        Ok(temp) => temp,
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(libc::EACCES | libc::EPERM | libc::EROFS)
            ) =>
        {
            return write_in_place(old, bytes)
        }
        Err(e) => return Err(e),
    };
    let result = (|| {
        temp.write_all(bytes)?;
        let stat = old.metadata()?;
        // Only root may give a file to another owner, so this succeeds for the user's own files and is skipped
        // otherwise. It comes before the mode, because changing the owner clears set-user-ID bits.
        let _ = unsafe { libc::fchown(temp.as_raw_fd(), stat.uid(), stat.gid()) };
        temp.set_permissions(std::fs::Permissions::from_mode(stat.mode() & 0o7777))?;
        temp.sync_all()?;
        rename_at(parent, &temp_name, &leaf)
    })();
    if let Err(e) = result {
        let _ = unlink_at(parent, &temp_name, 0);
        return Err(e);
    }
    change.file = Some(temp);
    Ok(())
}

fn regular(file: &File, writable: bool) -> io::Result<()> {
    let stat = file.metadata()?;
    if !stat.is_file() || (writable && stat.nlink() != 1) {
        return Err(invalid(
            "File operation refused a non-regular or hard-linked target.",
        ));
    }
    Ok(())
}

impl Root {
    pub fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(invalid("Project root must be absolute."));
        }
        // Canonical ancestors above the stored root may include system aliases (/tmp on macOS), but the root itself
        // may never be a link substituted since the project was opened.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        Ok(Self(file))
    }

    // Folders it creates (with `create`) are added to `created` as (parent, name), outermost first.
    fn parent(
        &self,
        parts: &[String],
        create: bool,
        created: &mut Vec<(File, String)>,
    ) -> io::Result<Option<File>> {
        let mut parent = self.0.try_clone()?;
        for component in &parts[..parts.len() - 1] {
            let child = open_at(&parent, component, libc::O_RDONLY | libc::O_DIRECTORY);
            parent = match child {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                    let component_name = name(component)?;
                    let result = unsafe {
                        libc::mkdirat(parent.as_raw_fd(), component_name.as_ptr(), 0o777)
                    };
                    if result < 0 {
                        if io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                            return Err(io::Error::last_os_error());
                        }
                    } else {
                        created.push((parent.try_clone()?, component.clone()));
                    }
                    open_at(&parent, component, libc::O_RDONLY | libc::O_DIRECTORY)?
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e),
            };
        }
        Ok(Some(parent))
    }

    pub fn read(&self, parts: &[String]) -> io::Result<Option<Vec<u8>>> {
        let Some(parent) = self.parent(parts, false, &mut Vec::new())? else {
            return Ok(None);
        };
        let mut file = match open_at(
            &parent,
            parts.last().unwrap(),
            libc::O_RDONLY | libc::O_NONBLOCK,
        ) {
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
        let parent = self.parent(&parts, false, &mut Vec::new())?;
        let mut file = match &parent {
            Some(parent) => match open_at(
                parent,
                parts.last().unwrap(),
                libc::O_RDWR | libc::O_NONBLOCK,
            ) {
                Ok(file) => Some(file),
                Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                Err(e) => return Err(e),
            },
            None => None,
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
            parent,
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
        let leaf = change.parts.last().unwrap();
        if let Some(bytes) = &change.after {
            if change.file.is_none() {
                if change.parent.is_none() {
                    change.parent = self.parent(&change.parts, true, &mut change.created_dirs)?;
                }
                change.file = Some(open_at(
                    change.parent.as_ref().unwrap(),
                    leaf,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                )?);
                change.created_file = true;
            }
            let file = change.file.as_mut().unwrap();
            regular(file, true)?;
            change.written = true;
            if change.created_file {
                // A new file holds nothing yet, so there is nothing a crash could cut short.
                file.write_all(bytes)?;
            } else {
                let bytes = bytes.clone();
                replace(change, &bytes)?;
            }
        } else if change.file.is_some() {
            unlink_at(change.parent.as_ref().unwrap(), leaf, 0)?;
            change.deleted = true;
        }
        Ok(())
    }

    // Puts back what apply did when a later change in the same request failed (#242): an edited file gets its old
    // bytes, a created file and the folders created for it are removed, and a deleted file is written again with its
    // old bytes and mode.
    pub fn undo(&self, change: &mut Pending) -> io::Result<()> {
        let leaf = change.parts.last().unwrap().clone();
        if change.deleted {
            let (Some(parent), Some(before)) = (change.parent.as_ref(), &change.before) else {
                return Err(invalid("Missing the original content to restore."));
            };
            let mut restored =
                open_at(parent, &leaf, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
            restored.write_all(before)?;
            if let Some(old) = &change.file {
                let mode = old.metadata()?.mode() & 0o7777;
                restored.set_permissions(std::fs::Permissions::from_mode(mode))?;
            }
            change.deleted = false;
        } else if change.created_file {
            if let Some(parent) = change.parent.as_ref() {
                unlink_at(parent, &leaf, 0)?;
            }
            change.file = None;
            change.created_file = false;
            // A folder another change still uses is not empty and stays.
            for (parent, dir) in change.created_dirs.drain(..).rev() {
                let _ = unlink_at(&parent, &dir, libc::AT_REMOVEDIR);
            }
        } else if change.written {
            let Some(before) = change.before.clone() else {
                return Err(invalid("Missing the original content to restore."));
            };
            replace(change, &before)?;
            change.written = false;
        }
        Ok(())
    }
}

fn rename_at(parent: &File, from: &str, to: &str) -> io::Result<()> {
    let (from, to) = (name(from)?, name(to)?);
    let fd = parent.as_raw_fd();
    if unsafe { libc::renameat(fd, from.as_ptr(), fd, to.as_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn unlink_at(parent: &File, leaf: &str, flags: i32) -> io::Result<()> {
    let leaf = name(leaf)?;
    if unsafe { libc::unlinkat(parent.as_raw_fd(), leaf.as_ptr(), flags) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn an_open_parent_cannot_be_redirected_by_a_replacement_link() {
        let base = std::env::temp_dir().join(format!("patch-file-handles-{}", std::process::id()));
        let root = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("sub/x"), b"inside").unwrap();
        std::fs::write(outside.join("x"), b"outside").unwrap();
        let executor = Root::open(&root).unwrap();
        let mut change = executor
            .prepare(
                vec!["sub".into(), "x".into()],
                Some(b"inside".to_vec()),
                Some(b"updated".to_vec()),
            )
            .unwrap();
        std::fs::rename(root.join("sub"), root.join("held")).unwrap();
        symlink(&outside, root.join("sub")).unwrap();
        executor.apply(&mut change).unwrap();
        assert_eq!(std::fs::read(outside.join("x")).unwrap(), b"outside");
        assert_eq!(std::fs::read(root.join("held/x")).unwrap(), b"updated");
        assert!(executor.read(&["sub".into(), "x".into()]).is_err());
        let mut deletion = executor
            .prepare(
                vec!["held".into(), "x".into()],
                Some(b"updated".to_vec()),
                None,
            )
            .unwrap();
        std::fs::rename(root.join("held"), root.join("gone")).unwrap();
        symlink(&outside, root.join("held")).unwrap();
        executor.apply(&mut deletion).unwrap();
        assert_eq!(std::fs::read(outside.join("x")).unwrap(), b"outside");
        assert!(!root.join("gone/x").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_replacement_is_a_new_file_with_the_old_mode_and_undo_restores_the_bytes() {
        let base = std::env::temp_dir().join(format!("patch-file-replace-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("run.sh");
        std::fs::write(&file, b"old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o750)).unwrap();
        let inode = std::fs::metadata(&file).unwrap().ino();
        let executor = Root::open(&base).unwrap();
        let mut change = executor
            .prepare(
                vec!["run.sh".into()],
                Some(b"old".to_vec()),
                Some(b"new".to_vec()),
            )
            .unwrap();
        executor.apply(&mut change).unwrap();
        let after = std::fs::metadata(&file).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        // A new file took its place (#259), with the same mode, and no temporary file is left.
        assert_ne!(after.ino(), inode);
        assert_eq!(after.mode() & 0o7777, 0o750);
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 1);
        executor.undo(&mut change).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"old");
        assert_eq!(std::fs::metadata(&file).unwrap().mode() & 0o7777, 0o750);
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 1);
        std::fs::remove_dir_all(base).unwrap();
    }
}
