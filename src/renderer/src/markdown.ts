import DOMPurify from 'dompurify';
import { html as diffToHtml } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
  { gfm: true, breaks: false },
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
export function renderMarkdown(text: string): SanitizedHtml {
  return sanitize(marked.parse(text, { async: false }) as string, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['img', 'picture', 'video', 'audio', 'source', 'iframe', 'object', 'embed', 'form', 'input', 'style'],
    FORBID_ATTR: ['style'],
  });
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
