import type { SanitizedHtml } from './markdown';

type Child = Node | string | number | null | undefined | false;

type Props = {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
};

// Properties and attributes that parse HTML or load content, which h() never sets from props (compared lower-case).
// Use trustedHtml for sanitized HTML. This keeps a future h(tag, { [name]: value }) with a model- or file-derived key
// from bypassing that rule.
const BLOCKED_PROPS = new Set(['innerhtml', 'outerhtml', 'srcdoc', 'src', 'formaction', 'action', 'data']);

function isBlockedProp(key: string, value: unknown): boolean {
  const lower = key.toLowerCase();
  // A link may only point at an https URL (javascript:, data: and relative URLs are refused).
  if (lower === 'href') return !/^https:\/\//i.test(String(value));
  // on<Event> with a non-function value would otherwise become an inline handler property or attribute.
  return BLOCKED_PROPS.has(lower) || lower.startsWith('on');
}

// Creates an element. Text children are inserted as text, never parsed as HTML, so this is safe for model output.
// Props named on<Event> with a function value become event listeners; other props are set as properties when the
// element has them, otherwise as attributes. HTML sinks, URL-loading props and inline handlers (see BLOCKED_PROPS)
// are ignored; href is only accepted for https URLs.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'style') element.setAttribute('style', String(value));
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (isBlockedProp(key, value)) {
      continue;
    } else if (key in element && !key.includes('-')) {
      (element as unknown as Record<string, unknown>)[key] = value;
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(element, children);
  // A button with only an icon takes its accessible name from the tooltip.
  if (tag === 'button' && props.title && !element.hasAttribute('aria-label') && !element.textContent?.trim()) {
    element.setAttribute('aria-label', String(props.title));
  }
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function icon(name: string, extraClass = ''): HTMLElement {
  return h('i', { class: `bi bi-${name} ${extraClass}`.trim(), 'aria-hidden': 'true' });
}

// A Material Symbols icon (bundled font; the name is a ligature such as "terminal" or "fork_right"). Hidden from
// assistive technology, so it never becomes part of a control's accessible name.
export function sym(name: string, extraClass = ''): HTMLElement {
  return h('span', { class: `sym ${extraClass}`.trim(), 'aria-hidden': 'true', translate: 'no' }, name);
}

// For HTML that has already been sanitized: only renderMarkdown and renderDiff produce a SanitizedHtml. Under the page's
// Trusted Types policy a plain string here would throw instead of being parsed.
export function trustedHtml(tag: keyof HTMLElementTagNameMap, className: string, html: SanitizedHtml): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.innerHTML = html as unknown as string;
  return element;
}

export function clear(element: Element): void {
  element.replaceChildren();
}

// replaceChildren that skips null/false children, for conditional content.
export function setChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}
