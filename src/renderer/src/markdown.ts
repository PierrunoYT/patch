import DOMPurify from 'dompurify';
import { html as diffToHtml } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

const markedOptions = { gfm: true, breaks: false };

// Without highlighting: used while an answer streams (see renderMarkdown).
const plainMarked = new Marked(markedOptions);

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
  markedOptions,
);

// Sanitized HTML for trustedHtml(). The app page enforces Trusted Types and its CSP allows only DOMPurify's own policy,
// so this is a TrustedHTML that only DOMPurify can create, and nothing else can write HTML into the page (#65).
// Where Trusted Types are not available DOMPurify returns a plain string.
export type SanitizedHtml = ReturnType<typeof sanitize>;

function sanitize(html: string, config: Parameters<typeof DOMPurify.sanitize>[1] = {}) {
  return DOMPurify.sanitize(html, { ...config, RETURN_TRUSTED_TYPE: true });
}

// Model output is untrusted: rendered markdown is always sanitized before it reaches the DOM. Images and embeds are
// removed too, because an image URL written by a prompt-injected model is a way to leak data.
//
// `highlight: false` skips syntax highlighting. A streaming answer is parsed again from its start on every frame, and
// highlighting its code blocks every time made that cost grow with the answer's length (#200); the finished message is
// rendered with highlighting.
export function renderMarkdown(text: string, highlight = true): SanitizedHtml {
  // Model text must not borrow the app's own classes or ids to draw something that looks like Patch (a fake Approve
  // button, an overlay, hidden text) (#254). Only the code highlighting classes stay. The hook is added for this call
  // only: diffs rely on their own classes.
  DOMPurify.addHook('uponSanitizeAttribute', keepHighlightClasses);
  try {
    return sanitize((highlight ? marked : plainMarked).parse(text, { async: false }) as string, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target'],
      FORBID_TAGS: [
        'img',
        'picture',
        'video',
        'audio',
        'source',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'style',
      ],
      FORBID_ATTR: ['style', 'id', 'hidden'],
    });
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute', keepHighlightClasses);
  }
}

const HIGHLIGHT_CLASS = /^(hljs(-[\w-]+)?|language-[\w+#.-]+)$/;

function keepHighlightClasses(_node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }): void {
  if (data.attrName !== 'class') return;
  const kept = data.attrValue.split(/\s+/).filter((name) => HIGHLIGHT_CLASS.test(name));
  if (kept.length === 0) data.keepAttr = false;
  else data.attrValue = kept.join(' ');
}

export function renderDiff(diff: string, theme: 'dark' | 'light'): SanitizedHtml {
  const html = diffToHtml(diff, {
    drawFileList: false,
    matching: 'lines',
    outputFormat: 'line-by-line',
    colorScheme: theme === 'dark' ? ColorSchemeType.DARK : ColorSchemeType.LIGHT,
  });
  return sanitize(html);
}
