// One bounded request per process. Directory handles, not checked path strings, own all mutations (#144).
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::io::{self, Read, Write};
use std::path::{Component, Path};

#[cfg(unix)]
#[path = "file_ops/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "file_ops/windows.rs"]
mod platform;

// The largest file the file tools read or write, and the largest request (Base64 inflates content by a third). Both
// are checked here, before anything is buffered whole, not only by the caller's own limits (#297).
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES: u64 = 128 * 1024 * 1024;

fn too_large() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "The file is larger than 16 MB, the most the file tools read or change.",
    )
}

// Reads a whole file, refusing one larger than MAX_FILE_BYTES without reading past the limit.
fn read_limited(file: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    Read::take(&mut *file, MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    root: String,
    operations: Vec<Operation>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Read {
        path: String,
    },
    Change {
        path: String,
        before: Option<String>,
        after: Option<String>,
    },
}

fn parts(path: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for part in Path::new(path).components() {
        let Component::Normal(name) = part else {
            return Err("File operation requires a confined relative path.".into());
        };
        let name = name.to_str().ok_or("Invalid file name.")?;
        if name.contains('\0') {
            return Err("Invalid file name.".into());
        }
        #[cfg(windows)]
        if name.contains(':') || name.ends_with(['.', ' ']) {
            return Err(
                "Windows aliases and alternate streams are not file-operation targets.".into(),
            );
        }
        result.push(name.to_owned());
    }
    if result.is_empty() {
        return Err("A file path is required.".into());
    }
    Ok(result)
}

fn execute(request: Request) -> Result<Vec<Option<String>>, String> {
    let root = platform::Root::open(Path::new(&request.root)).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    let mut pending = Vec::new();
    // Validate and acquire every existing target before performing any mutations.
    for operation in request.operations {
        match operation {
            Operation::Read { path } => {
                let file = root.read(&parts(&path)?).map_err(|e| e.to_string())?;
                files.push(file.map(|bytes| STANDARD.encode(bytes)));
            }
            Operation::Change {
                path,
                before,
                after,
            } => {
                let before = before
                    .map(|s| STANDARD.decode(s))
                    .transpose()
                    .map_err(|e| e.to_string())?;
                let after = after
                    .map(|s| STANDARD.decode(s))
                    .transpose()
                    .map_err(|e| e.to_string())?;
                if after
                    .as_ref()
                    .is_some_and(|bytes| bytes.len() as u64 > MAX_FILE_BYTES)
                {
                    return Err(too_large().to_string());
                }
                pending.push(
                    root.prepare(parts(&path)?, before, after)
                        .map_err(|e| e.to_string())?,
                );
            }
        }
    }
    apply_all(&root, &mut pending)?;
    Ok(files)
}

// Applies every change, or none: when one fails (an I/O error, a name the system refuses), the changes already made,
// and whatever the failed one did, are undone in reverse order, so a failing patch leaves the project as it was (#242).
fn apply_all(root: &platform::Root, pending: &mut [platform::Pending]) -> Result<(), String> {
    for index in 0..pending.len() {
        let Err(error) = root.apply(&mut pending[index]) else {
            continue;
        };
        let failed: Vec<String> = pending[..=index]
            .iter_mut()
            .rev()
            .filter_map(|change| root.undo(change).err().map(|e| e.to_string()))
            .collect();
        return Err(if failed.is_empty() {
            format!("{error} No file was changed.")
        } else {
            format!(
                "{error} Undoing the earlier changes failed too, so some files may be changed: {}",
                failed.join("; ")
            )
        });
    }
    Ok(())
}

fn main() {
    let result = (|| {
        let mut input = String::new();
        io::stdin()
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_string(&mut input)
            .map_err(|e| e.to_string())?;
        if input.len() as u64 > MAX_REQUEST_BYTES {
            return Err("The file operation is too large.".to_string());
        }
        execute(serde_json::from_str(&input).map_err(|e| format!("Invalid file operation: {e}"))?)
    })();
    let output = match result {
        Ok(files) => serde_json::json!({ "ok": true, "files": files }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    let _ = writeln!(io::stdout(), "{output}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_only_files_up_to_the_size_limit() {
        let base = std::env::temp_dir().join(format!("patch-file-limit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let limit = MAX_FILE_BYTES as usize;
        std::fs::write(base.join("fits.bin"), vec![b'a'; limit]).unwrap();
        // Sparse on most file systems: the helper must refuse it without reading it whole.
        let big = std::fs::File::create(base.join("big.bin")).unwrap();
        big.set_len(MAX_FILE_BYTES * 64).unwrap();
        drop(big);
        let root = platform::Root::open(&base).unwrap();
        assert_eq!(
            root.read(&["fits.bin".into()]).unwrap().unwrap().len(),
            limit
        );
        let refused = root.read(&["big.bin".into()]).unwrap_err();
        assert!(refused.to_string().contains("larger than 16 MB"));
        assert!(root.prepare(vec!["big.bin".into()], None, None).is_err());
        drop(root);
        let request = |after: &[u8]| Request {
            root: base.to_string_lossy().into_owned(),
            operations: vec![Operation::Change {
                path: "new.bin".into(),
                before: None,
                after: Some(STANDARD.encode(after)),
            }],
        };
        let refused = execute(request(&vec![b'b'; limit + 1])).unwrap_err();
        assert!(refused.contains("larger than 16 MB"));
        assert!(!base.join("new.bin").exists());
        execute(request(b"small")).unwrap();
        assert_eq!(std::fs::read(base.join("new.bin")).unwrap(), b"small");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_failing_change_undoes_the_ones_before_it() {
        let base = std::env::temp_dir().join(format!("patch-file-undo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.txt"), b"one").unwrap();
        std::fs::write(base.join("gone.txt"), b"keep me").unwrap();
        let root = platform::Root::open(&base).unwrap();
        let part = |path: &str| path.split('/').map(String::from).collect::<Vec<_>>();
        let mut pending = vec![
            root.prepare(part("a.txt"), Some(b"one".to_vec()), Some(b"ONE".to_vec()))
                .unwrap(),
            root.prepare(part("gone.txt"), Some(b"keep me".to_vec()), None)
                .unwrap(),
            root.prepare(part("new/sub/n.txt"), None, Some(b"new".to_vec()))
                .unwrap(),
            root.prepare(part("blocked/f.txt"), None, Some(b"x".to_vec()))
                .unwrap(),
        ];
        // Something takes the folder's name after the checks, so the last change fails while it is applied.
        std::fs::write(base.join("blocked"), b"a file, not a folder").unwrap();

        let error = apply_all(&root, &mut pending).unwrap_err();
        assert!(error.ends_with("No file was changed."), "{error}");
        drop(pending);
        drop(root);
        assert_eq!(std::fs::read(base.join("a.txt")).unwrap(), b"one");
        assert_eq!(std::fs::read(base.join("gone.txt")).unwrap(), b"keep me");
        assert!(!base.join("new").exists());
        assert_eq!(
            std::fs::read(base.join("blocked")).unwrap(),
            b"a file, not a folder"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn changes_that_all_succeed_stay_applied() {
        let base = std::env::temp_dir().join(format!("patch-file-apply-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.txt"), b"one").unwrap();
        std::fs::write(base.join("gone.txt"), b"bye").unwrap();
        let root = platform::Root::open(&base).unwrap();
        let mut pending = vec![
            root.prepare(
                vec!["a.txt".into()],
                Some(b"one".to_vec()),
                Some(b"ONE".to_vec()),
            )
            .unwrap(),
            root.prepare(vec!["gone.txt".into()], Some(b"bye".to_vec()), None)
                .unwrap(),
            root.prepare(
                vec!["d".into(), "n.txt".into()],
                None,
                Some(b"new".to_vec()),
            )
            .unwrap(),
        ];
        apply_all(&root, &mut pending).unwrap();
        drop(pending);
        drop(root);
        assert_eq!(std::fs::read(base.join("a.txt")).unwrap(), b"ONE");
        assert!(!base.join("gone.txt").exists());
        assert_eq!(std::fs::read(base.join("d/n.txt")).unwrap(), b"new");
        std::fs::remove_dir_all(base).unwrap();
    }
}
