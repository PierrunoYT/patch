# Windows sandboxing: outside developments (2026-10-09)

What changed outside Patch that matters for its Windows command sandbox (`native/sandbox-helper`, AppContainer). Researched on 2026-10-09; facts are as published on that date. Follow-up work is tracked in GitHub issues, not here:

- [#226](https://github.com/PierrunoYT/patch/issues/226): evaluate Microsoft Execution Containers (MXC) as the command sandbox backend
- [#227](https://github.com/PierrunoYT/patch/issues/227): use the OS process security environment (BaseContainer, PSEC) where Windows offers it
- [#101](https://github.com/PierrunoYT/patch/issues/101): `node --test` in the AppContainer, waiting for a Node.js release with libuv 1.53

## 1. Microsoft Execution Containers (MXC) is generally available

- **Announcement:** [Windows Developer Blog, 2026-10-07](https://blogs.windows.com/windowsdeveloper/2026/10/07/microsoft-execution-containers-policy-driven-containment-for-ai-agents/). Preview was announced at Build 2026 ([2026-06-02](https://blogs.windows.com/windowsdeveloper/2026/06/02/windows-platform-security-for-ai-agents/)).
- **Code:** [microsoft/mxc](https://github.com/microsoft/mxc), MIT. A Rust native launcher (`wxc-exec.exe`) plus a TypeScript SDK, [`@microsoft/mxc-sdk`](https://www.npmjs.com/package/@microsoft/mxc-sdk). Release binaries are signed.
- **Versions:** SDK 0.3.0 (2026-05-28) to 0.9.0 (2026-09-28) were pre-releases; 1.0.0 was published on 2026-10-06 (GitHub release v1.0.0 on 2026-10-07).
- **SDK requirements (1.0.0):** `engines.node >= 24`; on Windows, native stdio transfer needs Node 24.21.0+ (24.x line) or 26.8.0+. Dependencies: `node-pty` (Patch already ships it), `koffi`, `semver`.
- **Adopters named by Microsoft:** GitHub Copilot, OpenAI Codex, OpenClaw, Replit, LM Studio, Unsloth AI. Announced as coming: Anthropic Claude Code, Perplexity, Raycast, Manus and others.

### Model

A workload is described by one JSON policy, outside the agent's control:

| Policy area    | Controls                                                                         |
| -------------- | -------------------------------------------------------------------------------- |
| Containment    | Which backend runs the workload                                                  |
| Process        | Command line, arguments, working directory, environment                          |
| File system    | `readwritePaths`, `readonlyPaths`, denied paths                                  |
| Network        | Directional `egress` / `ingress` defaults, allow/deny rules, host loopback       |
| User interface | Win32k lockdown, clipboard, handle and atom isolation, desktop access (`ui` key) |

Backends:

| Backend           | Platforms                        | Notes                                                                         |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| Process container | Windows 11, macOS, Linux         | AppContainer/BaseContainer on Windows, Seatbelt on macOS, Bubblewrap on Linux |
| Session container | Windows 11                       | Separate Windows account and session: own desktop, clipboard and input        |
| WSL container     | Windows 11                       | Linux toolchains through WSL                                                  |
| MicroVM           | Windows 11, Linux (experimental) | Hardware-backed isolation                                                     |

The cross-platform process container uses the same primitives Patch already uses on macOS (Seatbelt) and Linux (bubblewrap).

### Windows process container tiers

From `docs/backends/process-container/` and `docs/schema.md` in the MXC repository:

- **Tier 1, BaseContainer:** the new OS API `CreateProcessSecurityEnvironment` / `QueryProcessSecurityEnvironmentSupport` / `CloseProcessSecurityEnvironment` (process security environment, "PSEC"), with a transitional fallback to [`Experimental_CreateProcessInSandbox`](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox). Filesystem deny rules are enforced by the OS (`PSE_SUPPORT_FS_DENY`) with **no change to host file ACLs**. Per-container WFP egress filters (IPv4/IPv6 ranges, protocol, port) and a per-container WinHTTP proxy apply **without a UAC prompt per launch**. Minimum builds for process isolation: 24H2 26100.9278 / 25H2 26200.9278 (KB5120998, August 2026), 26H2 26300.9550, 26H1 28000.2804. Session isolation needs the September 2026 update (KB5124010).
- **Tier 2, AppContainer + BFS:** `bfscfg.exe` filesystem policy; present on 24H2+ but off in shipped builds.
- **Tier 3, AppContainer + DACL:** the downlevel fallback, which edits host ACLs. This is the same approach as Patch's helper.

Host preparation (`wxc-host-prep.exe`, runs elevated once): adds non-inheriting read-attribute ACEs for `ALL APPLICATION PACKAGES` / `ALL RESTRICTED APPLICATION PACKAGES` on the system-drive root, because `cmd.exe`, PowerShell and `node.exe` fail at startup without them, and resets the `\Device\Null` security descriptor, which reverts at every boot. Patch hit the `\Device\Null` problem too: see `native/sandbox-helper/examples/prepare_ci_null.rs`, which CI runs.

Other BaseContainer notes from the schema docs:

- A grant on a directory does not grant its root's files implicitly (`"readwritePaths": ["C:\\"]` does not open every file), and upward directory traversal to a non-granted parent returns `ACCESS_DENIED`. Tools that walk up looking for a marker file (`.git`, `package.json`) need the parents listed in `enumeratePaths` (PSEC 1.1).
- `privateNetworkClientServer` is one bidirectional AppContainer capability, so private-network client access also allows inbound private traffic. MXC documents this explicitly.

### Relevance to open Patch issues

| Issue                                                         | How MXC or PSEC relates                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| #97 hostname restrictions for sandbox networking              | Per-container WFP egress rules and a loopback proxy model with peer identity |
| #150 limits per process, not per job                          | MXC runs workloads in a job; check whether its limits are job-wide           |
| #151 toolchain cache readable by every AppContainer           | BaseContainer read-only grants need no shared ACL on a cache                 |
| #207 grant on the shared Program Files folder                 | Same: OS-enforced `readonlyPaths` instead of ACEs on shared folders          |
| #158 LPAC, separate desktop, narrower grants                  | `ui` policy (Win32k lockdown, desktop isolation) and the session container   |
| #140 moved-in files lack the project grant                    | BaseContainer path grants are not inherited ACEs, so a moved file is covered |
| #176 first permission propagation can exceed the lock timeout | No propagation at all on Tier 1                                              |
| #139 `.git` permissions walked several times per command      | Denied paths without ACL walks on Tier 1                                     |

### Caveats

- The SDK reached 1.0 two days before this note; the Windows API it prefers is new and gated by servicing builds.
- Process container requires Windows 11 24H2 (26100) or later. Patch's helper also runs on older Windows; a switch would need a fallback.
- Patch's main process runs in Electron 44.5.1, which bundles Node 24.21.0. That meets the SDK's minimum, including the 24.21.0 floor for native stdio transfer on Windows, with no margin.
- MXC has a telemetry consent API. Patch has no telemetry; any integration must keep it off.
- Adopting it would replace much of `native/sandbox-helper` (grants, `.git` protection, toolchain copies, drive mapping). It needs a spike with Patch's existing integration tests, not a direct swap.

## 2. libuv 1.53 and `node --test` in the AppContainer (#101)

- libuv 1.53.0 was released on 2026-09-24 ([ChangeLog](https://github.com/libuv/libuv/blob/v1.x/ChangeLog)).
- Node.js has an open automated PR to adopt it: [nodejs/node#66282](https://github.com/nodejs/node/pull/66282) (opened 2026-09-25, not merged on 2026-10-09). `deps/uv` on `main` is still 1.52.1.
- #101 stays blocked until a Node.js release ships that PR. Then re-run the Windows sandbox integration tests for `node --test` and drop the `test-isolation=none` hint if they pass.

## 3. How OpenAI Codex sandboxes on Windows

- [Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/) and the [Codex Windows docs](https://developers.openai.com/codex/windows.md).
- Codex rejected plain AppContainer as "the wrong shape" for open-ended developer workflows, and Windows Sandbox (a disposable VM) because the agent must work on the real checkout.
- It ships two modes: `elevated` (preferred: dedicated low-privilege sandbox users, ACL boundaries, firewall rules, local policy changes, set up once with administrator approval) and `unelevated` (a restricted token derived from the user, ACL boundaries, environment-level offline controls). Enterprises can pin the allowed mode in `requirements.toml`.
- Its tracker shows repeated breakage of the elevated setup helper after updates (for example [openai/codex#24098](https://github.com/openai/codex/issues/24098), [#26158](https://github.com/openai/codex/issues/26158), [#38039](https://github.com/openai/codex/issues/38039)). Patch's AppContainer helper needs no administrator setup and avoids that class of failure.
- Microsoft lists Codex as an MXC adopter, so its own implementation may move to MXC.

## 4. Win32 app isolation

[Win32 app isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview) (MSIX-packaged apps in an AppContainer) is still marked preview; its release notes were last updated in December 2024. It isolates a whole packaged app, not commands an app starts, so it does not fit Patch's sandbox.

## 5. MXC spike results (2026-10-09, #226)

A throwaway test of the MXC SDK on one machine, outside the repository (no dependency was added). Host: Windows 11 25H2, build 26200.9457. The SDK ran under Electron 44.5.1's Node 24.21.0 (`ELECTRON_RUN_AS_NODE=1`), the same runtime Patch's main process uses. `getPlatformSupport()` reported `isolationTier: "base-container"`, so these results are for Tier 1, the OS process security environment (#227).

Tested SDK 0.9.0 (the newest release older than a week) through `createConfigFromPolicy` + `spawnSandboxFromConfig`, then repeated with 1.0.0 (`@microsoft/mxc-sdk/v1`, `run`). Both gave the same results. Policy: the project and a scratch temp folder read-write, `.git/hooks` read-only inside the project, the `PATH` folders read-only, network egress and ingress denied, an explicit environment, UI allowed (PowerShell needs Win32k).

### What worked

| Check                                                                        | Result                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `cmd`, `node -v`, a Node script writing a project file                       | Run                                                                                            |
| Write inside the project                                                     | Allowed                                                                                        |
| Read or write a file outside the project                                     | Denied                                                                                         |
| List the user profile                                                        | Denied                                                                                         |
| Write `.git/hooks/pre-commit` (read-only path inside the read-write project) | Denied; the file is unchanged                                                                  |
| Environment                                                                  | Only the variables passed in; nothing inherited from the parent process                        |
| Network off                                                                  | `fetch` fails with `ENOTFOUND`                                                                 |
| Host ACLs                                                                    | `icacls` output of the project and `.git/hooks` identical before and after: no ACEs were added |

### What failed

- **Git, npm and PowerShell cannot work in a project under the user profile.** `git status` exits 128 with `Unable to read current working directory: Permission denied`; `npm -v` fails with `EPERM ... lstat 'C:\'` from `realpath`; PowerShell starts in `C:\` instead of the project. They walk up through the project's parent folders, and BaseContainer denies folders that are not granted. MXC's fix, `processContainer.filesystem.enumeratePaths` (list a folder without reading its files), needs PSEC 1.1; on this build MXC refuses it: `enumeratePaths is not supported by this version of Windows`. Granting the parents read-only would open every file in them (the user profile), which Patch's sandbox exists to prevent. Patch's helper runs git, npm and PowerShell in the same layout.
- **`getAvailableToolsPolicy` granted the whole drive.** This machine's `PATH` contains `C:\`, and the helper turned it into a read-only grant on `C:\`, which silently made every file on the drive readable (the profile listing and the outside file were readable until that entry was removed). Patch must never pass `PATH` folders through unchecked; its helper already refuses roots that contain the home folder or sensitive trees (#145).
- **Node crashed after a network request.** With egress allowed, `fetch('https://example.com')` returned 200, then `process.exit` aborted in libuv (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`, exit `0xC0000409`). It may be related to the libuv behavior behind #101; it was not investigated further.
- **The SDK shells out to `whoami /user` by `PATH` lookup.** From Git Bash it found the wrong `whoami` and printed an error (the run continued). Patch would need to start it with a clean `PATH`.

### Speed

`cmd.exe /d /c exit 0`, median of 15 runs after one warm-up:

|                           | First command | Median |
| ------------------------- | ------------- | ------ |
| Plain `spawn`             | 36 ms         | 31 ms  |
| MXC, empty project        | 249 ms        | 96 ms  |
| MXC, 100,000-file project | 104 ms        | 105 ms |

Patch's own `tests/perf/windows_sandbox.perf.ts` on the same machine (a PowerShell `echo` through `ShellRunner`, 100,000 files): unsandboxed median 260 ms, sandboxed median 299 ms, so **39 ms overhead**, but the **first sandboxed command took 19.9 s** (propagating the project grant, #176). MXC adds about 65–75 ms per command instead, and nothing on the first command, whatever the project size. The two measurements use different commands and code paths, so compare the overheads, not the totals.

### Conclusion

Not ready to replace `sandbox-helper` on this build. The isolation itself is right (deny outside the project, read-only `.git/hooks`, no ACL changes, network off), and it removes the first-command propagation cost. But git, npm and PowerShell, the tools an agent runs most, fail in projects under the user profile until Windows ships PSEC 1.1 enumeration. Re-test when a Windows update reports `enumeratePaths` support, and pass only checked folders (never drive roots or the profile) as read-only paths.
