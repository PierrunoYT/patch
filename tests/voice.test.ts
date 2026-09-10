import { access, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  VoiceInput,
  VoiceInputError,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "../src/interfaces/voice.js";
import type { ApplicationSession } from "../src/core/application-service.js";

describe("optional voice input", () => {
  it("records, bounds, transcribes, and removes temporary audio", async () => {
    let recordedPath = "";
    let transcribedPath = "";
    const recorder: VoiceRecorder = {
      record: async (path) => {
        recordedPath = path;
        await writeFile(path, "audio");
      },
    };
    const transcriber: VoiceTranscriber = {
      transcribe: async (path, { language }) => {
        transcribedPath = path;
        expect(language).toBe("de");
        return "  grüezi  ";
      },
    };
    const voice = new VoiceInput({ recorder, transcriber });
    await expect(
      voice.capture({ durationMs: 100, language: "de" }),
    ).resolves.toBe("grüezi");
    expect(transcribedPath).toBe(recordedPath);
    await expect(access(recordedPath)).rejects.toThrow();
  });

  it("rejects oversized audio before transcription and still cleans it up", async () => {
    let path = "";
    let transcribed = false;
    const voice = new VoiceInput({
      maxAudioBytes: 3,
      recorder: {
        record: async (destination) => {
          path = destination;
          await writeFile(destination, "large");
        },
      },
      transcriber: {
        transcribe: async () => {
          transcribed = true;
          return "wrong";
        },
      },
    });
    await expect(voice.capture({ durationMs: 100 })).rejects.toThrow(
      /size limit/,
    );
    expect(transcribed).toBe(false);
    await expect(access(path)).rejects.toThrow();
  });

  it("propagates cancellation to recording and removes partial files", async () => {
    const controller = new AbortController();
    let path = "";
    const voice = new VoiceInput({
      recorder: {
        record: async (destination, { signal }) => {
          path = destination;
          await writeFile(destination, "partial");
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
      transcriber: { transcribe: async () => "wrong" },
    });
    const capturing = voice.capture({
      durationMs: 100,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("stop"));
    await expect(capturing).rejects.toBeInstanceOf(VoiceInputError);
    await expect(access(path)).rejects.toThrow();
  });

  it("submits the bounded transcript through an application session", async () => {
    const submitted: string[] = [];
    const events: string[] = [];
    const session: ApplicationSession = {
      snapshot: () => ({}),
      submit: async (message, { signal, emit }) => {
        expect(signal.aborted).toBe(false);
        submitted.push(message);
        emit({ type: "accepted", data: message.length });
        return { response: "done" };
      },
    };
    const voice = new VoiceInput({
      recorder: {
        record: async (path) => writeFile(path, "audio"),
      },
      transcriber: {
        transcribe: async () => "  submit this transcript  ",
      },
    });

    await expect(
      voice.captureAndSubmit(session, {
        durationMs: 100,
        emit: (event) => events.push(event.type),
      }),
    ).resolves.toEqual({ response: "done" });
    expect(submitted).toEqual(["submit this transcript"]);
    expect(events).toEqual(["accepted"]);
  });
});
