# Optional voice input

The CLI voice UX is **deferred**, not scheduled or implemented. The
[P2 scope decision](../PORTING_PLAN.md#ancillary-feature-dispositions--p2-item-7)
retains this library helper without treating it as executable voice parity.
Any future UX must explicitly disclose microphone capture and transcription
provider use, support cancellation, and allow transcript review before submission.

Voice support is isolated behind the `@pierrunoyt/patch/voice` package subpath. The default CLI and main library entry point do not import it, and Patch adds no native audio, Playwright, or bundled ffmpeg dependency.

`VoiceInput` composes a `VoiceRecorder` and `VoiceTranscriber`, limits recording duration (five minutes), audio size (25 MiB), and transcript size, forwards cancellation to both operations, and always removes its private temporary directory. `FfmpegVoiceRecorder` is an optional subprocess adapter: callers provide explicit, platform-appropriate input arguments and may select the ffmpeg executable. It uses argv without a shell and caps captured diagnostics. `OpenAiVoiceTranscriber` uses the existing OpenAI SDK and supports a selected transcription model and language.

`VoiceInput.captureAndSubmit(session, options)` passes the bounded transcript to
an explicit `ApplicationSession` using the same abort signal and event callback
as text submissions. This API is available only from the `voice` subpath; Patch
does not auto-start recording or import audio code from its CLI or root export.

Consumers that need microphone capture must install ffmpeg themselves or provide another recorder implementation. Merely installing or running Patch does not probe audio devices, download binaries, or add native build requirements. This is the npm equivalent of pinned aider's optional voice extra, rather than importing `sounddevice`, `soundfile`, `pydub`, and ffmpeg requirements into the default installation.
