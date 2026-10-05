// CI host preparation only; not linked into or shipped with sandbox-helper.exe.
// Older Windows Server builds omit AppContainer access to the null device. See:
// https://github.com/microsoft/mxc/blob/main/docs/host-prep.md#null-device-acl
// Preserve the host descriptor; add only ordinary AppContainer read/write/execute on this one device.
#[cfg(windows)]
mod prep {
    use std::ffi::c_void;
    use windows::core::{w, PWSTR};
    use windows::Win32::Foundation::*;
    use windows::Win32::Security::Authorization::*;
    use windows::Win32::Security::*;
    use windows::Win32::Storage::FileSystem::*;

    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0)));
            }
        }
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    // Allocate a new ACL, leaving all existing entries intact. No object permissions are changed here.
    unsafe fn with_appcontainers(acl: *const ACL) -> windows::core::Result<Local> {
        let mut sid = PSID::default();
        ConvertStringSidToSidW(w!("S-1-15-2-1"), &mut sid)?;
        let _sid = Local(sid.0);
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_GENERIC_READ.0
                | FILE_GENERIC_WRITE.0
                | FILE_GENERIC_EXECUTE.0,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: PWSTR(sid.0.cast()),
                ..Default::default()
            },
        };
        let mut updated = std::ptr::null_mut();
        SetEntriesInAclW(Some(&[entry]), Some(acl), &mut updated).ok()?;
        Ok(Local(updated.cast()))
    }

    pub fn run() -> windows::core::Result<()> {
        unsafe {
            let handle = Handle(CreateFileW(
                w!(r"\\.\NUL"),
                (READ_CONTROL | WRITE_DAC).0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )?);
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let mut acl = std::ptr::null_mut();
            GetSecurityInfo(
                handle.0,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut acl),
                None,
                Some(&mut descriptor),
            )
            .ok()?;
            let _descriptor = Local(descriptor.0);
            // A null DACL already allows access. Do not replace it with a restrictive DACL.
            if !acl.is_null() {
                let updated = with_appcontainers(acl)?;
                SetSecurityInfo(
                    handle.0,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    Some(updated.0.cast()),
                    None,
                )
                .ok()?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn preserves_existing_grants_and_adds_only_null_device_access_idempotently() {
            unsafe {
                let mut descriptor = PSECURITY_DESCRIPTOR::default();
                // Distinct masks catch accidentally replacing all grants with the new package grant.
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    w!("D:(A;;FA;;;SY)(A;;FR;;;WD)"),
                    1,
                    &mut descriptor,
                    None,
                )
                .unwrap();
                let _descriptor = Local(descriptor.0);
                let mut acl = std::ptr::null_mut();
                let mut present = false.into();
                let mut defaulted = false.into();
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
                    .unwrap();
                let first = with_appcontainers(acl).unwrap();
                let second = with_appcontainers(first.0.cast()).unwrap();
                for updated in [&first, &second] {
                    let acl = updated.0.cast::<ACL>();
                    assert_eq!((*acl).AceCount, 3);
                    let mut entries = std::collections::BTreeMap::new();
                    for index in 0..(*acl).AceCount {
                        let mut ace = std::ptr::null_mut();
                        GetAce(acl, index as u32, &mut ace).unwrap();
                        let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                        assert_eq!(ace.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
                        assert_eq!(ace.Header.AceFlags, 0); // no inheritance
                        let mut name = PWSTR::null();
                        ConvertSidToStringSidW(
                            PSID((&ace.SidStart as *const u32).cast_mut().cast()),
                            &mut name,
                        )
                        .unwrap();
                        let _name = Local(name.0.cast());
                        entries.insert(name.to_string().unwrap(), ace.Mask);
                    }
                    assert_eq!(entries.len(), 3);
                    assert_eq!(entries["S-1-5-18"], FILE_ALL_ACCESS.0);
                    assert_eq!(entries["S-1-1-0"], FILE_GENERIC_READ.0);
                    assert_eq!(
                        entries["S-1-15-2-1"],
                        FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0
                    );
                }
            }
        }
    }
}

fn main() {
    // Refuse local machines and self-hosted runners. Applying host-wide ACLs is deliberate CI provisioning,
    // never an implicit consequence of running a test or starting Patch.
    if std::env::args().nth(1).as_deref() != Some("--apply-ci")
        || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || std::env::var("RUNNER_ENVIRONMENT").as_deref() != Ok("github-hosted")
    {
        eprintln!("Requires --apply-ci on an ephemeral GitHub-hosted Actions runner.");
        std::process::exit(1);
    }
    #[cfg(windows)]
    if let Err(error) = prep::run() {
        eprintln!("CI null-device preparation failed: {error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    std::process::exit(1);
}
