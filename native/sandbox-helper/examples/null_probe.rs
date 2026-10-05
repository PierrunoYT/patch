// Read-only diagnostic for fresh null-device opens under the host and AppContainer tokens.
// Never adjusts device mappings or permissions, and never writes to an opened handle.
#[cfg(windows)]
fn main() {
    use serde_json::json;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::Storage::FileSystem::*;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn probe() -> serde_json::Value {
        let mut opens = Vec::new();
        for path in [
            "nul",
            r"\\.\NUL",
            r"\\?\GLOBALROOT\GLOBAL??\NUL",
            r"\\?\GLOBALROOT\Device\Null",
        ] {
            for (mode, access) in [
                ("read", GENERIC_READ.0),
                ("write", GENERIC_WRITE.0),
                ("read-write", GENERIC_READ.0 | GENERIC_WRITE.0),
            ] {
                let name = wide(path);
                let security = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    bInheritHandle: true.into(),
                    ..Default::default()
                };
                let result = unsafe {
                    CreateFileW(
                        PCWSTR(name.as_ptr()),
                        access,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        Some(&security),
                        OPEN_EXISTING,
                        FILE_ATTRIBUTE_NORMAL,
                        None,
                    )
                };
                opens.push(match result {
                    Ok(handle) => {
                        let kind = unsafe { GetFileType(handle) }.0;
                        unsafe {
                            let _ = CloseHandle(handle);
                        }
                        json!({"path": path, "mode": mode, "type": kind})
                    }
                    Err(error) => json!({"path": path, "mode": mode, "error": error.code().0}),
                });
            }
        }
        let name = wide("NUL");
        let mut target = [0u16; 1024];
        let length = unsafe { QueryDosDeviceW(PCWSTR(name.as_ptr()), Some(&mut target)) };
        json!({
            "cwd": std::env::current_dir().ok(),
            "nulTarget": String::from_utf16_lossy(&target[..length as usize]),
            "opens": opens,
        })
    }

    let cwd = probe();
    let temp_change = std::env::set_current_dir(std::env::temp_dir())
        .err()
        .map(|e| e.to_string());
    println!(
        "{}",
        json!({"cwd": cwd, "tempChangeError": temp_change, "temp": probe()})
    );
}

#[cfg(not(windows))]
fn main() {}
