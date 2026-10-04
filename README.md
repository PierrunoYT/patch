# Patch

<img src="assets/logo-icon.svg" width="96" height="96" alt="Patch application icon" />

A desktop AI coding assistant. Open a project folder, describe a task, and Patch reads the code, edits files, runs commands and checks its work, asking for your approval before it changes anything.

Patch is a from-scratch TypeScript desktop coding assistant. [CHANGELOG.md](CHANGELOG.md) tracks the unreleased baseline using Keep a Changelog.

Repository: https://github.com/PierrunoYT/patch

The application and installer are named Patch (`Patch.exe` and `Patch-Installer.exe` on Windows). The default profile directory is `Patch` under the system application-data directory. Environment variables use the `PATCH_*` prefix. Existing profiles are not migrated automatically: set `PATCH_USER_DATA` to an existing profile folder to reuse its settings, keys and chats. The installer uses the `patch` application ID and does not upgrade installations with a different ID.

![The assistant shows a diff and waits for Approve or Decline before editing a file](docs/images/approval.png)

## Features

- OpenCode Desktop-inspired interface with neutral light/dark themes, project and session navigation, a collapsible sidebar, and model/approval controls beside the prompt
- Chat with Claude (Opus 5.5 by default, Sonnet 5.5, Haiku 4.5), OpenAI GPT-6 (Astra, Sol, Luna) or any OpenAI-compatible endpoint, with streaming answers; Claude can also go through a proxy or gateway (Settings → Claude base URL)
- Works directly in your project: read, search, edit and create files, run commands
- Windows sandbox permissions recover on the next helper startup after a forced stop; cleanup leaves live commands and unrelated container permissions intact
- File replacements on supported Claude models use strict tool inputs to prevent omitted required fields in batched edits; every edit still validates locally and follows the approval rules
- Every file change and command is shown first (diffs, command text) and waits for **Approve** or **Decline** — or switch to **Auto** mode
- Decline with a note ("use pnpm instead") and the assistant adjusts
- Optional **Plan mode**: before multi-step changes, the assistant shows its plan as an approval card, also in Auto mode
- **Undo** on the card of any approved file edit puts the file back (or deletes a file the assistant created), as long as the file is still as the edit left it; the assistant is told and has to read the file again
- Semantic code search over the project (needs an OpenRouter key: files are embedded with Voyage `voyage-code-4` and results reranked with Voyage `rerank-3`, both through OpenRouter; the key can be added mid-chat); Settings shows whether the project is indexed (with progress while it builds) and can reindex it
- Built-in browser the assistant uses to check web apps: console output and screenshots
- Interactive terminal and a Git panel next to the chat: changed files with line counts, a hunk-by-hunk diff preview, discard (one file or all), AI-written commit messages (**Generate**), and **Commit & Push**
- Mention project files with `@` in the message box; tool calls in the chat show how long they took
- Web search (Google Custom Search) and page fetching (long pages come in parts, fetched pages are cached for 15 minutes, and an `objective` lists the relevant lines first)
- Model Context Protocol (MCP) servers: add them in Settings (stdio programs or Streamable HTTP endpoints) and their tools are offered to the assistant; every MCP tool call asks for approval, also in Auto mode
- Read-only subagents with their own context: `task` for broad questions such as "find every caller", `finder` (a cheaper model) to locate code and `oracle` for a second opinion on a hard problem. Settings can run `task` on a smaller model and lower the effort for `finder` and `task`; the defaults match the chat. Their progress shows while they work, and independent read-only tool calls (including subagents) run in parallel
- Multi-file edits in one approval with `apply_patch` (Codex patch format, all-or-nothing), file search by name with `glob`, and a `todo_list` checklist the assistant keeps while it works through a multi-step task
- Secrets are hidden from the model: private keys, cloud and Git host tokens, JWTs and credential values in tool results (an `.env` file, a printed token) are replaced by `[REDACTED:_____]` before the model, the transcript or the saved chat see them
- Edits to protected files (`.env`, keys, `.git`, editor and agent config, shell start-up files, databases) always ask, even in Auto mode
- Permission rules in Settings (JSON): allow, reject, always ask or hand a tool call to your own program, matched by glob on the tool name and its input (for example reject `git push*`)
- Project skills: Markdown instructions for recurring tasks in `.patch/skills/`, which the assistant loads when a task matches
- Long chats are handled by server-side compaction (current Claude models), and **Compact chat** (header button) summarizes older turns on demand; custom endpoints must support structured-output summaries using the chat's model. The status bar shows the latest request's prompt size, not the sum across Claude continuations. The full history stays in the saved chat
- Rate limits (429), server errors (5xx) and dropped connections are retried automatically, up to 4 times, waiting about 2 to 16 seconds or as long as the provider asks (up to a minute); each retry is shown in the chat and **Stop** works during the wait
- Failed or stopped Claude continuations after a server-side pause or compaction leave saved model history unchanged; retries start from the history before that attempt
- Stop a running task, including its project's background commands, and use **Resume** to continue it after cancellation settles, including after reopening the saved chat; the model is instructed to check interrupted actions before retrying them. A task cut off by a crash, whether during a model request or while tools were running, can be resumed the same way
- Keep several projects open in the sidebar, each with its own chat and unsent draft. Stop the current task before switching; one agent run is active at a time
- Chats are saved automatically, listed by day in a sidebar, and can be searched by title, project or message text, and exported as Markdown (download button in the header); per-project custom instructions
- `AGENTS.md` (or `CLAUDE.md`) in the project root is always added to the chat's instructions; the status bar shows "AGENTS.md"
- Image attachments (attach or paste) for models that accept images, with a compact paperclip beside the model and mode controls; attachment chips take space only when present. The paperclip and paste are disabled for a Claude model id the app does not know to accept images (entered under _Other model id…_)
- Token totals and estimated cost for the built-in Claude and GPT-6 models, including cache reads and writes, in the status bar (with how full the model's context window is), and each chat's estimated cost in the chat list and history; custom endpoints have no official-price estimate
- Prompt caching tuned for agent loops: the fixed tools and system prompt are cached once and reused, also by subagents on the chat's model, and an optional setting keeps an idle Claude chat's cache warm for up to an hour so a reply after a pause does not write the whole chat again (see [PERFORMANCE.md](docs/PERFORMANCE.md#prompt-cache-changes-77-2026-10-03) for what it saved)

## Getting started

Requirements: Node.js 22.12+ (22.x, 24.x or 26+, as Electron and Vitest need), Git (optional, for the Git panel).

```bash
npm install
npm start
```

Then:

1. **File → Open Project…** and pick a folder.
2. Open **Settings** (gear icon, `Ctrl+,`) and add your Anthropic API key. For official OpenAI models, add an OpenAI API key or press **Sign in with ChatGPT**. Code search still needs the OpenAI key. Add a Google API key and search engine id for web search.
3. Describe a task, e.g. _"Add input validation to the signup form and a test for it."_

Recent projects are ordered by the latest open, including folders opened within the same millisecond.

To build an installer: `npm run dist` (on Windows, `dist/Patch-Installer.exe`; the unpacked app is `dist/win-unpacked/Patch.exe`; a DMG on macOS; an AppImage and deb on Linux, where the deb installs the command `patch-app`). Local `pack` and `dist` commands never publish; releases are published by the tag-triggered release workflow. The Windows installer is the supported download. Linux and macOS packages are built by CI so they can be tried, but they are experimental. CI starts the installed Linux deb, the AppImage and the macOS app from its DMG and checks they open a project and run a terminal command, but nobody has used them on a real desktop yet, and a downloaded copy of the unsigned macOS app has not been tried.

For development in Amp orbs, the repository includes setup and resume scripts to prepare and reuse dependencies. See [orb setup](docs/DEVELOPMENT.md#amp-orbs) for requirements and headless test commands.

To verify a download, compare its hash with `SHA256SUMS.txt` from the same release (`sha256sum -c SHA256SUMS.txt`, or `Get-FileHash .\Patch-Installer.exe` on Windows). Signed Windows releases also show a valid publisher under the file's Properties, Digital Signatures tab. Patch has no update check, so reinstall from the latest release to get security fixes.

## Keyboard shortcuts

| Shortcut                | Action             |
| ----------------------- | ------------------ |
| `Enter` / `Shift+Enter` | Send / new line    |
| `Ctrl+O`                | Open project       |
| `Ctrl+N`                | New chat           |
| `Ctrl+.`                | Stop the assistant |
| `Ctrl+,`                | Settings           |

(`Cmd` instead of `Ctrl` on macOS.)

## Privacy and security

- The app talks only to the APIs you configure (Anthropic or your Claude base URL, OpenAI or your OpenAI-compatible endpoint, Google search), to OpenAI sign-in and the Codex backend at `chatgpt.com` when you use **Sign in with ChatGPT**, and to pages you or the assistant open. There is no telemetry and no update check. Crashes and errors are written to a log file in the app's data folder (`logs/app.log.jsonl`) for your own troubleshooting, along with a line per start giving the app and Electron version and platform. Native Electron crashes are saved locally as minidumps and added to that log on the next start; reports are never uploaded. The log holds error messages and stack traces (which can mention file paths), not your chat history. Recognized API-key formats, including Groq (`gsk_…`) and xAI (`xai-…`), are redacted from new messages and stacks; review logs before sharing because arbitrary secret formats may not be recognized. **Help → Show Log Folder** opens it.
- To make **Undo** possible, the previous version of every file the assistant edits is copied to the app's data folder (`edit-backups`, the latest 50 edits per chat, deleted with the chat). Those copies are not encrypted; delete the chat if a project contains secrets you do not want copied.
- API keys, and the ChatGPT access and refresh tokens from **Sign in with ChatGPT**, are encrypted with the operating system's keychain (Electron `safeStorage`) when available and never reach the UI process. Settings shows whether a ChatGPT account is signed in, and the account email when the login provides one. It does not show the tokens. Without system encryption, secrets are stored as plaintext and Settings warns. Existing plaintext secrets are migrated when encryption becomes available; failed migration keeps the warning and preserves them.
- The assistant's file access is confined to the open project folder, including through links: a file is checked where it would really be written, even when it does not exist yet. Commands run in your shell with your permissions — keep **Ask first** mode on unless you trust the task. In Settings, "Commands allowed without asking" lists commands (one per line, for example `npm test`) that skip the approval card in Ask first mode; a line also allows the command with arguments. **Project settings…** in the project menu has the same two lists for one project, added to the global ones; they are kept with the app's data, not in the project, so a repository cannot allow its own commands. Commands containing `;`, `&`, `|`, `>`, `<`, a backtick, `$`, `(`, `)`, `{`, `}` or a line break are always asked about (PowerShell, which runs the commands on Windows, runs `(...)` and `{...}` even inside a program's arguments), and file edits always wait for you. Only allow commands you would run yourself: `npm run` would let the assistant run any script in `package.json`.
- Tool results pass through secret redaction before the model sees them, and `write_file`, `edit_file` and `apply_patch` refuse text that contains the `[REDACTED:_____]` placeholder. Redaction recognises well-known token formats and credential-named values; it is not a guarantee, so keep secrets out of projects you do not trust the model with.
- Permission rules (Settings → "Permission rules (JSON)") decide a tool call before the normal approval: `allow`, `reject`, `ask` (also in Auto mode) or `delegate` (a program you name answers). Saving an `allow` or `delegate` rule asks for confirmation, like switching to Auto mode. A `delegate` program runs with your permissions.
- Agent shell commands (`run_command`, background ones included) run in a **sandbox where one is available**: bubblewrap on Linux, Seatbelt (`sandbox-exec`) on macOS and an AppContainer on Windows (through the bundled `sandbox-helper.exe`), or, on any platform with Settings → Command sandbox → container, a Docker or Podman container. Only the project folder is writable, the rest of your home folder is hidden, and the network is off unless the setting or a one-time approval allows it. On Windows, a sandboxed command sees the project as the root of a temporary drive from `P:` through `Z:`, so relative paths are portable while the original absolute project path may be inaccessible. Credential-looking environment variables are removed as well. Without a sandbox (for example a Windows build run from source without the helper) commands run with your full rights, and the approval card says "NOT sandboxed". The container option fails closed (the command does not run) when Docker or Podman is not running. The terminal panel and MCP servers are not sandboxed. `npm run test:sandbox` exercises real backends when available: Linux bubblewrap and Docker isolation probes have passed in an orb, and Windows has a real-helper integration suite. macOS and Windows checks need their native hosts; unavailable backends skip explicitly. See [sandbox test prerequisites](docs/DEVELOPMENT.md#real-sandbox-tests). Treat sandboxing as a second line of defence and still use **Ask first** mode, or a VM or separate account, for untrusted repositories.
- The UI runs sandboxed without Node.js access; model output is sanitized before display.
- Browser guests are sandboxed without Node.js or a preload. The main process accepts only the isolated `persist:browser` session partition; guests requesting the app's default session or another partition are rejected.
- This source baseline uses Electron 44.5.1, including upstream ANGLE, Chromium, Dawn and V8 fixes. Existing installations need a rebuilt installer to receive runtime updates; Patch does not update itself.
- macOS packaging enables the hardened runtime with only the JIT entitlement for the app and its helpers; it does not grant DYLD library injection or unrestricted executable memory. Signed packaged launches still need verification on a Mac; Windows remains the supported platform.
- The Windows release workflow refuses unsigned or invalidly signed app and installer builds, and publishes SHA-256 checksums. Releases are blocked until the maintainer provisions signing credentials; local development builds may be unsigned.
- In **Ask first** mode, page fetching and browser tools require approval unless their exact hostname is listed in Settings → "Network hosts allowed without asking". The list starts empty and does not include subdomains automatically. Cross-host redirects require a separate tool call; browser popups are denied. **Auto** mode skips tool approvals, except for MCP tools and Plan mode, which always ask. This is not a network sandbox: browser subresources and Google search are not covered, and approved hosts may receive private data. Avoid untrusted pages in projects with secrets.
- MCP servers you add run with your permissions (a stdio server is a program on your computer); their environment variables and HTTP headers are encrypted like API keys and never reach the UI.
- Sandboxes open only the binary/cache subdirectories of Cargo, Maven and Gradle, not their credential-bearing parent folders; global Git configuration is hidden too. Commands that depend on those private settings need explicit unsandboxed approval. This does not hide secrets stored inside the project itself.
- The **Git** panel disables hooks (including `core.hooksPath` overrides), `core.fsmonitor`, repository-defined clean/smudge filters and external diff drivers. This prevents an agent from planting a hook in the project and having the panel execute it outside the sandbox. Use the terminal to run Git with trusted hooks, including Git LFS pre-push hooks. Open security findings carry the [`security` label](https://github.com/PierrunoYT/patch/issues?q=is%3Aopen+label%3Asecurity).

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

## Documentation

<details>
<summary>Settings, Git changes, and browser preview</summary>

![Settings with model and API configuration](docs/images/settings.png)
![Git panel showing a new preview page and its diff](docs/images/git.png)
![Browser panel showing an application preview](docs/images/browser.png)

</details>

- [User guide](docs/USAGE.md) — approvals, plan mode, allow-lists, project skills, MCP servers, the research subagent, stop and resume, chat history and export
- [Architecture](docs/ARCHITECTURE.md) — processes, IPC contract, agent loop, providers, tools, storage, security model
- [Development guide](docs/DEVELOPMENT.md) — setup, scripts, tests, where to change things
- [Performance](docs/PERFORMANCE.md) — long-chat measurements and what was changed
- [Contributing](CONTRIBUTING.md)
- [Issues](https://github.com/PierrunoYT/patch/issues) — open work, bugs and ideas
- [AGENTS.md](AGENTS.md) — guidance for AI coding agents working on this repo

## License

[MIT](LICENSE)
