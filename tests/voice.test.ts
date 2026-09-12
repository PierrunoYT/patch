import { access, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

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
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let path = "";
    const voice = new VoiceInput({
      recorder: {
        record: async (destination, { signal }) => {
          path = destination;
          await writeFile(destination, "partial");
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            ready();
          });
        },
      },
      transcriber: { transcribe: async () => "wrong" },
    });
    const capturing = voice.capture({
      durationMs: 100,
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("stop"));
    await expect(capturing).rejects.toBeInstanceOf(VoiceInputError);
    await expect(access(path)).rejects.toThrow();
  });

  it("does not start recording or submit when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const record = vi.fn(async () => undefined);
    const transcribe = vi.fn(async () => "wrong");
    const submit = vi.fn(async () => "wrong");
    const voice = new VoiceInput({
      recorder: { record },
      transcriber: { transcribe },
    });
    await expect(
      voice.captureAndSubmit(
        { snapshot: () => ({}), submit },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/);
    expect(record).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(["recording", "transcription", "submission"])(
    "forwards cancellation during %s and removes abort listeners and audio",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error(`cancel ${stage}`);
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let activeSignal!: AbortSignal;
      const wait = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          activeSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          ready();
        });
      let path = "";
      const transcribe = vi.fn<VoiceTranscriber["transcribe"]>(
        async (_path, { signal }) => {
          if (stage === "transcription") await wait(signal);
          return "transcript";
        },
      );
      const submit = vi.fn<ApplicationSession["submit"]>(
        async (_message, { signal }) => {
          if (stage === "submission") await wait(signal);
          return "done";
        },
      );
      const voice = new VoiceInput({
        recorder: {
          record: async (destination, { signal }) => {
            path = destination;
            await writeFile(path, "audio");
            if (stage === "recording") await wait(signal);
          },
        },
        transcriber: { transcribe },
      });
      const capturing = voice.captureAndSubmit(
        { snapshot: () => ({}), submit },
        { signal: controller.signal },
      );
      const rejected = expect(capturing).rejects.toThrow(
        stage === "submission" ? reason : /cancelled/,
      );
      await started;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort(reason);
      await rejected;
      expect(activeSignal.aborted).toBe(true);
      expect(activeSignal.reason).toBe(reason);
      expect(submit).toHaveBeenCalledTimes(stage === "submission" ? 1 : 0);
      expect(transcribe).toHaveBeenCalledTimes(stage === "recording" ? 0 : 1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await expect(access(path)).rejects.toThrow();
    },
  );

  it("does not submit a late transcript from a transcriber that ignores cancellation", async () => {
    const controller = new AbortController();
    let path = "";
    const submit = vi.fn(async () => "wrong");
    const voice = new VoiceInput({
      recorder: {
        record: async (destination) => {
          path = destination;
          await writeFile(path, "audio");
        },
      },
      transcriber: {
        transcribe: async () => {
          controller.abort(new Error("stop"));
          return "late transcript";
        },
      },
    });
    await expect(
      voice.captureAndSubmit(
        { snapshot: () => ({}), submit },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/);
    expect(submit).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect(access(path)).rejects.toThrow();
  });

  it("checks cancellation again between capture cleanup and submission", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled after capture");
    let path = "";
    const submit = vi.fn(async () => "wrong");
    const voice = new VoiceInput({
      recorder: {
        record: async (destination) => {
          path = destination;
          await writeFile(path, "audio");
        },
      },
      transcriber: { transcribe: async () => "transcript" },
    });
    const capture = voice.capture.bind(voice);
    vi.spyOn(voice, "capture").mockImplementation(async (options) => {
      const text = await capture(options);
      controller.abort(reason);
      return text;
    });
    await expect(
      voice.captureAndSubmit(
        { snapshot: () => ({}), submit },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(submit).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect(access(path)).rejects.toThrow();
  });

  it.each(["recording", "transcription", "submission"])(
    "removes the caller's abort listener after %s failure",
    async (stage) => {
      const controller = new AbortController();
      const error = new Error(`failed ${stage}`);
      let path = "";
      const voice = new VoiceInput({
        recorder: {
          record: async (destination) => {
            path = destination;
            await writeFile(path, "audio");
            if (stage === "recording") throw error;
          },
        },
        transcriber: {
          transcribe: async () => {
            if (stage === "transcription") throw error;
            return "transcript";
          },
        },
      });
      const submit = vi.fn(async () => {
        throw error;
      });
      await expect(
        voice.captureAndSubmit(
          { snapshot: () => ({}), submit },
          { signal: controller.signal },
        ),
      ).rejects.toBe(error);
      expect(submit).toHaveBeenCalledTimes(stage === "submission" ? 1 : 0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await expect(access(path)).rejects.toThrow();
    },
  );

  it("submits the bounded transcript through an application session", async () => {
    const controller = new AbortController();
    let submissionSignal!: AbortSignal;
    const submitted: string[] = [];
    const events: string[] = [];
    const session: ApplicationSession = {
      snapshot: () => ({}),
      submit: async (message, { signal, emit }) => {
        expect(signal.aborted).toBe(false);
        submissionSignal = signal;
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
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
        signal: controller.signal,
        emit: (event) => events.push(event.type),
      }),
    ).resolves.toEqual({ response: "done" });
    expect(submitted).toEqual(["submit this transcript"]);
    expect(events).toEqual(["accepted"]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort(new Error("after completion"));
    expect(submissionSignal.aborted).toBe(false);
  });
});
