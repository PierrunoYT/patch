# Patch Agent Evaluation Report

Based on an inspection of the agent architecture (`src/main/agent/`, `src/main/tools/`, `src/main/llm/`), test coverage, and measured benchmarks in `docs/PERFORMANCE.md`, **Patch's agent is unusually well-engineered, disciplined, and reliable**, especially around context management, prompt caching, crash recovery, and security boundaries.

Below is a breakdown of its measured benchmark performance, core architectural strengths, and current limitations.

---

## 1. Measured Benchmark Results (`docs/PERFORMANCE.md`)

The repository includes an automated real-API benchmark suite (`tests/bench/agent_tasks.bench.ts`) with self-testing tasks (`PATCH_BENCH_SELFTEST=1` verifies tasks fail before edits and pass with reference solutions):

- **Task solve rate (Claude Sonnet 5.5):** **24 / 24 runs solved (100%)** across 12 tasks (2 runs each):
  - **Small suite (5 tasks):** Bug fixes, adding a feature with hidden test cases, multi-file rename, codebase Q&A, and CLI off-by-one fix — solved in **5–17s** at **$0.014–$0.037** per run.
  - **Large suite (7 tasks on a ~10k LoC snapshot of Patch itself):** Diagnosing bugs from symptoms alone (`export-bug`), adding a full typed IPC channel following `AGENTS.md`, multi-file constant rename across code/tests/docs, writing tests evaluated against **mutation testing** (catching 3/3 injected mutants), and settings validation — solved in **13–81s** at **$0.03–$0.13** per run.
- **Agent loop overhead:** Only **~2 µs per turn and per tool call** (`tests/perf/agent_loop.perf.ts`).

---

## 2. Core Strengths in Agent Design

### A. Context & Token Efficiency

- **Byte-Identical Prompt Caching (`system_prompt.ts`, `anthropic.ts`, `task.ts`):**
  - The system prompt and tool definitions are constructed once per chat and kept byte-identical across turns (with MCP tools sorted deterministically).
  - **Shared Subagent Cache:** When a subagent (`task`, `oracle`, or `review`) runs on the same model as the main chat, it reuses the parent's exact system prompt and tool list (replacing write-tools with read-only stand-ins that have identical schemas) and puts the subagent role into the user message. This cut subagent cache writes by ~23% and overall task costs by ~21%.
  - **Cache Keep-Alive:** Optional background keep-alive (`max_tokens: 0`) refreshes Claude's 5-minute ephemeral cache every ~4 minutes for up to an hour, reducing follow-up cost after a pause by ~70%.
- **Non-Destructive Compaction (`llm/compaction.ts`):**
  - Never mutates stored conversation history (preserving append-only history and thinking blocks). Instead, it stores `{ summary, keepFrom }` and slices at a provider-safe boundary that never splits a tool call from its result or an OpenAI reasoning item from its call.

### B. Closed-Loop Verification & Self-Correction

- **Automatic Post-Edit Diagnostics (`agent/edit_check.ts`):**
  - After every tool batch that edits files, `EditChecker` can automatically run a project check command (e.g., `npx tsc --noEmit`) inside the sandbox, diff the output against the previous run's baseline, and append only **newly introduced errors** (or errors in the edited files) directly to the tool result.
- **Automatic Self-Review (`agent/self_review.ts`):**
  - Before the agent finishes a turn that modified files, it can spawn a read-only `review` subagent with unified diffs of all changes against the original `before` buffers and the user's prompt. If concrete problems are found, the loop continues automatically once to fix them.
- **Strict Tool Validation & Recovery (`agent.ts`, `anthropic.ts`):**
  - Uses Anthropic `strict: true` schemas on `edit_file` to prevent dropped fields in batched edits, re-issues turns if streamed JSON is malformed, and blocks execution of tool calls if the model turn was truncated by `max_tokens`.

### C. Multi-Tiered Subagents & Concurrency

- **Parallel Read-Only Execution:** Consecutive calls to `parallelSafe` tools (`read_file`, `grep`, `glob`, `find_definition`, `find_references`, `search_code`, and subagents) execute concurrently via `Promise.all` while preserving call order and isolating side-effecting tools.
- **Specialized Subagents (`tools/task.ts`):**
  - `finder`: Fast, low-cost model (e.g., Haiku 5.5) for locating files and line numbers.
  - `task`: Mid/chat model for broad codebase surveys in an isolated context window (capped at 25 turns).
  - `oracle`: High-effort advisor for architecture or debugging second opinions.
  - Files read by a subagent do **not** mark the file as read for the parent agent, enforcing the rule that the main agent must read a file itself before editing it.

### D. State Awareness & Crash Resilience

- **Outside-Change Detection (`agent/project_context.ts`):**
  - Injects a Git status summary on the first turn, and tracks mtimes/sizes of the last 200 read files plus `HEAD`/branch between turns. If you edit a file in your editor or switch branches between prompts, the agent is automatically notified on the next turn.
- **Crash & Stop Resume (`agent.ts`, `session.ts`):**
  - Checkpoints are written asynchronously after every tool batch. If the app crashes or is stopped mid-run, reopening the chat pairs any dangling tool calls with synthetic results and lets you **Resume** with an instruction telling the model to inspect state before repeating side effects.

---

## 3. Current Limitations & Open Areas for Improvement

1. **Regex-Based Symbol Navigation (`tools/symbols.ts` vs. LSP):**
   - `find_definition` and `find_references` use fast, multi-language regex declaration/word patterns rather than a full Language Server Protocol (LSP) type graph. They skip comments and strings well, but they are name-based rather than type-aware (tracked in issue `#272` for LSP integration).
2. **File Helper Process Overhead (`#306`):**
   - For security (preventing symlink/junction/hardlink races), every file read/write/patch spawns the native `file-helper` binary and passes file bytes as Base64 JSON rather than keeping a persistent helper process.
3. **Single-File `edit_file` vs. `apply_patch` Cost on Large Refactors:**
   - Because shell-based file edits (`sed`, PowerShell loops) are forbidden so the user gets diff previews and Undo support, multi-file renames use `edit_file` or `apply_patch`, which takes more model output tokens than a one-line shell script (though it is much safer).
4. **Benchmark Coverage Breadth (`#135`, `#105`):**
   - The recorded real-API benchmarks in `docs/PERFORMANCE.md` thoroughly test 12 small-to-medium tasks on Claude Sonnet 5.5, but multi-hour feature builds, concurrency bugs, and cross-model comparisons (Opus 5.5 vs. GPT-6 Astra/Sol) aren't yet part of the recorded baseline table.
5. **Upstream Windows Node Pipe Bug in AppContainer (`#101`):**
   - Due to an upstream libuv bug on Windows inside AppContainers, running `node --test` (without `--test-isolation=none`) hangs until timeout; Patch detects the timeout and hints the workaround to the agent rather than rewriting the command behind the scenes.

---

## 4. Verdict

As a local coding agent, **the engineering quality is very high**: it has 1,800+ unit tests and 130+ E2E tests (`project-map/data.js`), avoids the common traps that break coding agents (corrupted tool-call history on stop/crash, prompt cache invalidation on mode switches or subagents, blind edits without reading, and runaway regexes), and pairs strong agentic capabilities with strict OS-level sandboxing.
