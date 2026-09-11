/**
 * Reasoning-tag handling ported from aider/reasoning_tags.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch: the tagged span is split out of the stream as it arrives so
 * display, history, and edit parsing all see the same normalized text, instead of
 * being stripped only after the response is complete.
 * Licensed under the Apache License, Version 2.0.
 */

/** The reasoning and answer text a chunk contributed, either possibly empty. */
export interface ReasoningSplit {
  readonly reasoning: string;
  readonly content: string;
}

function escapeForPattern(tag: string): string {
  return tag.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/**
 * Removes a complete `<tag>…</tag>` span from finished text.
 *
 * A closing tag with no opening tag means the model began reasoning before the
 * first delta, so everything up to it is reasoning. Streaming cannot detect that
 * case in time to keep it off the screen, which is why the whole response is
 * checked again once it is complete.
 */
export function removeReasoningContent(text: string, tag: string): string {
  if (tag === "") return text;
  const name = escapeForPattern(tag);
  const withoutSpans = text
    .replaceAll(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "gu"), "")
    .trim();
  const closing = `</${tag}>`;
  const index = withoutSpans.indexOf(closing);
  return index === -1
    ? withoutSpans
    : withoutSpans.slice(index + closing.length).trim();
}

/**
 * Splits streamed text into reasoning and answer as it arrives.
 *
 * Text is held back only while it could still turn out to be the start of a tag,
 * so a tag broken across provider deltas is still recognized and never reaches
 * the terminal.
 */
export class ReasoningTagSplitter {
  readonly #open: string;
  readonly #close: string;
  #buffer = "";
  #inside = false;

  constructor(tag: string) {
    this.#open = `<${tag}>`;
    this.#close = `</${tag}>`;
  }

  get inside(): boolean {
    return this.#inside;
  }

  write(chunk: string): ReasoningSplit {
    this.#buffer += chunk;
    let reasoning = "";
    let content = "";
    for (;;) {
      const marker = this.#inside ? this.#close : this.#open;
      const index = this.#buffer.indexOf(marker);
      if (index !== -1) {
        const before = this.#buffer.slice(0, index);
        if (this.#inside) reasoning += before;
        else content += before;
        this.#buffer = this.#buffer.slice(index + marker.length);
        this.#inside = !this.#inside;
        continue;
      }
      // Keep back only what could still complete the marker.
      const held = partialSuffix(this.#buffer, marker);
      const settled = this.#buffer.slice(0, this.#buffer.length - held);
      if (this.#inside) reasoning += settled;
      else content += settled;
      this.#buffer = this.#buffer.slice(this.#buffer.length - held);
      return { reasoning, content };
    }
  }

  /** Releases held-back text once the stream ends. */
  flush(): ReasoningSplit {
    const rest = this.#buffer;
    this.#buffer = "";
    return this.#inside
      ? { reasoning: rest, content: "" }
      : { reasoning: "", content: rest };
  }
}

function partialSuffix(text: string, marker: string): number {
  const longest = Math.min(text.length, marker.length - 1);
  for (let length = longest; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}
