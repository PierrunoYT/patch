# Using Patch

A short guide to the parts that need explaining: approvals, allow-lists, stopping and resuming, and exporting a chat. For installing and building, see the [README](../README.md).

## Start

1. **File → Open Project…** (`Ctrl+O`) and pick a folder. The assistant can only read and change files inside it.
2. Open **Settings** (gear icon, `Ctrl+,`) and add an API key: Anthropic for Claude models, OpenAI for GPT-6 models, and optionally OpenRouter for semantic code search (the project is embedded with Voyage `voyage-code-4`, about $0.12 per million tokens, and each search's best matches are reranked with Voyage `rerank-3`). Credential files (`.env`, `.npmrc`, keys and certificates, `.ssh` and similar folders, `.envrc`) are never indexed, and secrets inside other files are masked before any text is sent. You can instead press **Sign in with ChatGPT** and use official OpenAI models on that account with no OpenAI API key. Sign-in opens your browser and finishes at `http://localhost:1455/auth/callback`. If port 1455 is already in use, Settings says so and stores nothing. Starting sign-in again cancels one that is still waiting. The access and refresh tokens are encrypted like API keys and are not shown. Settings shows that you are signed in, and the account email when the login provides one. **Sign out** clears the session. While you are signed in and the OpenAI-compatible base URL is empty, official chats use the ChatGPT session. Sign out when you want those chats to use the API key. A custom base URL always uses the API key and Chat Completions, even while you are signed in. Chat titles, Compact chat, and generated Git commit messages still need an OpenAI API key. Keys and the ChatGPT tokens are encrypted when system encryption is available. Settings warns about plaintext storage if encryption is unavailable or migration fails. Existing plaintext secrets are migrated when encryption becomes available. Stored keys are never shown again. Type a new one to replace it, or press **Remove**.
3. Type a task in the box at the bottom and press `Enter` (`Shift+Enter` for a new line). Attach or paste images with the paperclip button (PNG, JPEG, GIF or WebP, up to 5 MB each, whether attached or pasted). All built-in models accept images. For a Claude model id entered under _Other model id…_ that the app does not know, the paperclip is disabled, pasting an image shows why, and images already in the draft are marked and cannot be sent: start a new chat with a built-in model to use them. OpenAI-compatible endpoints are not checked, since the app cannot know what their models accept; the endpoint's own error is shown if it refuses.
4. Type `@` to mention a project file: pick it from the list (arrow keys and `Enter`, or click) and it becomes a chip under the message. Mentioned files are sent as `@path` at the start of the message, so the assistant knows which files you mean; it still reads them with its tools. The composer shows a rough token count of the message.

Each chat keeps the model it started with. The model picker inside the message composer (or **Settings → Model**) chooses the model for a new chat; once the chat has started, the picker shows its model and is locked until you start a new chat.

The paperclip, model and mode controls, and Send share a compact toolbar below the message, wrapping in narrower chat panes. Attached images and mentioned files appear as removable chips above the toolbar; an empty draft reserves no space for chips.

The OpenCode Desktop-inspired window uses neutral light/dark surfaces, project navigation and the chat list (**Sessions**) on the left, a centered chat in the middle, and the side panel on the right. **Open project** adds a folder to the sidebar; each project's close button appears on hover or keyboard focus. **New Chat** sits above Sessions. The header's sidebar button shows or hides the left navigation, and its breadcrumb names the project and current session. Model selection, **Ask** / **Auto-Approve**, and **Plan Mode** live inside the message composer. The header's right-hand actions are Compact chat, Export chat, Send feedback (opens a new GitHub issue in your browser; nothing is sent by the app), Chat history, the side panel button, the project menu and Settings. The status bar shows the branch, loaded instructions, model, context, index state, tokens and estimated cost; secondary details are hidden in narrow windows.

In the chat, each tool call is a row with the tool's name, its target and its result ("2 lines", "exit 0", or why it failed, from the first line of the error), how long it ran, and Undo and Open-in-editor buttons where they apply; click a row to see its diff or output.

### Tell it about your project

- **Project instructions**: the project menu (the sliders button in the header) → _Project settings…_, or **Add project instructions** on a new chat's start screen. The text is added to every new chat in that project, e.g. "Run `npm test` after changes" or "Never edit `generated/`". Saving new or changed instructions asks for confirmation in a system dialog that shows them.
- **`AGENTS.md`** (or `CLAUDE.md`) in the project root is added to every chat automatically. The status bar and the foot of the chat list show "AGENTS.md".

Both are prompt text, not enforced rules: the assistant can still get them wrong, which is why approvals exist.

### Project skills

Skills are instructions for recurring tasks that the assistant only reads when it needs them, so they don't take up room in every request. Put each one in a Markdown file in `.patch/skills/` in the project, for example `.patch/skills/release.md`:

```markdown
# Release

Bump the version in package.json, add the CHANGELOG section, then tag v<version> and push the tag.
```

- The file name (without `.md`) is the skill's name. The first line that isn't a heading is its description.
- When a chat starts, the assistant is told each skill's name and description, and loads the full file when a task matches.
- Up to 20 skills are listed, in file-name order. The assistant is told if there are more.
- A chat keeps the skill list it started with. Start a new chat after adding or removing skills.
- The folder must be inside the project. A skills folder that links elsewhere is ignored.

### Files the assistant skips

Listing folders, finding files, searching and the code index skip what git ignores (`.gitignore` files and `.git/info/exclude`), `.git` and `node_modules`. To hide more from the assistant without changing git, add a `.patchignore` to the project root, in `.gitignore` syntax; its rules come last, so it can also show a file that `.gitignore` hides (`!path`). The older name `.ccignore` is still read. Ignored files can still be read and edited by path; the file must be inside the project.

## Approvals

By default the assistant asks before it changes anything. A card appears in the chat showing what it wants to do, with **Approve** and **Decline** buttons.

| It wants to…                                                    | What you see     |
| --------------------------------------------------------------- | ---------------- |
| Edit or create files (`edit_file`, `write_file`, `apply_patch`) | The diff         |
| Run a command (`run_command`)                                   | The command text |
| Fetch a page or use the browser (`fetch_url`, `browser`)        | The URL          |

Reading files, listing folders, finding files by name, searching the code, the todo list and web search never ask.

Web search sends the query the model wrote to Google Custom Search without asking, so text from your project that the model puts in a query leaves your machine. Patch masks recognizable secrets (API keys, tokens, private keys, passwords in URLs) in the query first, but other code or names are sent as written. Leave the Google settings empty to turn web search off for confidential work.

**Protected files** always ask, even in Auto mode: `.env` files (but not `.env.example`), keys and certificates (`*.pem`, `*.key`, `id_rsa`, …), `.ssh`, `.aws` and similar folders, `.git`, editor and agent folders and settings (`.vscode`, `.idea`, `.cursor`, `.claude`, `.gemini`, `.zed`, `.mcp.json`, …), the project's `AGENTS.md` or `CLAUDE.md` and its `.patch` folder (skills), which go into every new chat's instructions, files other programs run on their own (`.envrc`, `.husky/` hooks), shell start-up files (`.bashrc`, `.zshrc`, …), databases (`*.sqlite`, `*.db`) and system folders. This applies to `edit_file`, `write_file` and every path in an `apply_patch`.

Protection is case-insensitive, and Windows 8.3 names are expanded before checking the deepest existing parent. `.GIT/config` and a short-name alias of `.git` therefore ask too. If a safety check fails, Patch requires approval instead of silently allowing the edit, including with an `allow` or `delegate` permission rule (#143).

`read_file`, edit previews and writes, `apply_patch` mutations and Undo use a native helper that never follows symlinks or junctions beneath the project, even when they point inside it (#144). Use the real project-relative path instead. Writes also refuse hard-linked targets. Expected bytes and existing batch targets are checked before the first change; this is not a filesystem transaction, so a later I/O failure can leave some files changed. A missing helper refuses the operation without a host-write fallback; source builds require Rust and `npm run build:sandbox`.

**Local addresses** always ask, even in Auto mode: `fetch_url` and `browser` calls to `localhost`, your local network, link-local addresses such as cloud metadata (169.254.169.254), multicast and other reserved ranges, IPv6 addresses that carry one of these (NAT64, 6to4), or a name that resolves to one of them, unless the host is in the network allow-list. Redirects must stay on the same scheme, host and port.

Very large diffs are shown only in part: the first 2,000 lines. The approval card then says so in a yellow warning, because approving applies the whole change, including the part you cannot see. Decline and ask for smaller edits if you want to review everything. Long command output shows its last 20,000 characters, with a note that the start was left out.

- **Approve** runs it and the assistant continues.
- **Decline** with the box left empty stops the task. Any other calls the assistant had planned for that step are skipped.
- **Decline with a note** ("use pnpm instead") sends the note to the assistant, which adjusts and carries on. Use this rather than an empty decline when you want it to try something else.

Existing files must be read by the assistant in the same chat before it can change them, and a file that was not read is rejected before you are asked to approve. If you edit a file after the assistant read it, the assistant cannot overwrite it with `write_file` until it reads it again, so your edit is not lost.

### Undo an edit

Every approved file edit keeps a copy of the file as it was. The edit's card in the chat gets an **Undo** button (it also shows in Auto mode). Press it and confirm to put the file back, or to delete a file the assistant created.

- Undo only works while the file is exactly as the edit left it, so it never throws away something you or a later edit wrote afterwards. If the file changed, you get a message saying so and nothing is touched. Undo the later edits first (newest first), or restore the file with Git.
- It is available while the assistant is idle. Stop the task first if it is still working.
- The assistant is told with your next message that you undid the edit, and has to read the file again before it changes it. The card then shows **Undone**.
- A patch (`apply_patch`) is undone as a whole: every file it changed, added, deleted or moved goes back, or, if any of them changed since, none does.
- Only file edits made with the assistant's edit, write and patch tools can be undone. Changes made by commands it ran (`npm install`, `git checkout`, a code generator) cannot; the Git panel and Git itself are the way back for those.
- The copies are kept in the app's data folder (`edit-backups`), the last 50 edits of each chat, and are deleted with the chat. They are copies of your own project files, so they are as sensitive as the files.

### Ask first or Auto

**Settings → Approvals**, or the **Ask** / **Auto-Approve** switch in the composer, chooses between:

- **Ask before edits and commands** (default): as above.
- **Run edits and commands without asking** (Auto): nothing waits for you. Commands run in your shell with your permissions, so use it only for work you would let anyone on your keyboard do. The first switch to Auto after starting the app shows a confirmation dialog.

Changing the **Editor command**, adding or changing an MCP server that runs a program (its command, arguments, folder or a new `env` value), changing the URL of an HTTP MCP server that keeps saved headers (they would go to the new host), adding entries to the commands or network hosts allowed without asking (in Settings or in a project's settings), or setting the Claude or OpenAI-compatible base URL also asks for confirmation before it is saved. Removing entries and clearing a base URL don't ask. Cancel leaves the settings as they were.

Even in Auto mode, a fetch or browser redirect to another host is blocked; the assistant has to ask for the new address as a separate step.

### Plan mode

**Settings → Plan mode** ("Propose a plan before multi-step changes"), or the **Plan Mode** switch in the composer, asks the assistant to show its plan before it changes files or runs commands on a task with several steps. The plan appears as an approval card with the steps written out.

- **Approve** lets the work begin. The assistant then carries the plan out, and later edits and commands follow the usual approval rules (they still ask in Ask mode, and run directly in Auto mode).
- **Decline with a note** sends the note back, and the assistant revises the plan instead of starting.
- **Decline** with the box left empty stops the task.
- The card still appears in **Auto** mode. Turning plan mode on never skips the plan.
- If the assistant tries to edit or run a command in the same step as the plan, those calls wait: they are not run until you have decided, and the assistant calls them again afterwards.
- Turning plan mode on or off does not cost a prompt cache miss: the assistant is told in a note, and its tool list stays the same. While the assistant is working, the note goes with its next tool results; otherwise it goes with your next message. The assistant is instructed to follow the most recent app plan-mode note until a newer one changes it; intervening messages and tool screenshots do not reset the mode.
- A very long plan is shown only in part (the first 20,000 characters), with a note that approving covers the rest too. Decline and ask for a shorter plan if you want to read all of it.

## Allow-lists

Two lists let specific things skip the approval card while **Ask** mode stays on. Both are empty by default, and there are two places to fill them:

- **Settings**: for every project.
- **Project settings…** in the project menu (the folder button at the top): for the open project only, in addition to the lists in Settings. A command or host is allowed when either list has it. Use this for what only makes sense in one project, such as `cargo check` or that project's dev server host. These lists are kept with the app's data, not in the project folder, so a repository you clone cannot allow its own commands. They apply at once, also to a chat that is already open.

The rules below are the same for both.

### Commands allowed without asking

One command per line. A line allows that exact command and the same command followed by arguments:

```
npm test
npm run lint
git status
# lines starting with # are comments
```

- `npm test` also allows `npm test -- --watch`, but not `npm testing` or `npm run test`.
- Any command containing `;`, `&`, `|`, `>`, `<`, a backtick, `$`, `(`, `)`, `{`, `}` or a line break is always asked about, so an allowed `npm test` cannot become `npm test && rm -rf .`, nor, in PowerShell (which runs the commands on Windows), `npm test (Remove-Item -Recurse src)`. Ordinary arguments such as `npm install @types/node` or `npx vitest run "src/a b.test.ts"` still match.
- A line trusts the program with its other arguments, so allow only programs you would let run with any arguments. Arguments that make a command which looks read-only write a file or run another program are asked about anyway: `--output` (so `git log --output=~/.bashrc` asks even when `git log` is allowed), `--output-directory`, `--exec`, `--upload-pack`, `--receive-pack`, `--open-files-in-pager`, `--in-place`, `-o` and `-O` (with or without a value), and `find`'s `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*` and `-fls`. This list is best-effort, not a complete one.
- File edits are always asked about, whatever is on this list.
- Only allow commands you would run yourself. `npm run` would let the assistant run any script in `package.json`.

### Command sandbox

Sandboxed commands, and sandboxed MCP servers given the project, refuse a volume root, your home folder or its ancestors, and any root overlapping application data, Patch's profile or its packaged installation (#145). This applies to native and container modes, foreground and background commands, and happens before Git reservation files or Windows write grants are created. You can still open such a folder for browsing; choose a narrower project to run commands, or explicitly approve an unsandboxed run. A project inside the home folder is allowed when it does not overlap those sensitive trees.

On macOS, each command gets a temporary `.patch-command-tmp-*` folder inside the project as `TMPDIR`, removed when the command closes. System temporary directories are not writable: allowing another host write tree would let a background command move an opened file out of the project while a file edit still holds its handle (#144). Programs that insist on `/tmp` or the host's temp folder need explicit unsandboxed approval.

On macOS, native commands can look up only the CLI user/group Mach service; DNS and certificate-trust services are added only when network access is enabled. The policy never grants application-launch, URL-session or preferences daemon lookup, even with network access, so tools that read user defaults (`defaults`, `xcodebuild`) see built-in defaults. Arbitrary POSIX shared memory is not granted, so `initdb` with POSIX shared memory and Python `multiprocessing.shared_memory` fail; named semaphores (Python `multiprocessing` locks) work. Commands can still list host processes; Seatbelt cannot hide them. A command depending on another system service must fail rather than silently run unsandboxed. The terminal panel and MCP servers retain their existing, unsandboxed behavior (on Linux and Windows an MCP server can opt in, see [MCP servers](#mcp-servers)). The reported LaunchServices escape (#99) was unverified; actual enforcement and CLI compatibility must be checked with the native macOS regression suite.

Settings → Command sandbox controls how `run_command` and background commands are confined (the terminal panel is your own shell and is not). **Automatic** uses bubblewrap on Linux (install `bwrap`), Seatbelt on macOS and an AppContainer on Windows; **container** always uses Docker or Podman with the image you set, mounting only the project at `/workspace`; **off** disables it. Inside the sandbox only the project and temporary folders are writable, the rest of your home folder is hidden and the network is off by default. With the network **allow-list** on Linux (Automatic mode, bubblewrap) and Windows (AppContainer), every command gets network only to the listed hosts ([#97](https://github.com/PierrunoYT/patch/issues/97)). On Linux it runs in its own network namespace with no route and no name server; on Windows the AppContainer has no network capability. The only way out is a proxy in Patch: on Linux a `net-bridge` inside the namespace forwards `127.0.0.1:3128` to a Unix socket, and on Windows the same helper inside the AppContainer forwards a private loopback port through a named pipe only that AppContainer may open. That proxy allows HTTP and HTTPS (CONNECT) to an exactly listed hostname (an entry does not cover its subdomains) on port 80 or 443, resolves the name itself and refuses it when it resolves to this machine, your local network or a link-local address. A redirect to another host is checked again. Programs that honor `HTTP_PROXY`/`HTTPS_PROXY` (curl, git, npm, pip, Node with `NODE_USE_ENV_PROXY`, which Patch sets) work; anything else, raw sockets, other ports and DNS lookups fail. These commands need no approval. On Windows an AppContainer is not isolated from services listening on this machine's loopback address (only firewall rules could do that, which needs administrator rights), so such a command can still reach local services directly; the internet and DNS stay closed to it. On macOS and in container mode, the allow-list still only requests unrestricted network access when every URL in the command matches an allowed host; it cannot filter connections there, so each such run requires approval. **On** grants unrestricted network access to all sandboxed commands, so they can also reach local network services such as databases and dev servers. On macOS, local Unix sockets (such as Docker's or ssh-agent's) stay blocked even with network access; only the system DNS resolver socket is allowed. On Linux, Unix sockets in the hidden folders stay out of reach, but abstract Unix sockets (such as the X11 display's) and services on this machine's loopback address are reachable with network access, and the approval card and the confirmation for **On** say so ([#102](https://github.com/PierrunoYT/patch/issues/102)); a real-bubblewrap test checks both. Without network access neither is reachable. On Windows the installed app includes a small helper (`sandbox-helper.exe`) that runs each command in an AppContainer: the project appears at the root of a temporary drive letter, taken from `Z:` down to `D:`, so commands should use relative project paths. After a helper crash, the next command reclaims its recorded project drive mapping without deleting project files or removing another running command's drive. Mappings left by older helpers without recorded ownership are not automatically removed. Automatic mode refuses to run when its backend is missing, including a Windows source build without the helper (`npm run build:sandbox`). The installed app only uses the helper bundled in its resources folder. Container mode refuses to run when no engine is running. When a command needs more, the agent sets _network_ or _unsandboxed_ on the call and you are asked, even in Auto mode or with an `allow` permission rule; approving allows that one run without changing the settings. Developers can run `npm run test:sandbox` to check available backends with disposable fixtures; see [the test prerequisites](DEVELOPMENT.md#real-sandbox-tests). Linux bubblewrap and Docker probes have passed in an orb; macOS and Windows checks need their native hosts.

A sandboxed command and everything it starts may use at most 512 processes and 8 GB of memory, so a runaway test or fork loop cannot take the machine down ([#104](https://github.com/PierrunoYT/patch/issues/104)). Windows counts processes in the command's job and memory per process; on Linux, bubblewrap commands run in a transient systemd user scope that counts both for the whole command (threads count as processes there, without swap), and a command that goes over the memory limit is killed. Without a systemd user manager (`systemd-run --user`), Linux commands still run, without these limits, and the app log says so. Container mode passes the same limits to Docker or Podman. macOS has no such limits yet.

Cargo, Maven and Gradle expose only their binary/cache subdirectories, not home-level credentials or configuration; global Git configuration is hidden as well. Commands depending on these private settings need explicit unsandboxed approval. Secrets within the project or an exposed cache are still readable.

Native sandbox commands do not inherit arbitrary host environment variables, such as `DATABASE_URL`. Patch keeps only runtime/toolchain locations and Unix locale settings, sets home/temp paths deliberately, and does not run Unix login profiles. **Extra native sandbox environment variables** in Settings accepts host variable names, one per line (for example `CC` or `CMAKE_PREFIX_PATH`), not values or wildcard patterns. Adding grants requires native confirmation because a granted variable may expose a secret to commands and their model-visible output. Known runtime startup/injection variables and agent/display handles remain blocked even if listed. **Native sandbox PATH** optionally sets the complete search path (`;`-separated on Windows, `:`-separated on Unix), useful when a GUI app cannot discover a toolchain normally initialized by a login profile; a changed nonempty override also requires confirmation. These are global, user-controlled settings, not repository instructions or model tool inputs, and apply only to native sandboxes. Container commands retain their explicit environment. The terminal retains your normal environment; unsandboxed agent commands keep the older credential-name filter and may inherit other private values. Environment isolation is independent of output redaction.

The selected repository's entire `.git` directory is read-only in every backend (#98), including configuration, hooks, attributes and names that do not yet exist. Project edits and `git status`/`git diff` remain available, but Git writes (`add`, `commit`, `checkout`, `config`, `remote add`, etc.) require the Git panel or a separately approved unsandboxed command. The Git panel continues to disable hooks.

Folders without Git can run sandboxed commands (#109). Before launching, Patch writes a `.git` reservation file and protects it read-only, so commands cannot plant a repository or gitfile there. The file explains itself and is not a valid gitfile, so Git stops at the folder with "invalid gitfile format" instead of accepting a bare repository a command planted in the project folder (#129). It stays after the command, including failed or stopped runs, to keep overlapping commands protected. To create a repository, use **Initialize** in the Git panel, which removes it (it first stops the assistant's background commands in the project and restarts sandboxed MCP servers that use it, because a sandboxed program already running could otherwise write the new `.git`), or delete the file and run `git init` in your terminal. Projects that still have the empty `.git` folder of earlier versions are converted on the next sandboxed command. A project inside another repository (a folder of a monorepo, for example) keeps an empty `.git` folder instead, so Git still finds that repository. Next to an empty `.git` folder Git checks whether the project folder itself is a bare repository, which needs a readable `HEAD` file, so Patch also adds a protected empty `HEAD` folder there (#132). Git ignores empty folders, so the enclosing repository does not list it; you can delete it once the project has its own repository. An existing `HEAD` in such a project is protected read-only, and commands refuse to run if it already looks like a Git `HEAD` file. The Git panel also refuses implicit bare-repository discovery in the writable project root, and refuses **Push** and **Commit** when the repository's own config runs a file inside the project as a credential helper, SSH or askpass command, local receive/upload-pack or signing program (#130): commands the agent ran could have changed that file. Hooks are never run by the panel, but your own `git commit` in a terminal runs them, and a hook that runs project scripts (Husky running `npm test`) runs whatever the agent left there.

Husky's `core.hooksPath`, active hooks, aliases, filters, credential helpers, diff drivers and other existing command overrides no longer prevent sandboxed commands. Their configuration stays read-only, but this does not make an existing integration safe: hooks and other configured programs may execute writable project code when you run host Git in your terminal. The Git panel keeps its hook, filter and fsmonitor protections.

Gitfiles and shared directories are supported when all metadata is inside the selected project. Patch protects the `.git` pointer and the entire top-level directory containing each metadata target, preventing replacement through a writable ancestor. This may make neighboring files in that directory read-only too. Worktrees or submodules pointing outside the project still refuse execution; select a project containing the metadata or use an ordinary clone. Configuration includes are allowed only inside protected metadata directories, including transitive includes; writable, external and home-relative includes are refused because commands could plant new configuration there without touching `.git`. Symlinks/junctions, hardlinked metadata, special files and unreadable or invalid metadata remain unsupported; there is no 100,000-entry size refusal. Container mode also refuses comma-containing mount paths. Refusal never silently removes the sandbox. An unsandboxed approval explicitly gives up filesystem confinement and permits unrestricted network access; a network-only approval retains the sandbox but cannot fix an unsupported metadata layout. This boundary protects selected-root metadata, not nested repositories or arbitrary later terminal Git commands. Use a VM or separate account for untrusted repositories.

On Windows, the first sandboxed command in a project grants a per-project sandbox identity write access to the project; in a project with a large `node_modules` that one command can take several seconds. Later commands reuse the grant and start quickly, also after restarting Patch. Closing or removing the project in Patch removes the grant. A file moved into the project from another folder keeps its old permissions, so sandboxed commands cannot change it until the project is closed and opened again ([#140](https://github.com/PierrunoYT/patch/issues/140)); files created or copied in the project are fine. Each sandbox command receives its own writable temp folder and npm cache, removed when it ends or recovered after a forced helper exit. npm uses an empty private user config; host `.npmrc` credentials and the host temp/cache are not exposed. The sandbox's project PATH entries use its mapped drive, and PowerShell's execution policy is scoped to the sandboxed shell process. Node versions with libuv older than 1.53 (as of October 2026, every Node release) still hang on ordinary `node --test` ([#101](https://github.com/PierrunoYT/patch/issues/101), [upstream fix](https://github.com/libuv/libuv/pull/5181)). Where supported, explicitly use `node --test --test-isolation=none` or `npm test -- --test-isolation=none`; this runs test files together instead of in separate processes. Patch does not add the flag automatically, but when a sandboxed command times out on Windows, the result tells the agent about this workaround and about requesting an unsandboxed run. Tests requiring process isolation need a Node runtime containing the upstream fix or separately approved unsandboxed access.

### Network hosts allowed without asking

One hostname per line, matched exactly and on any port:

```
localhost
api.example.com
```

- `localhost` allows `http://localhost:3000/`. `example.com` does **not** allow `www.example.com`; list each subdomain.
- Approved hosts can receive whatever the assistant sends them, and this is not a network sandbox: page subresources and Google search are not filtered. Keep projects with secrets out of chats that read untrusted pages.

### Permission rules

**Settings → Permission rules (JSON)** takes a list of rules that decide a tool call before the usual approval. The first rule that matches wins; a call that matches none follows the normal rules.

```json
[
  {
    "tool": "run_command",
    "matches": { "command": "git push*" },
    "action": "reject",
    "message": "Do not push; ask me."
  },
  { "tool": "run_command", "matches": { "command": ["npm test*", "npm run lint*"] }, "action": "allow" },
  { "tool": "mcp_docs_*", "action": "allow" },
  { "tool": ["write_file", "edit_file"], "matches": { "path": "src/legacy/*" }, "action": "ask" },
  { "tool": "fetch_url", "action": "delegate", "to": "C:\\tools\\check-url.exe" }
]
```

- `tool` and each `matches` value are globs (`*` is any text, `?` one character); a list means "any of these". `matches` compares fields of the call: `command` for `run_command`, `path` for the file tools, `url` for `fetch_url` and `browser`.
- `allow` runs the call without asking. `reject` never runs it and tells the assistant your `message`. `ask` shows the approval card even in Auto mode. `delegate` starts the program in `to` without a shell. `to` is one program (a path or name, never split at spaces, so `C:\Program Files\check.exe` works) or a list such as `["node", "check.js"]`. On Windows, `.cmd`/`.bat` programs (including names such as `npx` found on PATH) run through `cmd.exe /d /s /c` with every part quoted; arguments containing `"`, `%`, `!` or line breaks are refused for them. It writes `{"tool", "input", "context"}` as JSON to its standard input and reads `allow`, `reject` or `ask` from its output; a program that fails, times out after 15 seconds or answers anything else rejects the call.
- `"context": "subagent"` (or `"thread"`) limits a rule to calls made by subagents (or by the chat itself).
- An `allow` rule beats the protected-files and MCP approval, so keep it narrow. Saving an `allow` or `delegate` rule asks for confirmation, as every switch to Auto mode does.
- Removing or changing an existing `ask`, `reject` or `delegate` rule also asks for native confirmation (a `delegate` program can answer ask or reject, and in Auto mode it may be the only check). Changing any preceding rule (including reordering rules) asks too, because an earlier match can bypass that protection. This conservative check can also confirm harmless changes. Cancelling keeps all settings unchanged; unchanged rules and adding protective rules at the end need no confirmation.
- A command allowed with `allow` is not checked for shell operators: `git status*` also matches `git status; rm -rf .`. Prefer the "Commands allowed without asking" list for commands.

### Hidden secrets

Before the assistant sees a tool result (a file it read, command output, a fetched page), private keys, cloud and Git host tokens, JWTs and values of credential-named variables (`password = "…"`, `API_KEY=…` lines) are replaced by `[REDACTED:_____]`. The same text is shown in the chat and saved with it. The assistant cannot write the placeholder into a file: `write_file`, `edit_file` and `apply_patch` refuse it, so a secret is never overwritten by the placeholder. Redaction recognises common formats only.

## MCP servers

Model Context Protocol servers give the assistant extra tools (a database, an issue tracker, documentation search, and so on). Add them in **Settings → MCP servers (JSON)** as a JSON list. A server either runs as a program on your computer (`stdio`) or is reached over HTTP (`http`):

```json
[
  {
    "name": "fs",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    "env": { "SOME_TOKEN": "…" }
  },
  { "name": "docs", "transport": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
]
```

- A `stdio` server starts in a private folder (`mcp` in Patch's user data folder), never in the open project, so a program or package planted in a repository cannot stand in for the one you configured. Its `command` must be a program name found on PATH or an absolute path; Patch looks it up only in PATH folders that don't depend on the working folder, and the confirmation names the program it found. To give a server the open project, write `${project}` in its `args` or `env` (for example `"args": ["-y", "@modelcontextprotocol/server-filesystem", "${project}"]`): Patch replaces it with the project's path, reconnects that server when you switch projects, and doesn't start it while no project is open.
- The line under the box shows each server's state: connected with its number of tools, connecting, or the error. A server that fails does not affect the others.
- Its tools appear to the assistant as `mcp_<server>_<tool>`. **Every MCP tool call asks for approval, even in Auto mode**, because a server can do anything its program or endpoint allows. The card names the server and tool and shows the call's arguments as JSON, so you can see what the server will be asked to do (for example which repository an issue goes to and what its body says) before you approve.
- `env` and `headers` are objects whose values are strings; they are stored encrypted, like API keys, and are not shown again. When you reopen Settings, each one appears with an empty value (`"SOME_TOKEN": ""`): leave it empty to keep the stored value, type a new value to replace it, or delete the line to remove it. Renaming a server drops its stored values, so enter them again after a rename.
- A stdio server starts in the project that is open when it connects, runs with your permissions, and keeps running until you change its settings or quit Patch.
- On Linux and Windows, `"sandbox": true` runs a stdio server in the command sandbox instead ([#87](https://github.com/PierrunoYT/patch/issues/87)): system and toolchain folders read-only, the rest of your home folder hidden, the same process and memory limits as commands, and no network unless `"sandboxNetwork": true`. It can write only its own folder (`mcp/sandboxed/<name>` in Patch's user data folder, which is also its `HOME`, kept between starts so `npx` or `uvx` caches survive) and, when its `args` or `env` name `${project}`, the open project, with Git metadata read-only as for commands. On Windows a server that names `${project}` starts with the project as its working folder (its own folder stays writable and is its `HOME`). A server that needs files elsewhere or network has to be granted them that way, or run unsandboxed. On macOS a sandboxed server does not start (its state says why) rather than run with your full rights. Turning a server's sandbox off, or its network on, asks for confirmation.

## Subagents and the todo list

For broad questions ("find every caller of this function", "summarize how settings are saved"), the assistant can hand the research to a **subagent** with the `task` tool. The subagent has its own context, so the main chat stays small, and it can only read: it lists folders, finds files, reads and searches files and loads project skills, but cannot edit files, run commands or use the web, so it never needs an approval. Its progress appears on the tool card while it works, its answer comes back to the assistant, and its tokens count toward the chat's totals. It stops after 25 steps. A file only the subagent read still has to be read by the assistant before it can be edited.

Two more read-only subagents work the same way: `finder` answers "where is X" questions on the provider's small model (the chat's own model on a custom endpoint), which is faster and cheaper, and `oracle` gives a second opinion on a hard problem (a bug, a design, a plan) on the chat's model. Settings → Subagent model can run `task` on a mid-size or small model instead (`oracle` stays on the chat model; a custom OpenAI base URL keeps the chat model). Settings → Subagent effort can run `finder` at low effort and `task` at medium. When the assistant asks for several read-only things in one turn (reads, searches, subagents), they run at the same time.

For a multi-step task the assistant may keep a **todo list** (`todo_list`): the steps it plans, with the one it is working on marked. The whole list shows on the tool card each time it changes. It is kept in memory for the chat only and starts empty when a saved chat is reopened.

## Stop and Resume

- **Stop** (the red button, or `Ctrl+.`) aborts the current request, running foreground commands and background commands belonging to the active project, including commands still starting. Other projects' background jobs and the interactive terminal are unaffected. It also cancels a wait before a retry.
- The composer then shows **Resume**. Resume continues the task from the conversation so far without you retyping the request. The assistant is told that an interrupted action may have partly happened, so it checks the current state before repeating anything with side effects.
- The Resume state is saved with the chat, so it is still there after you close the app and reopen the chat from the history.
- If the app crashes or is killed while a task runs, the chat shows **Resume** when you reopen it, whether the crash happened while the model was answering or while an action ran.
- Sending a new message instead of resuming drops the Resume option.

Resume continues from the conversation, not from an exact checkpoint. Look at the diff and Git panel after resuming a run that was stopped mid-command.

## When the provider has a problem

Rate limits (429), server errors (5xx) and dropped connections are retried automatically, up to 4 times, waiting longer each time or as long as the provider asks. Each retry shows a line in the chat, for example "Rate limited (429). Retrying in 2 s (retry 1 of 4)…". **Stop** works during the wait. If the retries run out, or the problem is one a retry cannot fix (a wrong key, an unknown model, no credit), the error is shown in the chat.

## Chats and projects

- **New chat**: `Ctrl+N`, or **New Chat** at the foot of the chat list. Chats are saved automatically.
- **Chat list** (**Sessions**, left): the tokens and estimated cost of all saved chats at the top, then the chats grouped by day (Today, Yesterday, Previous 7 days, Older), each with its project, when it was last saved and its estimated cost. The open chat is marked. **Filter chats…** narrows the list by title and project, and then by message text, like the history search. The foot shows whether `AGENTS.md` is loaded and the code index's state.
- **Chat history** (the header button next to the side panel button): search by title, project or message text (every word must match, and matching messages show an excerpt), open, delete one chat or clear all. Deleting removes the chat for good, also when it is open or in another project's tab, together with its edit backups; late title responses cannot restore it. Wait until a running task is stopped or an Undo finishes before deleting that chat. Each chat shows its estimated cost so far ("≈ $0.42"), as of its last save; chats on a custom endpoint or a model without a known price show none.
- **Several projects**: opening another project adds a tab. Each tab has its own chat and its own unsent draft. Stop the current task before switching; only one task runs at a time. Closing a tab keeps its saved chats.

### Compact a long chat

Every request re-sends the conversation, so a long chat gets slower and costs more, and eventually no longer fits in the model's context window. The status bar shows **Context: 96k / 1M**, the size of the last prompt against the model's context window (custom model ids show no window). From 150k it says "consider compacting" and the **Compact chat** button in the header (the first icon on the right) turns yellow.

Press it to have the older turns summarized. Standard provider chats use a small model (Claude Haiku 4.5 or GPT-6 Luna, according to the chat's provider and available keys). A custom OpenAI-compatible chat uses its own pinned model on that endpoint for the summary, which requires JSON-schema structured-output support. From then on the summary is sent in place of older turns, followed by the most recent part of the chat (roughly the last 10k tokens) exactly as it was.

- Your chat on screen does not change; a notice says how many messages were replaced. **Stop** cancels a compaction in progress and leaves the chat unchanged.
- Nothing is deleted. The saved chat file keeps every message, so a compacted chat can still be searched and exported in full. Compacting again later summarizes the previous summary together with what came after it.
- The first request afterwards re-reads the whole prompt once, so it costs like the first message of a chat. The summarizing request itself is not counted in the token totals.
- A summary can lose detail. If the assistant seems to have forgotten something, say it again. For a task that is nearly finished, starting a new chat can work better.
- Nothing happens for a short chat ("not enough older history"). Current Claude models also compact on the server side, and OpenAI chats otherwise drop their oldest turns once the context fills up. Manual compaction keeps a summary of those turns instead; custom endpoints must support the selected summarizer model and JSON-schema structured output. If they reject the summary request, the error is shown and the conversation is left unchanged.

### Export

The download button in the chat header (_Export chat_) asks where to save and writes the chat as a Markdown file: your messages, the assistant's answers, and the diffs and commands it proposed (an edit you undid is marked "(undone)"). Tool output and the assistant's thinking are left out.

## Settings

Besides the API keys, approvals and allow-lists described above, **Settings** has:

- **Model**, and **Other model id…** for a model that is not in the list. A chat keeps the model it started with.
- **Effort** (low, medium, high by default, xhigh, max): how much the model thinks before acting (current Claude and OpenAI models); higher is slower and costs more. Answers show the model's reasoning under a collapsed **Thinking** line.
- **Subagent model** (same as the chat by default, or mid-size, or small): the model `task` uses. It never moves `task` to a model that costs more than the chat's (a chat on the small model keeps it). `oracle` stays on the chat's model. `finder` stays on the small model.
- **Subagent effort** (match the chat by default, or lower for lookups): lower runs `finder` at low and `task` at medium. `oracle` keeps the chat's effort.
- **Plan mode**: see [Plan mode](#plan-mode) above.
- **Prompt cache** (off by default, Claude chats only): keeps the chat's prompt cache warm while you are away. Claude keeps a cached prompt for 5 minutes, so a reply after a longer pause writes the whole chat to the cache again (about $0.50 for a 100k-token chat on Claude Opus 5.5). With this on, Patch re-sends the chat about every 4 minutes after an answer, for up to an hour, without generating anything; each of these costs a cache read (about $0.02 for the same chat) and counts toward the chat's cost. It stops when you send the next message, compact the chat, close it, or when one fails. It sends requests you did not start, which is why it is off by default.
- **MCP servers**: see [MCP servers](#mcp-servers) above.
- **Theme**: dark or light.
- **Editor command**: what the **Open in editor** link on a tool card runs, e.g. `code`, `cursor` or `subl`.
- **ChatGPT**: **Sign in with ChatGPT** uses a ChatGPT account for official OpenAI models. The button starts the browser login immediately and does not wait for Save. **Sign out** drops the session. With both a session and an API key, and no custom base URL, official chats use the session.
- **OpenAI-compatible base URL**: for Ollama, OpenRouter, LM Studio and similar. Leave it empty for OpenAI itself. It must be an `http://` or `https://` URL. A custom URL always uses the API key, even when a ChatGPT account is signed in.
- **Claude base URL**: for a proxy or gateway in front of Claude (a company gateway, LiteLLM and similar). Leave it empty for api.anthropic.com. Claude chats, and Claude background work such as chat titles and Compact chat, go there with your Anthropic API key, so setting or changing it asks for confirmation; clearing it does not. It must serve the Anthropic Messages API, including the beta features Patch uses (server-side compaction, refusal fallback, prompt caching). Chats on a custom URL get no official-price estimate.
- **Google search engine id**: with a Google API key, turns on web search.
- **Maximum files to index for code search** (empty or below 1 uses the default, 2,000), and the current project's index status with a **Reindex** button.

The project menu (the sliders button in the header) has **Open folder…**, the recent projects and **Project settings…** for the open project (its instructions and its own allow-lists, see above). **Remove from recent** is on each recent project's row on the welcome screen, shown when no project is open.

## Side panel

The panel button in the header (terminal icon) shows or hides the side panel; drag its left edge to make it wider (or use the arrow keys on it). It has three tabs, and a footer with the Git sync state and the app version:

- **Terminal**: a normal shell in the project folder, separate from the commands the assistant runs. Press Enter in the panel to start it. The first time in each session for a project, Patch asks in a system dialog, because the shell runs with your full rights and is not sandboxed.
- **Git** (with the number of changed files on the tab): **Changed files**, each with its status letter (M, A, D, R, U for new, C for conflicted), the lines added and removed, and a discard button (which deletes new files, so it asks first); **Discard All** reverts everything after asking. **Diff preview** shows one hunk at a time of all changes, or of the file you click, with arrows to step through the hunks. **Generate** writes a commit message for the changes with the small model (Claude Haiku 4.5 or GPT-6 Luna, preferring the provider of the model in Settings; the diff, cut at 30,000 characters, is sent to that provider). **Commit & Push** commits everything in the project and pushes the branch to its upstream, or to `origin` (setting it as the upstream) when it has none; without a remote the button is **Commit all**, and with nothing to commit but unpushed commits it is **Push**. `Ctrl+Enter` in the message does the same. Pushing uses your own git setup (credential helper, SSH keys), but all Git-panel hooks are disabled, including pre-commit and pre-push. Use the terminal when trusted hooks are needed (including Git LFS uploads). The app cannot type a password, so a push that needs one fails with git's message, and the commit stays. **Initialize repository** is shown for folders that are not repositories yet. When the project is a folder inside a larger repository (a monorepo package, for example), the panel lists, diffs, discards and commits only the project's files, with paths relative to the project folder; changes elsewhere in the repository, staged or not, are left alone. Push, the branch and the ahead/behind counts still cover the whole repository.
- **Browser**: where the assistant checks web apps, and where you can look at them yourself. Type an address such as `http://localhost:3000` in the address bar. The assistant browses in its own session, shown under an **Agent browser** banner, which never has your cookies or sign-ins; it is emptied when you start or open a chat or switch projects. Typing an address switches back to your own page, and the toolbar button switches between the two. The assistant opens a project file (`file://`) without asking, so while its page is a project file its session has no network at all: the page can show other project files but cannot send anything anywhere or load scripts from the web. A page that needs a CDN or an API should be served (for example with a dev server) and opened over `http://localhost`.

Before a repository's first commit, the diff includes staged additions and any later working-tree changes. Discarding a renamed file restores its original committed path and removes the renamed destination, including edits to it; review the diff before confirming. Discarding a new link removes the link, never what it points to. An entry Git lists inside a linked folder (for example `link/file.txt` behind a Windows junction) is the linked file itself, so Discard refuses it and asks you to remove the link instead; **Discard all** discards everything else and names those entries.

## Where things are

- Settings, projects, saved chats and code indexes are in the app's user data folder. **Help → Show Log Folder** opens its `logs` folder.
- If Patch says a saved key could not be read, enter it again in Settings. This happens when Patch was closed abruptly (a crash, a forced exit or a power loss) within about 10 seconds of saving the first key on that profile, before the system encryption key reached the disk.
- `logs/app.log.jsonl` records crashes and other problems, one JSON line each, plus a line per start with the app and Electron version and platform. It holds error messages and stack traces (which can mention file paths), not your chat history or API keys, and it is never sent anywhere. Attach it when reporting a bug, after a glance at what is in it.
- The `PATCH_USER_DATA=<folder>` environment variable selects a profile directory. The default is `Patch` under the system application-data directory; to reuse an existing profile, point this variable at its folder.

## Costs

The status bar shows token totals and, for the built-in Claude and GPT-6 models, an estimated cost including cache reads and writes. Tokens that subagents (`task`, `finder`, `oracle`) spend on another model are priced at that model's rates. Custom OpenAI-compatible endpoints have no official price, so no estimate is shown. A request that fails part-way and is retried can be billed for the part that was already generated.
