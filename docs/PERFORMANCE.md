# Performance

## Long chats in the renderer (2026-09-30)

**Question:** does the chat UI need a virtualized or paginated message list for long chats?

**Answer:** not at this point. Three targeted changes roughly halved opening time and improved long-chat rendering, but the initial claim that a 5,000-item chat streamed as smoothly as an empty chat was based on an off-screen answer. The later [Windows bisection](#windows-bisection-2026-09-30) measured 14–21 ms median frames while actually following the answer, versus the earlier 7 ms off-screen result. [Grouping the items into chunks](#chunked-transcript-2026-10-01) removed that cost: a 5,000-item chat now streams at the empty chat's 7 ms median frame while following the answer, which the benchmark now checks. What remains is rendering the growing answer, which is the same in an empty chat.

### How it is measured

`npm run perf` (builds first) runs `tests/perf/long_chat.perf.ts`. The test is not part of `npm test` and asserts nothing. It writes its results to `out/perf-long-chat.json`.

- **The chat:** a synthetic saved chat of `PERF_TURNS` turns (default 250). Each turn has 5 items:
  - a request
  - a Markdown answer with a list and a 25-line highlighted code block
  - a `read_file` card
  - an `edit_file` card with a 30-line diff
  - a short reply
- **Open:** the time from `history:open` until the transcript is on screen and painted, measured in the page.
- **Streaming:** a 20,000-character answer (prose, lists, code blocks) streamed by the mock API as 400 deltas, 5 ms apart. The chat is streamed into twice: once empty, once after the long chat has been opened. Measured while it arrives:
  - `requestAnimationFrame` intervals (p50, p95, worst)
  - Chromium's script, layout and style-recalculation time, from the DevTools protocol's `Performance.getMetrics`
  - `maxBottomGapPx`, the view's largest distance from the bottom, sampled every 250 ms. Above 80 px the view was not following the answer, and the frame times measure an answer off screen that Chromium skips
- **Window:** the invisible e2e test window, with background throttling off.

Machine: Intel Core Ultra 9 285K (24 threads), 47 GB RAM, Windows 11, Electron 44.4.5, 144 Hz display (a 7 ms frame is a full frame rate). Treat the numbers as relative; they vary by machine.

### Results

1,000 turns (5,000 items):

|                                     | DOM nodes | Open     | Frame p50 / p95 while streaming | Layout / style during the stream |
| ----------------------------------- | --------- | -------- | ------------------------------- | -------------------------------- |
| Empty chat (reference)              | 1.8k      | —        | 7 / 14 ms                       | 0.48 s / 0.32 s                  |
| Before                              | 456k      | 3,205 ms | 42 / 49 ms (~24 fps)            | 1.94 s / 0.20 s                  |
| + `content-visibility: auto`        | 456k      | 2,472 ms | 28 / 35 ms                      | 0.62 s / 3.02 s                  |
| + update changed items in place     | 456k      | 2,465 ms | 7 / 14 ms                       | 0.07 s / 0.05 s                  |
| + build card bodies on first expand | 166k      | 1,104 ms | 7 / 14 ms                       | 0.07 s / 0.05 s                  |

250 turns (1,250 items):

|                         | DOM nodes | Open   | Frame p50 / p95 while streaming |
| ----------------------- | --------- | ------ | ------------------------------- |
| Before                  | 114k      | 841 ms | 7 / 21 ms                       |
| After all three changes | 41.5k     | 297 ms | 7 / 7 ms                        |

### What was slow, and what changed

1. **Layout of the whole chat on every streamed frame.** The transcript is a flex column, and the message being streamed changes on every frame, so Chromium re-laid out the whole list each time.
   - _Fix:_ `.transcript > *` (since then `.transcript-chunk > *`, see the chunked transcript below) got `content-visibility: auto` with `contain-intrinsic-size: auto 80px`. Items off screen are skipped for layout and paint, but stay in the DOM and the accessibility tree.
2. **Style recalculation of the whole chat on every frame.** This showed up once layout was cheap. Each frame, the streaming message's element was swapped for a new one, which invalidated the styles of its siblings (Bootstrap uses sibling and `:last-child` selectors).
   - _Fix:_ `TranscriptView` now updates a changed item's element in place (`morph`: same element, new attributes and children).
3. **Every finished tool card built its diff up front,** even though the card is collapsed. The diffs were most of the DOM (diff2html lays out a table row per line).
   - _Fix:_ a finished card's diff and output are built the first time the card is opened. Approval cards and running cards are unchanged.

### Follow-up: scrolling to the bottom (2026-09-30, 0.2.0 audit)

`content-visibility: auto` broke scrolling to the bottom. Items that were off screen count at their 80 px placeholder height until laid out, so:

- opening a chat of 200 tall items landed 3,300 px above the end;
- a new approval card appended while following the chat left Approve out of view.

The fix:

- after a chat is opened, the view jumps to the bottom again for 10 frames, and for 2 frames after an item is added;
- a view at the bottom stays there when the scroll area gets smaller;
- the user's own scrolling ends all of this.

`tests/e2e/transcript_view.test.ts` covers it.

**Cost, from three runs of each variant:**

| Streaming, frame p50 / p95 | 250 turns | 1,000 turns                              |
| -------------------------- | --------- | ---------------------------------------- |
| Before the fix             | 7 / 7 ms  | 7 / 14 ms (one run in three: 21 / 28 ms) |
| With the fix               | 7 / 21 ms | 14–21 / 28 ms                            |

Opening times are unchanged. For comparison, the same 1,000-turn chat was at 42 / 49 ms before the three changes above.

**Other ways that were measured and dropped:** each made streaming in the 1,000-turn chat two to three times slower.

- following every height change, with a frame loop or with a ResizeObserver on the transcript;
- laying out the newest items with an inline `content-visibility` style.

**Resolved by the later Windows bisection:** the old benchmark was not following the answer, so Chromium skipped its off-screen layout. Correctly following a visible answer exposes the layout cost of the long transcript; see [Windows bisection](#windows-bisection-2026-09-30).

**The benchmark is noisy:** the same build sometimes measures 7 ms and sometimes 21 ms, so compare at least three runs.

#### Linux orb follow-up (2026-09-30)

The regression was investigated again in a 4-vCPU Linux orb with Electron under Xvfb. This environment is much slower
than the Windows/144 Hz machine above, so these numbers are separate evidence and must not be compared directly with
that table. The measured command (after `npm run build`) was run three times for each variant:

```bash
E2E_SHOW_WINDOW=1 PERF_TURNS=1000 xvfb-run -a npx vitest run --project perf tests/perf/long_chat.perf.ts
```

`E2E_SHOW_WINDOW=1` matters under Xvfb: without it Chromium rendered the hidden window at about 1 frame/second, making
frame percentiles meaningless. With the checked-in implementation, the 5,000-item stream measured 50 / 67 ms p50 /
p95 in all three runs (layout 431, 450 and 429 ms; open 2,856, 2,789 and 3,013 ms). The empty-chat reference was 17 /
50 ms in all three runs, showing that this constrained orb cannot reproduce the original 7 ms reference either.

Tracing `TranscriptView.render()` confirmed one synchronous geometry path during each followed streaming update: it
reads `scrollHeight`, `scrollTop` and `clientHeight` to decide whether to follow, then assigns `scrollTop` from
`scrollHeight`. Two bounded candidates were measured and dropped:

- Caching the follow state removed the decision read but left the exact-bottom write. Three runs remained 50 / 67–83
  ms, with 434–452 ms of layout: no improvement.
- Caching the state and throttling the exact-bottom write to every 50 ms (plus a final write when streaming finished)
  reduced layout to 378–393 ms, but frame results remained 50 / 67–83 ms. The transcript E2E checks, extended locally
  to cover following a growing answer and stopping after a user scroll, passed, but the frame result did not justify
  the added timing and input-state complexity.

Removing the write entirely was not viable: a tall streamed answer finished about 740 px above the bottom, so browser
scroll anchoring does not preserve resize-follow here. No renderer change was kept. A useful next experiment needs a
Windows/high-refresh environment that reproduces the 14–21 ms regression; the Linux orb evidence bounds geometry
bookkeeping to part of layout cost, not the observed frame regression.

#### Windows bisection (2026-09-30)

Reproduced on the Windows machine (1,000 turns, three runs per variant, layout time during the stream):

| Variant                                                      | Frame p50 / p95 | Layout         |
| ------------------------------------------------------------ | --------------- | -------------- |
| Before the scroll fix (`ed40da2`)                            | 7 / 7 ms        | 74–77 ms       |
| Current (`af50695`)                                          | 14–21 / 21 ms   | 1,161–1,203 ms |
| Current, without the focus check in `render()`               | 14–21 / 21 ms   | 1,157–1,193 ms |
| Current, without the `ResizeObserver`                        | 14–21 / 21 ms   | 1,175–1,187 ms |
| Current, with block layout instead of flex for `.transcript` | 14–21 / 21 ms   | 1,084–1,087 ms |
| Current, without any scroll-to-bottom writes                 | 7 / 7 ms        | 77 ms          |

Finding: the regression is not a cost of the new code. Before the scroll fix, the jump to the bottom landed short, so the
view was not at the bottom, `stick` was false and the streamed answer sat off screen, where `content-visibility` skips
it. The 7 ms was the benchmark measuring a chat that was not following. With the view really at the bottom (what users
see), the streamed item is on screen and is laid out on every frame. The extra 0.6 s of layout over the empty chat
(0.5 s) is the price of 5,000 `content-visibility: auto` siblings around it; none of the small pieces accounts for it.

Ruled out: the focus check, the `ResizeObserver` and flex layout (a small gain, not kept). Grouping the items into
`content-visibility` chunks, measured next, fixed it.

#### Chunked transcript (2026-10-01)

`TranscriptView` now places items in `.transcript-chunk` containers of 50 (`CHUNK_SIZE`). Each chunk is a flex column
with `content-visibility: auto` and `contain-intrinsic-size: auto 6000px`, and the items inside keep their own
`content-visibility: auto`. A frame at the bottom of a 5,000-item chat lays out 100 chunks, almost all skipped, plus
the 50 items of the last chunk, instead of 5,000 siblings. An item's chunk is fixed by its position, so a streamed
update still changes one element in place.

Windows machine above, 1,000 turns (5,000 items), same build apart from the change. Three runs with chunks, two
without. In every run of both variants the view stayed 1 px from the bottom (`maxBottomGapPx`), so both measure a
followed, visible answer:

| 5,000-item chat while streaming | Frame p50 / p95 | Frames drawn | Layout      | Script      |
| ------------------------------- | --------------- | ------------ | ----------- | ----------- |
| Empty chat (reference)          | 7 / 21 ms       | 672–683      | 0.65–0.67 s | 2.26–2.29 s |
| Without chunks                  | 21 / 35 ms      | 300–322      | 1.26–1.28 s | 2.08 s      |
| With chunks                     | 7 / 21–28 ms    | 521–652      | 0.63–0.68 s | 2.91–3.19 s |

Layout during the stream is back to the empty chat's, and twice as many frames are drawn. Script time is higher
because more frames means more renders of the growing answer's Markdown (see "Not changed, and why" below); per frame
it is lower. Opening is unchanged (1.14–1.27 s). `tests/e2e/transcript_view.test.ts` checks that 200 items land in
four chunks in order, and that opening at the end, following a new approval card and Undo focus still work.

### Not changed, and why

- **Re-rendering the streaming message's Markdown on each frame.** The whole answer so far is re-parsed, highlighted and sanitized on every frame: about 2.2 s of script over the 20,000-character answer, or about 3 ms per frame. This cost depends on the answer, not the chat, and is the same in an empty chat. If very long answers stutter, render only the last Markdown block while streaming.
- **Opening still renders every message's Markdown** (about 0.2 ms per item). A 5,000-item chat opens in about 1.1 s. Rendering off-screen messages lazily, or full virtualization, would help chats far longer than this. It would cost scroll-position bookkeeping and would break Find in page and the screen-reader view of the full chat, so it is not worth it yet.
- **The main process** also applies every streamed event to its own copy of the transcript. This was measured afterwards; see the next section.
- **`Performance.getMetrics` did not attribute the opening's script time** (it reported about 2 ms), so opening is measured by wall-clock time in the page instead.

## Streamed events in the main process (2026-09-30)

**Question:** in a long chat, does the main process slow down while an answer streams? `ChatSession` applies every streamed event to its own copy of the transcript (`applyChatEvent`, which builds a new item list for each event) before sending the event to the UI.

**Answer:** no, not at any chat length the renderer handles well. The cost grows with the chat, but stays small next to the rest of the main process's work.

### How it is measured

`npm run perf` also runs `tests/perf/main_process.perf.ts` and writes `out/perf-main-process.json`.

- It runs in Node, without the app.
- A real `ChatSession` opens saved transcripts of 0 to 20,000 items (the same generator as the renderer measurement, `tests/perf/long_transcript.ts`).
- A scripted model streams a 16,000-character answer in 10-character pieces, about 1,600 events, a busy stream.
- Timed: the whole answer through the session; `applyChatEvent` alone for the same events; and serializing each event the way sending it to the UI does. Each is the median of 5 runs after a warm-up.

`tests/perf/long_chat.perf.ts` also reports `mainCpuMs`, the main process's CPU time while an answer streams in the real app, from Electron's `app.getAppMetrics()`.

### Results

Same machine as above. The numbers were stable across three runs.

| Chat         | Per streamed piece | One whole answer (1,594 pieces) | Of that, `applyChatEvent` |
| ------------ | ------------------ | ------------------------------- | ------------------------- |
| empty        | 1 µs               | 1 ms                            | 0.2 ms                    |
| 1,250 items  | 8 µs               | 12 ms                           | 11 ms                     |
| 5,000 items  | 30 µs              | 48 ms                           | 35 ms                     |
| 20,000 items | 230 µs             | 370 ms                          | 355 ms                    |

- **Serializing the events for the UI:** 0.2 ms per answer at every size.
- **Main-process CPU in the real app:** measured while the 1,000-turn benchmark streams its answer, in 400 pieces over about 2 s.

  | Chat        | Main-process CPU |
  | ----------- | ---------------- |
  | empty       | 251–254 ms       |
  | 5,000 items | 192–222 ms       |

  The difference is within the noise. The transcript copies cost about 12 ms of that stream, which is lost among the rest of the main process's work: parsing the stream, IPC and saving.

### Conclusion

- **Linear up to 5,000 items, faster than linear after.** The cost grows linearly with the chat up to 5,000 items. From 5,000 to 20,000 items it grows 7.5 times for 4 times the items, probably because of garbage collection.
- **Where it could start to matter:** at 20,000 items and a fast stream of about 100 pieces a second, the copies would take roughly 2% of a core.
- **Nothing to change now.** If chats that long become common, the fix is to update the streaming item in place in the main process's copy, which is not shared with anything. The renderer already needs new objects for its own copy.

### Crash-resume checkpoints (2026-09-30)

A crash-resume checkpoint wrote the whole chat synchronously after every tool-result batch: pretty-printed JSON, including base64 screenshots. Until #17 it also rewrote the chat index and sent a `history:changed` broadcast; checkpoints now skip both (see "Checkpoints skip the index" below), and since #55 the file is written in the background (see "Checkpoints are written in the background" below). Quick read-only batches, and batches that return browser screenshots, block the main process once per batch, and the stall grows with the chat. Checkpointing only batches that need approval or change state, or skipping the index rewrite and the broadcast until the run finishes, is tracked in [#17](https://github.com/PierrunoYT/patch/issues/17). Measured in [The agent loop](#the-agent-loop-2026-10-01) below.

## The agent loop (2026-10-01)

**Question:** how much time does Patch itself add to an agent run, apart from the model and the tools' own work?

**Answer:** almost none. The loop costs about 2 µs per turn and per tool call. The one agent-loop cost that matters is the crash-resume checkpoint: 30–77 ms of blocked main process per tool batch in a long chat, mostly the file write.

### How it is measured

`tests/perf/agent_loop.perf.ts` (part of `npm run perf`, output in `out/perf-agent-loop.json`) runs the real `Agent`, tools, `ChatStore`, task tool and `McpHub` in Node, without the app. A scripted model answers instantly, so every measured millisecond is Patch's own work. Each number is the median of 5–20 runs after warm-up runs. The table shows the range over three full runs.

Same machine as above, Electron 44.4.5, Node 24.

### Results

| Scenario                                                | Time           | Per unit          |
| ------------------------------------------------------- | -------------- | ----------------- |
| 200 turns without tools                                 | 0.35–0.45 ms   | 2 µs per turn     |
| One batch of 10 / 50 no-op tool calls                   | 0.02 / 0.08 ms | 2 µs per call     |
| 20 tool calls, each needing approval (approved at once) | 0.04 ms        | 2 µs per call     |
| 20 real `read_file` calls (4 KB files)                  | 13.5–16 ms     | 0.7 ms per call   |
| Subagent (`task`): 5 `read_file` calls and an answer    | 3.4 ms         | = its five reads  |
| MCP stdio server: start, connect, list tools            | 41–42 ms       | once per server   |
| 50 MCP calls to an echo server, one after another       | 3.6–4.2 ms     | 72–84 µs per call |

Checkpoint saves (`ChatStore.save`: the whole chat as pretty-printed JSON, written through a temporary file and a rename, plus the chat index). The chat holds the transcript and the provider conversation, which repeats the same content:

| Chat                           | File size | `JSON.stringify` alone | Whole save |
| ------------------------------ | --------- | ---------------------- | ---------- |
| 1,250 items                    | 1.6 MB    | 1.8 ms                 | 30 ms      |
| 5,000 items                    | 6.4 MB    | 7.5–7.9 ms             | 13–77 ms   |
| 20,000 items                   | 25.9 MB   | 31–32 ms               | 52 ms      |
| 5,000 items and 10 screenshots | 8.4 MB    | 9.2–9.4 ms             | 16 ms      |

Serialization grows linearly with the chat. The write does not: the same 6.4 MB save took 13–15 ms after another save in the same run, and 77 ms when run on its own. Every save creates a new temporary file, which Windows scans before the rename, so the write time depends on the file system and antivirus more than on the size.

### Conclusions

- **The loop is not a bottleneck.** A model turn takes seconds; Patch's own work per turn and per tool call is measured in microseconds. A tool's cost is its own I/O (0.7 ms for a `read_file`).
- **Checkpoints are the cost to fix ([#17](https://github.com/PierrunoYT/patch/issues/17)).** Since crash-resume, every tool batch blocks the main process for a full save: 30–77 ms in a 1,250–5,000-item chat, which delays streaming and IPC for several frames. Serialization is only 2–8 ms of that; the synchronous write is the rest. Writing asynchronously (serialize, then write off the main thread's critical path), skipping the index rewrite per checkpoint, or checkpointing only batches that change state would remove most of it.
- **MCP costs about 40 ms per stdio server at startup** (starting a Node process), then well under a millisecond per call on top of the server's own work.
- **The subagent adds no measurable overhead** beyond the tool calls and model turns it makes.

### Checkpoints skip the index ([#17](https://github.com/PierrunoYT/patch/issues/17))

A checkpoint now writes only the chat file. The chat index is rewritten and `history:changed` is sent only by the regular saves (debounced changes and the end of a run), or when the chat is not in the index yet. That removes the index write and the broadcast from every tool batch. The numbers in the tables above are from before this change.

### Checkpoints are written in the background ([#55](https://github.com/PierrunoYT/patch/issues/55))

A checkpoint of a chat that is already in the index now only serializes the chat in the call (`ChatStore.save` with `checkpoint`). The file is written in the background and moved into place when it is complete (`writeJsonLater` in `src/main/storage/json_file.ts`), still through a temporary file and a rename. One write per chat runs at a time; a checkpoint made while one is running replaces the content that is waiting, so checkpoints land in order. Every other save stays synchronous and replaces a checkpoint that has not landed. A chat that is not in the index yet is saved and indexed synchronously, as before.

Measured with `tests/perf/agent_loop.perf.ts` on a different machine from the tables above (AMD Ryzen 9 9900X, 62 GB RAM, Windows 11, Node 26), so compare the columns with each other, not with the earlier tables. Range over three runs:

| Chat                           | Synchronous save (before) | The checkpoint call | Main thread busy until on disk | Until on disk |
| ------------------------------ | ------------------------- | ------------------- | ------------------------------ | ------------- |
| 1,250 items (1.6 MB)           | 3.5–6.7 ms                | 1.6–3.6 ms          | 2.6–6.1 ms                     | 3.6–8.4 ms    |
| 5,000 items (6.4 MB)           | 11–22 ms                  | 7.1–12 ms           | 9.6–18 ms                      | 12–24 ms      |
| 20,000 items (25.9 MB)         | 39–43 ms                  | 23–26 ms            | 29–33 ms                       | 37–41 ms      |
| 5,000 items and 10 screenshots | 11–12 ms                  | 6.3–6.4 ms          | 8.9–9.0 ms                     | 12 ms         |

"Synchronous save" is a full save (the chat file and a one-entry index), which is what a checkpoint cost before, plus the small index write. "Main thread busy" is the event loop's own utilization counter from the call until the file is in place: the call, then encoding the text to bytes and the rename in later turns.

- **The longest block is now the serialization.** The checkpoint call takes as long as `JSON.stringify` alone, about 55–60% of the synchronous save on this machine, and the rest of the main-thread work (1–7 ms) runs in later turns, so other events are handled in between.
- **The gain depends on how slow the write is.** On this machine the write is fast (a few milliseconds), so the total main-thread work only drops by 15–25%. On the machine of the earlier tables the write was the larger part (13–77 ms for a 6.4 MB chat, 2–8 ms of it serialization); that part no longer blocks. It has not been re-measured there: re-run `npm run perf`.
- **What is left is `JSON.stringify`**, which grows linearly with the chat (about 1 ms per MB here). Removing it would need a different format (appending to the chat file instead of rewriting it) or serializing in a worker, which first has to copy the chat there.
- **What a kill can lose:** a checkpoint that is still being written when the process is killed is lost, and the chat resumes from the checkpoint before it. That window is the "until on disk" column. The end-to-end kill tests (`tests/e2e/crash_kill.test.ts`) pass unchanged.

### Re-run of the renderer and main-process benchmarks (2026-10-01)

After the MCP, plan mode, subagent, skills and UI-redesign merges, same machine, three runs each:

- **Main process, per streamed event:** unchanged within noise: 12.3 / 50.9 / 358 ms per answer at 1,250 / 5,000 / 20,000 items (2026-09-30: 12 / 48 / 370 ms).
- **Renderer, 250 turns (1,250 items):** opening takes 295–312 ms (297 ms). While an answer streams, frames are p50 8 ms and p95 23 ms. The 7 ms p95 in the first table above was measured with the answer off screen (see the Windows bisection); following the answer costs more, which is [#19](https://github.com/PierrunoYT/patch/issues/19).
- **The UI redesign** (`9231ee4`), measured against the commit before it: layout time while streaming went from 0.68 s to 0.82 s in the long chat, and from 0.48 s to 0.64 s in the empty chat (20–35% more). Frame p95 was 17–22 ms before and 23 ms after, so frame times barely changed. The extra layout is the new card borders, shadows and composer box; worth keeping in mind for #19.

## Agent task benchmark (2026-10-01)

**Question:** does the agent, as built, reliably finish everyday coding tasks, in tiny projects and in a real codebase, and what does a task cost?

**Answer:** yes for these 12 tasks. Claude Sonnet 5.5 solved all 24 runs (12 tasks, 2 runs each):

- **Small suite:** 5 tasks in tiny projects, solved in 5–17 s for $0.014–0.037 each ($0.24 for 10 runs).
- **Large suite:** 7 tasks in a copy of this repository, solved in 13–81 s for $0.03–0.13 each ($1.08 for 14 runs).

The runs of each task were consistent, and every failed tool call was recovered within the run.

### How it is measured

`npm run bench:agent` (`tests/bench/agent_tasks.bench.ts`, tasks also in `tests/bench/large_tasks.ts`, output in `out/bench-agent-tasks-<suite>.json`) drives the built app against the **real** Anthropic API, so it spends credits. It is opt-in and not part of `npm test` or CI:

```bash
PATCH_BENCH_PROFILE=<a Patch profile folder with a saved Anthropic key> npm run bench:agent
# only one suite:            PATCH_BENCH_SUITE=small   or   PATCH_BENCH_SUITE=large
# prompt cache suite:        PATCH_BENCH_SUITE=cache   (not part of all; PATCH_BENCH_PAUSE_SECONDS, default 360)
# plan mode suite:           PATCH_BENCH_SUITE=plan    (not part of all)
# check the tasks, no API:   PATCH_BENCH_SELFTEST=1 npx vitest run --project bench
```

- **The key:** only `settings.json` and `Local State` are copied from that profile into a throwaway profile (the key stays encrypted, and `Local State` lets the same OS user decrypt it). The copy's MCP servers are cleared, and it is deleted afterwards. The real profile is never written to.
- **The run:** each run starts the app on a fresh copy, opens a fresh temporary project, sets the model (`PATCH_BENCH_MODEL`, default `claude-sonnet-5-5`) and **Auto** mode, sends the task in a new chat, and waits until the assistant is done. In Auto mode the model runs commands without asking, inside the temporary project.
- **Scoring:** afterwards an objective check decides whether the task was solved, from the project files and the answer, often with a test the model never saw. `PATCH_BENCH_REPS` (default 2), `PATCH_BENCH_SUITE` and `PATCH_BENCH_TASKS` (comma-separated ids) choose what runs.
- **Self-test:** `PATCH_BENCH_SELFTEST=1` runs every check without the API. It must reject the untouched project, and for the large suite accept a reference solution, so no task can be passed by doing nothing, and none is impossible.
- **Cache suite** (`tests/bench/cache_tasks.ts`, `PATCH_BENCH_SUITE=cache`): prompt caching on a copy of this repository, so the chat is big enough for cache writes to matter. It is not part of `all`, because each pause run waits several minutes. `subagent-question` tells the model to delegate a question to the `task` subagent; a run that does not call `task` does not count as solved. `pause-followup` asks a question, leaves the app idle for `PATCH_BENCH_PAUSE_SECONDS` (default 360, past the 5-minute cache), then asks a follow-up; `pause-followup-warm` is the same with Settings → Prompt cache on. Runs with a follow-up report usage per phase (`phases`: first turn, pause, follow-up), so the follow-up's cache writes and the keep-alives' own cost show separately.
- **Plan suite** (`PATCH_BENCH_SUITE=plan`): small tasks with Settings → Plan mode on or off. Plan cards are approved as soon as they appear. With plan mode on, `add-feature` and `rename` count as solved only if `propose_plan` came before the first edit or command (`plannedFirst`), and `question` only if no plan was proposed; with plan mode off, any `propose_plan` call fails the run. Not part of `all`. Results are saved after every run, so an interrupted benchmark keeps what it measured.

**Small suite:** five tiny projects using Node's built-in test runner, so no `npm install` is needed:

| Task          | What the model is asked                                  | How it is checked                                                  |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| `fix-bugs`    | Make failing tests pass without changing them (two bugs) | `node --test` passes and the test file is unchanged                |
| `add-feature` | Add `slugify` and tests for it                           | Hidden test cases pass, the test file uses it, `npm test` passes   |
| `rename`      | Rename a function in four files, tests included          | No old name left, the new one is exported, tests pass              |
| `question`    | Say where the retry delay is computed and its maximum    | The answer names the file, function and 8,000 ms; no file changed  |
| `cli-fix`     | Fix an off-by-one in a CLI and check it by running it    | The command prints the right lines for `--count 3` and no argument |

**Large suite:** seven tasks on a copy of this repository at a pinned commit (`LARGE_BASE`, currently `8b0d536`): about 10k lines of TypeScript with its unit tests, typecheck and `AGENTS.md`, which the app adds to the model's instructions.

- **Isolation:** each run gets a fresh copy with no git remote, so nothing can be pushed, and a shared copy of `node_modules`, not the checkout's.
- **Bugs:** tasks that need one inject it by exact text replacement. After a newer `LARGE_BASE`, run the self-test to confirm they still apply.
- **Instructions:** every prompt ends with "don't commit or push; check with `npm run typecheck` and `npm run test:unit`, not the end-to-end tests".

| Task               | What the model is asked                                                               | How it is checked                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `export-bug`       | Fix exported file names that keep `?` and `\` (a symptom, no file named)              | Existing tests unchanged and passing, plus hidden cases for `?`, `\`, `:`, `\|`, `*`         |
| `retry-limit`      | Failing requests are retried 5 times, the README promises 4: fix the code             | Retry tests unchanged and passing, `MAX_RETRIES` still 4, README unchanged                   |
| `ipc-channel`      | Add a `history:count` IPC channel following the repository's rules                    | Channel in the type map **and** the `INVOKE` list, a handler in `index.ts`, typecheck passes |
| `rename-constant`  | Rename `TRANSCRIPT_LIMITS` to `TRANSCRIPT_CAPS` in code, tests and docs               | Old name nowhere in `src/`, `tests/`, `docs/`, README, AGENTS.md; typecheck and tests pass   |
| `write-tests`      | Write tests for the network allow-list (the existing tests are removed first)         | New tests pass and catch at least 2 of 3 injected bugs (mutants) in the source               |
| `question-decline` | What happens to the rest of a tool batch after a decline without feedback, and where? | The answer names `agent.ts`, `runTools` and that the rest is not run; no file changed        |
| `settings-cap`     | Cap `maxIndexedFiles` at 50,000 when settings load or save, with a test               | Hidden test of load and save, a new test mentioning 50,000 passes, typecheck passes          |

### Results

`requests` is the model-call count and `messages` is assistant text; the rows below leave Requests unset because they predate that count.

Small suite, Claude Sonnet 5.5, 2 runs per task, on the machine above:

| Task          | Solved | Time    | Tool calls | Requests | Output tokens | Cache read / write (tokens) | Cost         |
| ------------- | ------ | ------- | ---------- | -------- | ------------- | --------------------------- | ------------ |
| `fix-bugs`    | 2 / 2  | 10–11 s | 7          | —        | 684           | 17.8k / 5.6–5.7k            | $0.024       |
| `add-feature` | 2 / 2  | 10–14 s | 6–7        | —        | 1.2k          | 11.4k / 5.5–5.7k            | $0.029       |
| `rename`      | 2 / 2  | 15–17 s | 14         | —        | 1.5k          | 24.0k / 6.6k                | $0.036–0.037 |
| `question`    | 2 / 2  | 7 s     | 2          | —        | 500–540       | 6.8k / 3.9k                 | $0.016–0.017 |
| `cli-fix`     | 2 / 2  | 5–7 s   | 3          | —        | 316–317       | 6.6k / 3.8k                 | $0.014       |

- **Prompt caching works:** uncached input was 8–14 tokens per task; everything else was read from or written to the cache. About 3.8k tokens (system prompt and tools) are written to the cache once per new chat, which is most of the cost of a short task.
- **Failed tool calls are the model's own checks.** `fix-bugs` had one failed tool call in each run. A rerun that records them showed it was the model's first `npm test`, which exits 1 because the tests fail before the fix. `rename` had one in each of the first two runs and none in the rerun, so its cause was not recorded.

Large suite, Claude Sonnet 5.5, 2 runs per task:

| Task               | Solved | Time    | Tool calls | Requests | Output tokens | Cache read / write (tokens) | Cost         |
| ------------------ | ------ | ------- | ---------- | -------- | ------------- | --------------------------- | ------------ |
| `export-bug`       | 2 / 2  | 32–42 s | 5–11       | —        | 1.0–1.7k      | 20k–77k / 9–13k             | $0.036–0.064 |
| `retry-limit`      | 2 / 2  | 33–35 s | 6          | —        | 1.0k          | 40k / 14k                   | $0.053–0.054 |
| `ipc-channel`      | 2 / 2  | 45–53 s | 19–22      | —        | 2.7–3.0k      | 121k / 18–20k               | $0.097–0.106 |
| `rename-constant`  | 2 / 2  | 29–31 s | 3–4        | —        | 0.9k          | 12k–19k / 8k                | $0.032–0.033 |
| `write-tests`      | 2 / 2  | 72–81 s | 6–8        | —        | 7.4–8.3k      | 43k–47k / 14–16k            | $0.116–0.133 |
| `question-decline` | 2 / 2  | 13–17 s | 4          | —        | 1.0k          | 38k–52k / 13–17k            | $0.049–0.063 |
| `settings-cap`     | 2 / 2  | 57–60 s | 24–26      | —        | 3.7–3.8k      | 159k–161k / 21k             | $0.123–0.124 |

- **It follows the repository's rules.** `ipc-channel` added the channel to both the type map and the `INVOKE` list, plus a handler, as `AGENTS.md` requires, in both runs. `retry-limit` fixed the comparison rather than changing `MAX_RETRIES` or the README.
- **It finds bugs from symptoms.** `export-bug` names no file; both runs found the export file-name function and fixed it so the hidden cases pass too.
- **Its tests catch real bugs.** Both `write-tests` runs caught all 3 mutants. This task also showed that the repository's own tests for this function caught only 1 of the 3 (no non-HTTP URL with a host, no padded list entry). They were strengthened on 2026-10-01 (`7bf7e3f`).
- **Failed tool calls were recovered within the run:** 6 in 14 runs:
  - a `grep` with no matches;
  - in both `rename-constant` runs, a PowerShell loop the model wrote to replace the name in three files, which failed and was fixed on the next try;
  - its own new tests failing on the first run, then fixed;
  - one `edit_file` whose `old_string` did not match.
- **Cost grows with exploration, not codebase size.** `settings-cap` and `ipc-channel` read the most (about 120–160k cached tokens over 20+ tool calls), but still cost about $0.10–0.12 because almost all of it is cache reads.
- **Not counted:** the cost column is the Anthropic API only. When an OpenRouter key is saved, `search_code` embeds the project for semantic search, which adds a few cents per large run.
- **Reading the numbers:** 12 tasks, two runs each, on one model. The benchmark is a regression check for the app (tools, prompts, the agent loop) rather than a measure of model ability. Rerun it after changing the system prompt, tool descriptions or the loop, and compare solved counts, tool calls and cost. Harder, longer tasks (multi-step features, flaky or concurrency bugs, larger refactors) and other models (Opus 5.5, GPT-6) are not covered yet.

### Edits through the shell (#45, 2026-10-01)

In both runs of `rename-constant` above, the model renamed the constant with a PowerShell loop through `run_command` instead of `edit_file`. Such a change gets no diff preview, no per-file approval and no Undo. The system prompt and `run_command`'s description now say to change files only with `edit_file` and `write_file` (with `replace_all` for one string in many files), never with shell commands. The benchmark records tool calls by name (`toolsByName`) and flags runs that changed project files without the edit tools (`editedWithoutEditTools`).

Rerun of both rename tasks, Claude Sonnet 5.5, 2 runs each:

| Task              | Before                                                | After                                                                         |
| ----------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `rename-constant` | PowerShell loop in 2 of 2 runs; 29–31 s; $0.032–0.033 | `edit_file` in 2 of 2 runs (4–6 calls), no shell edits; 38–44 s; $0.071–0.075 |
| `rename` (small)  | `edit_file`; 15–17 s; $0.036–0.037                    | `edit_file` (4–6 calls), no shell edits; 13–15 s; $0.032–0.034                |

All four runs were solved. Editing file by file costs more round trips, so the larger rename costs about twice as much; every change is now previewable and can be undone. The `rename-constant` runs had 1–3 failed `edit_file` calls each, recovered within the run; their reason will show once failed tool cards carry it (#47). The small `rename` task's one failed call (#43) is the model's own check, `grep -rn getUserName …`, which exits 1 when nothing is left to find.

### Prompt cache changes (#77, 2026-10-03)

**Question:** what did the prompt cache changes save on real tasks?

**Answer:** about a fifth of the cost. All 12 tasks, 2 runs each on Claude Sonnet 5.5, before and after, with every run solved both times:

| Suite | Cost before → after    | Cache writes before → after | Cache reads           | Output tokens   | Tool calls |
| ----- | ---------------------- | --------------------------- | --------------------- | --------------- | ---------- |
| Small | $0.281 → $0.195        | 66,755 → 28,788 (−57%)      | 178,707 → 198,791     | 7,817 → 8,292   | 51 → 61    |
| Large | $1.222 → $0.989        | 235,703 → 166,678 (−29%)    | 1,097,203 → 1,113,565 | 41,320 → 34,951 | 160 → 152  |
| All   | $1.503 → $1.184 (−21%) | 302,458 → 195,466 (−35%)    | +3%                   | −12%            | 211 → 213  |

Every task cost less, from −2% (`export-bug`) to −50% (`cli-fix`); the small tasks gained most because their prompt is mostly the fixed tools and system prompt.

- **Before:** `ee9aa3e`, the commit before #86. **After:** `26cbfe4`, with #86's breakpoint on the system prompt (next to the top-level automatic one), extra tools in a fixed order and the project map, plus the subagent change below.
- **Where it comes from:** cache writes fell by a third while reads stayed level, so the requests that used to write the fixed part again now read it. No run used a subagent, so this is #86's breakpoint and tool order, not the subagent change; that one saves the tools and system prompt write on each `task` or `oracle` run on the chat's model (about 10k tokens per run), which these tasks do not exercise.
- **Noise:** one before and one after run of each configuration, and the model's own choices vary (the small suite made 10 more tool calls after, the large suite 8 fewer). The cache-write drop is far larger than that variation, and consistent across all 12 tasks.
- **The keep-alive** (Settings → Prompt cache, `26cbfe4`) is off by default and is not exercised here: the benchmark has no pauses between turns. Its request shape was checked against the API on Claude Sonnet 5.5 and Claude Opus 5.5 (with compaction and refusal fallback): after one real turn, two keep-alives read the whole cached prefix (8,466 and 8,470 tokens), wrote 4 and 0 tokens and returned no output, and the next real turn read the cache.

### Cache suite results (2026-10-04)

**Question:** what do the subagent change and the keep-alive save, which the 12 tasks above do not exercise?

**Answer:** the keep-alive cut a follow-up after a 6-minute pause from $0.040–0.042 to $0.011–0.012 including the keep-alive itself, and the whole run by about 35%. The subagent change cut a delegated question's cache writes by about a fifth. All runs were solved. Claude Sonnet 5.5, 2 runs each, `PATCH_BENCH_SUITE=cache`, pause 360 s:

| Run                     | Pause                         | Follow-up: cache read / write | Follow-up cost | Run cost     |
| ----------------------- | ----------------------------- | ----------------------------- | -------------- | ------------ |
| Keep-alive off          | nothing sent                  | 0 / 13,457–14,403             | $0.040–0.042   | $0.080–0.082 |
| Keep-alive on (`-warm`) | 1 keep-alive, $0.004 each run | 13,404–13,848 / 29            | $0.007–0.008   | $0.051–0.055 |

- **Keep-alive:** without it, the cache expired during the pause and the follow-up wrote the whole chat again. With it, one keep-alive at about 4 minutes (reading about 13k tokens, writing 583) kept it alive, and the follow-up wrote 29 tokens. On Claude Opus 5.5 and with longer chats the gap grows with the chat's size; the keep-alive costs a cache read, the rewrite a cache write.
- **Subagent:** `subagent-question` on `d5bf942` (before the subagent change) and on `26cbfe4`, same benchmark files:

| Build              | Cache writes   | Cache reads    | Cost           |
| ------------------ | -------------- | -------------- | -------------- |
| Before (`d5bf942`) | 26,665, 19,714 | 36,198, 44,511 | $0.111, $0.094 |
| After (`26cbfe4`)  | 20,965, 14,844 | 51,627, 41,444 | $0.097, $0.079 |

About 23% fewer cache writes and 14% lower cost per delegated question, as the subagent's first request now reads the chat's tools and system prompt. Two runs each and the subagent's own exploration varies, so read this as a direction rather than an exact figure.

### Plan mode as a message note (#44, 2026-10-05)

**Question:** with `propose_plan` always in the tool list and plan mode told by a note on the user message (#44), does the model still propose plans as reliably as when the tool only existed in plan mode?

**Answer:** more reliably, on these tasks. Before, the model never proposed a plan for the two small multi-step tasks; with the note it planned first in 4 of 6 runs. Neither version proposed a plan where it should not (the question, or plan mode off). Requests, time and cost did not change beyond noise. Claude Sonnet 5.5, `PATCH_BENCH_SUITE=plan`, 3 runs per task, Windows 11 with the AppContainer sandbox on both builds:

| Task (plan mode)    | Before (`37f8bb6`): planned first, solved | After (PR #92): planned first, solved | Avg. cost before / after |
| ------------------- | ----------------------------------------- | ------------------------------------- | ------------------------ |
| `add-feature` (on)  | 0/3, 0/3                                  | 1/3, 1/3                              | $0.039 / $0.046          |
| `rename` (on)       | 0/3, 0/3                                  | 3/3, 3/3                              | $0.037 / $0.038          |
| `question` (on)     | none, as wanted; 3/3                      | none, as wanted; 3/3                  | $0.013 / $0.013          |
| `add-feature` (off) | no plan; 3/3                              | no plan; 3/3                          | $0.037 / $0.033          |
| `rename` (off)      | no plan; 3/3                              | no plan; 3/3                          | $0.039 / $0.043          |

- An earlier baseline run without the sandbox helper (commands refused at once) also planned 0 of 6 times, so the baseline result does not depend on how commands behaved.
- "Solved" with plan mode on requires the plan; every run solved the task itself (the hidden tests pass).
- The tasks are small, and the tool description says a one-step change needs no plan, so the model is right to hesitate on `add-feature`. Larger multi-step tasks are not covered. Three runs per task: read the numbers as a direction.
- Runs of 150–200 s on both builds come from the sandbox, not plan mode: inside the Windows AppContainer, `npm test` exited with code 1 and `node --test` timed out in every run that tried them, and the model retried variations ([#101](https://github.com/PierrunoYT/patch/issues/101)).

## Windows sandbox in a large project (#103, 2026-10-07)

**Question:** how much does the Windows AppContainer sandbox add to one command in a project with many files, such as one with a large `node_modules`?

**Answer:** it added about 23 seconds per command at 100,000 files, because each command granted its own AppContainer SID write access through the whole project and revoked it afterwards. Windows rewrites the security descriptor of every file and folder for both changes. Now the project's write grant goes to a capability derived from the project path, propagated once and kept until the project is closed in Patch, and a command adds about 0.07 s.

### How it is measured

`npm run perf` runs `tests/perf/windows_sandbox.perf.ts` on Windows when the helper is built (`npm run build:sandbox`); elsewhere it is skipped.

- A fixture project with `PATCH_PERF_FILES` files (default 100,000) in 1,000 folders under `node_modules`, and an empty `.git`.
- `Write-Output hi` through `ShellRunner`, five times with the sandbox off and five times in Automatic mode, PATH limited to the Windows system folders so no toolchain preparation is timed. Medians are reported.

### Results

Windows 11, the development machine used above, 100,000 files:

| Build                 | Unsandboxed | Sandboxed (median) | Added per command |
| --------------------- | ----------- | ------------------ | ----------------- |
| Before (`3b64815`)    | 186 ms      | 23,409 ms          | 23.2 s            |
| After (project grant) | 180 ms      | 251 ms             | 0.07 s            |

- **The first command in a project pays the grant once:** 12.0 s in the run above. Later commands, and later app sessions until the project is closed in Patch, skip it.
- **Closing or removing the project** revokes the grant, which walks the tree once more, in a background helper process. The window does not wait for it.

### What still scales with the project

- **`.git`:** each command still stops `.git` inheriting the project grant, grants its own SID read access there and undoes both when it ends. That walks the `.git` tree a few times per command. In a packed repository that is a few hundred entries, but many loose objects make it slower. Not measured here: the fixture's `.git` is empty ([#139](https://github.com/PierrunoYT/patch/issues/139)).
- **Files moved in from elsewhere:** a file moved into the project from another folder keeps its old permissions, so it lacks the inherited grant until the project is closed and opened again. Files created or copied in the project inherit it normally ([#140](https://github.com/PierrunoYT/patch/issues/140)).
