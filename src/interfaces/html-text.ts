/**
 * HTML-to-readable-text conversion adapted from aider/scrape.py `html_to_markdown`
 * and `slimdown_html` at revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch into a dependency-free linear converter: upstream reaches for
 * BeautifulSoup and pandoc, neither of which a Node install should require, and
 * upstream keeps raw tags when pandoc is missing where Patch always returns text.
 * Licensed under the Apache License, Version 2.0.
 */

/** Elements whose content is markup, styling, or media rather than reading text. */
const DISCARDED = new Set([
  "script",
  "style",
  "svg",
  "canvas",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "head",
  "form",
]);

/** Elements that end the current line. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

/** Elements that start a blank line before their content. */
const SPACED = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["hellip", "…"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["rsquo", "’"],
  ["lsquo", "‘"],
  ["ldquo", "“"],
  ["rdquo", "”"],
]);

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/giu, (match, body) => {
    const reference = String(body);
    if (reference.startsWith("#")) {
      const hexadecimal = /^#x/iu.test(reference);
      const code = Number.parseInt(
        hexadecimal ? reference.slice(2) : reference.slice(1),
        hexadecimal ? 16 : 10,
      );
      // Surrogates and out-of-range values have no character to become.
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES.get(reference.toLowerCase()) ?? match;
  });
}

/** A link target worth keeping: absolute, and not a script or inline payload. */
function readableHref(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const href = decodeHtmlEntities(value).trim();
  return /^https?:\/\/[^\s<>"]+$/iu.test(href) ? href : undefined;
}

function attributeOf(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    "iu",
  ).exec(tag);
  if (match === null) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

/**
 * Converts an HTML document to the text a reader would see.
 *
 * The converter is linear rather than a parser: it scans for tags, keeps the
 * text between them, and turns structure into blank lines, list markers, and
 * heading prefixes. Scripts, styles, media, and every attribute except a link's
 * `href` are dropped, as upstream's `slimdown_html` drops them, so no attribute
 * value, inline data URI, or event handler reaches the model. Malformed markup
 * degrades to its text rather than failing: an unterminated tag ends the
 * document.
 */
export function htmlToReadableText(html: string): string {
  // Separating whitespace is held as counters and emitted before the next piece
  // of real content, so no step inspects the text produced so far. Scanning the
  // accumulated output on every block tag made the conversion quadratic: a
  // 1.4 MB page — well inside the fetcher's 2 MB cap — took over two minutes.
  const chunks: string[] = [];
  let content = false;
  let pendingNewlines = 0;
  let pendingSpace = false;
  let index = 0;
  let discarding: string | undefined;
  let listDepth = 0;
  const pendingHrefs: Array<string | undefined> = [];

  /** Appends literal text, holding back whatever whitespace trails it. */
  const push = (text: string) => {
    let end = text.length;
    let newlines = 0;
    while (end > 0) {
      const character = text[end - 1] ?? "";
      if (!/\s/u.test(character)) break;
      if (character === "\n") newlines += 1;
      end -= 1;
    }
    const body = text.slice(0, end);
    if (body !== "") {
      if (content) {
        if (pendingNewlines > 0) chunks.push("\n".repeat(pendingNewlines));
        else if (pendingSpace) chunks.push(" ");
      }
      pendingNewlines = 0;
      pendingSpace = false;
      chunks.push(body);
      content = true;
    }
    if (end === text.length || !content) return;
    // Three or more blank lines collapse to two in the final pass, so holding
    // more than two here would change nothing.
    if (newlines > 0) {
      pendingNewlines = Math.max(pendingNewlines, Math.min(newlines, 2));
      pendingSpace = false;
    } else if (pendingNewlines === 0) {
      pendingSpace = true;
    }
  };

  const appendText = (text: string) => {
    if (discarding !== undefined) return;
    const decoded = decodeHtmlEntities(text).replace(/[ \t\r\f\v]+/gu, " ");
    if (decoded.trim() === "") {
      if (decoded !== "" && content && pendingNewlines === 0)
        pendingSpace = true;
      return;
    }
    push(
      pendingSpace || pendingNewlines > 0 || !content
        ? decoded.replace(/^\s+/u, "")
        : decoded,
    );
  };
  const newline = (blank: boolean) => {
    if (discarding !== undefined) return;
    if (!content) return;
    pendingNewlines = Math.max(pendingNewlines, blank ? 2 : 1);
    pendingSpace = false;
  };

  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      appendText(html.slice(index));
      break;
    }
    appendText(html.slice(index, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }
    const close = html.indexOf(">", open);
    // An unterminated tag is markup, not text: nothing after it can be trusted
    // to be content, so the document ends here.
    if (close === -1) break;
    const tag = html.slice(open, close + 1);
    index = close + 1;
    const named = /^<\/?\s*([a-z][a-z0-9-]*)/iu.exec(tag);
    if (named === null) continue;
    const name = (named[1] ?? "").toLowerCase();
    const closing = tag.startsWith("</");

    if (discarding !== undefined) {
      if (closing && name === discarding) discarding = undefined;
      continue;
    }
    if (DISCARDED.has(name)) {
      if (!closing && !tag.endsWith("/>")) discarding = name;
      continue;
    }
    if (name === "ul" || name === "ol") {
      listDepth = closing ? Math.max(0, listDepth - 1) : listDepth + 1;
      newline(true);
      continue;
    }
    if (name === "li" && !closing) {
      newline(false);
      push(`${"  ".repeat(Math.max(0, listDepth - 1))}- `);
      continue;
    }
    if (/^h[1-6]$/u.test(name) && !closing) {
      newline(true);
      push(`${"#".repeat(Number(name.slice(1)))} `);
      continue;
    }
    if (name === "a" && !closing) {
      const href = readableHref(attributeOf(tag, "href"));
      if (href !== undefined) push("[");
      pendingHrefs.push(href);
      continue;
    }
    if (name === "a" && closing) {
      const href = pendingHrefs.pop();
      if (href !== undefined) push(`](${href})`);
      continue;
    }
    if (BLOCK.has(name)) newline(SPACED.has(name));
  }

  return chunks
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
