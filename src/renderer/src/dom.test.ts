import { parseHTML } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import { h } from './dom';

beforeAll(() => {
  const { document, Node } = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { document, Node });
});

describe('h', () => {
  it('sets ordinary props, attributes and listeners', () => {
    let clicked = 0;
    const input = h('input', { class: 'a b', type: 'text', value: 'x', disabled: true, 'aria-label': 'Name' });
    expect(input.className).toBe('a b');
    expect(input.value).toBe('x');
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('aria-label')).toBe('Name');
    const button = h('button', { onclick: () => clicked++ }, 'go');
    button.click();
    expect(clicked).toBe(1);
    expect(button.textContent).toBe('go');
  });

  it('does not set HTML from innerHTML, outerHTML or srcdoc props', () => {
    const div = h('div', { innerHTML: '<b>x</b>', outerHTML: '<i>y</i>' });
    expect(div.querySelector('b')).toBeNull();
    expect(div.innerHTML).toBe('');
    const frame = h('iframe', { srcdoc: '<script>1</script>', srcDoc: '<p>' });
    expect(frame.hasAttribute('srcdoc')).toBe(false);
  });

  it('ignores src, formAction and non-function on* props', () => {
    const img = h('img', { src: 'https://example.com/a.png' });
    expect(img.hasAttribute('src')).toBe(false);
    const button = h('button', { formAction: 'https://example.com', formaction: 'https://example.com' });
    expect(button.hasAttribute('formaction')).toBe(false);
    const div = h('div', { onclick: 'alert(1)', onerror: 'alert(1)' });
    expect(div.hasAttribute('onclick')).toBe(false);
    expect(div.hasAttribute('onerror')).toBe(false);
  });

  it('accepts only https hrefs', () => {
    expect(h('a', { href: 'https://github.com/x/y' }).getAttribute('href')).toBe('https://github.com/x/y');
    expect(h('a', { href: 'javascript:alert(1)' }).hasAttribute('href')).toBe(false);
    expect(h('a', { href: 'data:text/html,<b>x</b>' }).hasAttribute('href')).toBe(false);
    expect(h('a', { href: '/relative' }).hasAttribute('href')).toBe(false);
  });
});
