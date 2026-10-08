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
                pending.push(
                    root.prepare(parts(&path)?, before, after)
                        .map_err(|e| e.to_string())?,
                );
            }
        }
    }
    for change in &mut pending {
        root.apply(change).map_err(|e| e.to_string())?;
    }
    Ok(files)
}

fn main() {
    let result = (|| {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .map_err(|e| e.to_string())?;
        execute(serde_json::from_str(&input).map_err(|e| format!("Invalid file operation: {e}"))?)
    })();
    let output = match result {
        Ok(files) => serde_json::json!({ "ok": true, "files": files }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    let _ = writeln!(io::stdout(), "{output}");
}
