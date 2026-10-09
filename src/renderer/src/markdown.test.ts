import { parseHTML } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';

// DOMPurify needs a window when it is first imported, so the module is loaded after one is installed.
let renderMarkdown: typeof import('./markdown').renderMarkdown;

beforeAll(async () => {
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window, document: window.document });
  ({ renderMarkdown } = await import('./markdown'));
});

const html = (value: unknown) => String(value);
const answer = 'Here:\n\n```ts\nconst a: number = 1;\n```\n';

describe('renderMarkdown', () => {
  it('highlights code blocks of a finished message', () => {
    expect(html(renderMarkdown(answer))).toContain('hljs-keyword');
  });

  it('skips highlighting for a streaming one, keeping the same structure (#200)', () => {
    const streaming = html(renderMarkdown(answer, false));
    expect(streaming).not.toContain('hljs-keyword');
    expect(streaming).toContain('<pre><code');
    expect(streaming).toContain('const a: number = 1;');
  });
});
