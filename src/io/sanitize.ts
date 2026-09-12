/**
 * Terminal control-sequence sanitization adapted from aider/run_cmd.py and
 * aider/io.py at revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch into one stateful sanitizer shared by every untrusted
 * terminal output path: PTY children, non-PTY command output, streamed model
 * responses, rendered diffs, and file content shown in previews.
 * Licensed under the Apache License, Version 2.0.
 */

const ESCAPE = "\u001b";
const BELL = "\u0007";

/**
 * Removes every terminal control sequence from text that Patch did not
 * generate. The sanitizer is stateful, so a sequence split across chunks - an
 * escape at the end of one provider delta and its final byte in the next -
 * cannot reach the terminal.
 *
 * Removed families: C0 controls other than tab, newline, and carriage return;
 * 7-bit and 8-bit CSI; OSC, DCS, SOS, PM, and APC strings with either
 * terminator; two-character escapes including single shifts; escapes carrying
 * intermediate bytes, such as charset selection; DEL; and the C1 range.
 */
export class ControlSequenceSanitizer {
  #state:
    | "text"
    | "escape"
    | "escape-intermediate"
    | "csi"
    | "string"
    | "string-escape" = "text";

  write(chunk: string): string {
    let safe = "";
    for (const character of chunk) {
      const code = character.codePointAt(0) ?? 0;
      switch (this.#state) {
        case "text":
          if (character === ESCAPE) this.#state = "escape";
          // 8-bit C1 introducers open the same sequences as their escape forms:
          // DCS, SOS, OSC, PM, APC, matching the "]PX^_" set below. The rest of
          // the range opens nothing — 0x9C is ST, a *terminator*, and 0x99/0x9A
          // introduce no string — so treating them as introducers swallowed
          // everything after a stray byte, and the stream keeps one sanitizer,
          // so a single mojibake character discarded the rest of a response.
          else if (code === 0x9b) this.#state = "csi";
          else if (
            code === 0x90 ||
            code === 0x98 ||
            (code >= 0x9d && code <= 0x9f)
          )
            this.#state = "string";
          else if (
            character === "\n" ||
            character === "\r" ||
            character === "\t"
          )
            safe += character;
          // Drop the remaining C0 controls, DEL, and the rest of the C1 range.
          else if (
            code >= 0x20 &&
            code !== 0x7f &&
            (code < 0x80 || code > 0x9f)
          )
            safe += character;
          break;
        case "escape":
          if (character === "[") this.#state = "csi";
          else if ("]PX^_".includes(character)) this.#state = "string";
          // Intermediate bytes precede the final byte of a short escape.
          else if (code >= 0x20 && code <= 0x2f)
            this.#state = "escape-intermediate";
          else this.#state = "text";
          break;
        case "escape-intermediate":
          if (code < 0x20 || code > 0x2f) this.#state = "text";
          break;
        case "csi":
          // Parameter and intermediate bytes run until a final byte.
          if (code >= 0x40 && code <= 0x7e) this.#state = "text";
          break;
        case "string":
          if (character === BELL || code === 0x9c) this.#state = "text";
          else if (character === ESCAPE) this.#state = "string-escape";
          break;
        case "string-escape":
          this.#state = character === "\\" ? "text" : "string";
          break;
      }
    }
    return safe;
  }
}

/** Sanitize one complete, self-contained piece of untrusted text. */
export function sanitizeTerminalText(text: string): string {
  return new ControlSequenceSanitizer().write(text);
}

/**
 * Wrap a terminal writer so every chunk it receives is sanitized as one
 * continuous untrusted stream.
 */
export function sanitizedWriter(
  write: (text: string) => void,
): (text: string) => void {
  const sanitizer = new ControlSequenceSanitizer();
  return (text) => {
    const safe = sanitizer.write(text);
    if (safe !== "") write(safe);
  };
}
