use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

pub struct Root(File);

pub struct Pending {
    parts: Vec<String>,
    parent: Option<File>,
    file: Option<File>,
    after: Option<Vec<u8>>,
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

    fn parent(&self, parts: &[String], create: bool) -> io::Result<Option<File>> {
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
                    if result < 0
                        && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                    {
                        return Err(io::Error::last_os_error());
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
        let Some(parent) = self.parent(parts, false)? else {
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
        let parent = self.parent(&parts, false)?;
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
            after,
        })
    }

    pub fn apply(&self, change: &mut Pending) -> io::Result<()> {
        let leaf = change.parts.last().unwrap();
        if let Some(bytes) = &change.after {
            if change.file.is_none() {
                if change.parent.is_none() {
                    change.parent = self.parent(&change.parts, true)?;
                }
                // Exclusivity prevents a newly planted link (or an unrelated file) from replacing an absent target.
                change.file = Some(open_at(
                    change.parent.as_ref().unwrap(),
                    leaf,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                )?);
            }
            let file = change.file.as_mut().unwrap();
            regular(file, true)?;
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            file.write_all(bytes)?;
        } else if change.file.is_some() {
            // unlinkat never follows the final component, and parent is an already-opened directory.
            let leaf = name(leaf)?;
            if unsafe {
                libc::unlinkat(
                    change.parent.as_ref().unwrap().as_raw_fd(),
                    leaf.as_ptr(),
                    0,
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
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
}
