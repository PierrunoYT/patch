# Optional voice input

CLI microphone/device UX is a current-release non-goal. Voice remains an
optional embedding subpath for hosts that explicitly own recorder, transcriber,
device, disclosure, and transcript-review UX. A built-in flow would require
cross-platform device selection, optional ffmpeg packaging, transcription
network disclosure, review before submission, and real-device evidence. The
library helper's deterministic tests are not that evidence.

Voice support is isolated behind the `@pierrunoyt/patch/voice` package subpath. The default CLI and main library entry point do not import it, and Patch adds no native audio, Playwright, or bundled ffmpeg dependency.

`VoiceInput` composes a `VoiceRecorder` and `VoiceTranscriber`, limits recording duration (five minutes), audio size (25 MiB), and transcript size, forwards cancellation to both operations, and always removes its private temporary directory. `FfmpegVoiceRecorder` is an optional subprocess adapter: callers provide explicit, platform-appropriate input arguments and may select the ffmpeg executable. It checks pre-aborted signals before process creation, uses argv without a shell, and caps captured diagnostics. `OpenAiVoiceTranscriber` uses the existing OpenAI SDK and supports a selected transcription model and language.

`VoiceInput.captureAndSubmit(session, options)` passes the bounded transcript to
an explicit `ApplicationSession` using the same abort signal and event callback
as text submissions. This API is available only from the `voice` subpath; Patch
does not auto-start recording or import audio code from its CLI or root export.

Cancellation is checked before temporary-directory creation and recording,
before transcription, after the transcriber resolves, and again before session
submission. An already-aborted call never invokes the recorder, and late text
from a transcriber that ignores its signal is not submitted. Capture cancellation
is reported as `VoiceInputError`; cancellation after capture or during submission
uses the session/caller's abort reason. The caller's abort listener is detached
on success, failure, or cancellation, including capture setup failures.
Recorder/transcriber implementations must still honor their signal to interrupt
work already in progress; Patch cannot force a non-cooperative promise to settle.

`tests/voice.test.ts` uses fake recorders/transcribers/sessions and deterministic
handoff gates to cover each active stage, late transcription, the
capture/submission boundary, failure cleanup, and successful listener removal.
It also invokes the exported recorder with the Node executable as a deterministic
ffmpeg stand-in and proves a pre-aborted call creates no child side effect or
listener. Temporary audio removal is checked; no microphone, actual ffmpeg, SDK
network call, or CLI voice path is exercised. Compared again with pinned
`aider/voice.py:106–180`, this is Patch's async cancellation/cleanup policy, not
parity with upstream's interactive recording and synchronous transcription flow.

Consumers that need microphone capture must install ffmpeg themselves or provide another recorder implementation. Merely installing or running Patch does not probe audio devices, download binaries, or add native build requirements. This is the npm equivalent of pinned aider's optional voice extra, rather than importing `sounddevice`, `soundfile`, `pydub`, and ffmpeg requirements into the default installation.
