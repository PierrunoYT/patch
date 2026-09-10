/**
 * Voice behavior adapted from aider/voice.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch as an optional, dependency-injected adapter with bounded temporary
 * audio and abortable subprocess/provider operations.
 * Licensed under the Apache License, Version 2.0.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OpenAI from "openai";

import type {
  ApplicationEvent,
  ApplicationSession,
} from "../core/application-service.js";

export interface VoiceRecordOptions {
  readonly durationMs: number;
  readonly signal: AbortSignal;
}

export interface VoiceRecorder {
  record(destination: string, options: VoiceRecordOptions): Promise<void>;
}

export interface VoiceTranscriber {
  transcribe(
    path: string,
    options: { readonly language?: string; readonly signal: AbortSignal },
  ): Promise<string>;
}

export interface VoiceInputOptions {
  readonly recorder: VoiceRecorder;
  readonly transcriber: VoiceTranscriber;
  readonly maxAudioBytes?: number;
  readonly maxTranscriptCharacters?: number;
}

export class VoiceInputError extends Error {
  override readonly name = "VoiceInputError";
}

export class VoiceInput {
  readonly #options: VoiceInputOptions;

  constructor(options: VoiceInputOptions) {
    this.#options = options;
  }

  async capture(
    options: {
      readonly durationMs?: number;
      readonly language?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    const durationMs = options.durationMs ?? 30_000;
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs < 100 ||
      durationMs > 5 * 60_000
    ) {
      throw new VoiceInputError(
        "Recording duration must be between 100 ms and 5 minutes",
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const directory = await mkdtemp(join(tmpdir(), "patch-voice-"));
    const path = join(directory, "recording.wav");
    try {
      await this.#options.recorder.record(path, {
        durationMs,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      const size = (await stat(path)).size;
      if (size < 1)
        throw new VoiceInputError("Voice recorder produced no audio");
      if (size > (this.#options.maxAudioBytes ?? 25 * 1024 * 1024)) {
        throw new VoiceInputError(
          "Voice recording exceeds the configured size limit",
        );
      }
      const transcript = (
        await this.#options.transcriber.transcribe(path, {
          ...(options.language === undefined
            ? {}
            : { language: options.language }),
          signal: controller.signal,
        })
      ).trim();
      if (transcript === "")
        throw new VoiceInputError("Transcription produced no text");
      if (
        transcript.length > (this.#options.maxTranscriptCharacters ?? 100_000)
      ) {
        throw new VoiceInputError(
          "Transcript exceeds the configured character limit",
        );
      }
      return transcript;
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof VoiceInputError)) {
        throw new VoiceInputError("Voice input was cancelled", {
          cause: error,
        });
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async captureAndSubmit(
    session: ApplicationSession,
    options: {
      readonly durationMs?: number;
      readonly language?: string;
      readonly signal?: AbortSignal;
      readonly emit?: (event: ApplicationEvent) => void;
    } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const transcript = await this.capture({
        ...(options.durationMs === undefined
          ? {}
          : { durationMs: options.durationMs }),
        ...(options.language === undefined
          ? {}
          : { language: options.language }),
        signal: controller.signal,
      });
      return await session.submit(transcript, {
        signal: controller.signal,
        emit: options.emit ?? (() => undefined),
      });
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

export class FfmpegVoiceRecorder implements VoiceRecorder {
  readonly #executable: string;
  readonly #inputArguments: readonly string[];

  constructor(options: {
    readonly executable?: string;
    readonly inputArguments: readonly string[];
  }) {
    if (options.inputArguments.length === 0)
      throw new VoiceInputError("ffmpeg input arguments are required");
    this.#executable = options.executable ?? "ffmpeg";
    this.#inputArguments = [...options.inputArguments];
  }

  async record(
    destination: string,
    options: VoiceRecordOptions,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.#executable,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          ...this.#inputArguments,
          "-t",
          String(options.durationMs / 1000),
          "-y",
          "-f",
          "wav",
          destination,
        ],
        { shell: false, stdio: ["ignore", "ignore", "pipe"] },
      );
      const diagnostics: Buffer[] = [];
      let diagnosticBytes = 0;
      child.stderr.on("data", (chunk: Buffer) => {
        if (diagnosticBytes >= 16 * 1024) return;
        diagnostics.push(chunk.subarray(0, 16 * 1024 - diagnosticBytes));
        diagnosticBytes += chunk.length;
      });
      const cancel = () => child.kill("SIGTERM");
      options.signal.addEventListener("abort", cancel, { once: true });
      child.once("error", (error) => {
        options.signal.removeEventListener("abort", cancel);
        reject(
          new VoiceInputError(`Unable to start ffmpeg: ${error.message}`, {
            cause: error,
          }),
        );
      });
      child.once("close", (code, signal) => {
        options.signal.removeEventListener("abort", cancel);
        if (options.signal.aborted) return reject(options.signal.reason);
        if (code === 0) return resolve();
        const detail = Buffer.concat(diagnostics).toString("utf8").trim();
        reject(
          new VoiceInputError(
            `ffmpeg recording failed (${signal ?? code ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`,
          ),
        );
      });
    });
  }
}

export class OpenAiVoiceTranscriber implements VoiceTranscriber {
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(client: OpenAI, model = "whisper-1") {
    this.#client = client;
    this.#model = model;
  }

  async transcribe(
    path: string,
    options: { readonly language?: string; readonly signal: AbortSignal },
  ): Promise<string> {
    const result = await this.#client.audio.transcriptions.create(
      {
        file: createReadStream(path),
        model: this.#model,
        ...(options.language === undefined
          ? {}
          : { language: options.language }),
      },
      { signal: options.signal },
    );
    return result.text;
  }
}
