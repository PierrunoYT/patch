import { markAnnounced, newAnnouncements } from '@shared/announce';
import {
  commandNotice,
  countDiffLines,
  diffNotice,
  outputNotice,
  planNotice,
  type ApprovalDecision,
  type TranscriptItem,
} from '@shared/chat';
import { h, icon, sym, trustedHtml } from '../dom';
import { formatDuration } from '../format';
import { renderDiff, renderMarkdown } from '../markdown';

export interface TranscriptActions {
  decide(id: string, decision: ApprovalDecision): void;
  openFile(path: string): void;
  // Puts back the file an approved edit changed. The card is the edit's own tool card.
  undoEdit(id: string, path: string | undefined): void;
  theme(): 'dark' | 'light';
}

// Gives `target` the attributes and children of `source`, keeping `target` itself in place. Listeners set by h() are
// on the children, which move along; the item elements themselves have none.
function morph(target: HTMLElement, source: HTMLElement): void {
  for (const { name } of [...target.attributes]) if (!source.hasAttribute(name)) target.removeAttribute(name);
  for (const { name, value } of [...source.attributes])
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  target.replaceChildren(...source.childNodes);
}

// Keyboard focus inside an item that is updated in place. Focusable controls carry `data-focus-key`, so the matching
// control can be focused again after the update; a control that is gone (Undo becomes an "Undone" badge) hands focus
// to whatever took its key, or to the item itself.
function focusKeyWithin(node: HTMLElement): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !node.contains(active)) return null;
  return active.dataset.focusKey ?? '';
}

function restoreFocus(node: HTMLElement, key: string): void {
  const target = key ? node.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null;
  if (target) {
    target.focus({ preventScroll: true });
    return;
  }
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.focus({ preventScroll: true });
}

// Material Symbols names for the tools' cards.
const TOOL_ICONS: Record<string, string> = {
  read_file: 'description',
  list_directory: 'folder_open',
  grep: 'search',
  search_code: 'manage_search',
  edit_file: 'edit_document',
  write_file: 'note_add',
  run_command: 'terminal',
  command_output: 'terminal',
  web_search: 'travel_explore',
  fetch_url: 'public',
  browser: 'web',
  propose_plan: 'checklist',
  task: 'smart_toy',
  finder: 'person_search',
  oracle: 'psychology',
  load_skill: 'school',
  glob: 'find_in_page',
  apply_patch: 'edit_document',
  todo_list: 'checklist',
};

// What a tool row shows after the tool's name: the file, command or other target, and the result in parentheses at
// the end of the summary as a chip ("Read notes.txt (2 lines)" gives "notes.txt" and "2 lines").
export function toolLabel(item: { summary?: string; path?: string; preview?: { title: string; command?: string } }): {
  target: string;
  chip: string | null;
} {
  const text = item.summary ?? item.preview?.title ?? '';
  const match = /\s*\(([^()]+)\)$/.exec(text);
  const chip = match ? match[1]! : null;
  const rest = match ? text.slice(0, match.index) : text;
  const target =
    item.preview?.command ??
    item.path ??
    rest.replace(/^(Edit|Write|Open|Fetch|Read|Listed|Edited|Wrote|Created)\s+/, '');
  return { target, chip };
}

// Lines added and removed, shown next to an edit's title.
function diffStats(diff: string): HTMLElement {
  const { added, removed } = countDiffLines(diff);
  return h(
    'span',
    { class: 'diff-stats', title: `${added} line(s) added, ${removed} removed` },
    h('span', { class: 'diff-added' }, `+${added}`),
    ' ',
    h('span', { class: 'diff-removed' }, `−${removed}`),
  );
}

// Whether the items not yet shown include a message from the user. Events are applied once per frame, so the start of
// the reply can arrive in the same render as the message: the message need not be the last item.
export function sentMessage(items: TranscriptItem[], shown: { has(id: string): boolean }): boolean {
  for (let index = items.length - 1; index >= 0 && !shown.has(items[index]!.id); index--) {
    if (items[index]!.kind === 'user') return true;
  }
  return false;
}

// The transcript's items are grouped in containers of this many, each skipped for layout while off screen
// (`content-visibility: auto`). Following the bottom of a long chat while an answer streams then lays out a few dozen
// containers instead of thousands of items (docs/PERFORMANCE.md).
const CHUNK_SIZE = 50;

// Renders the transcript, re-creating only items whose object changed (the reducer returns new objects only for
// updated items), and keeps the view scrolled to the bottom while the user has not scrolled up.
export class TranscriptView {
  readonly element = h('div', { class: 'transcript' });
  // Screen-reader only. The transcript itself is not a live region: it is re-rendered on every streamed chunk, which
  // a screen reader would read out again and again. This announces finished answers, approvals and failures once.
  readonly announcer = h('div', {
    class: 'visually-hidden',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'false',
  });
  private readonly announced = new Set<string>();
  private primed = false;
  // `item` is null for an item that must be drawn again although it has not changed (see redraw).
  private readonly nodes = new Map<string, { item: TranscriptItem | null; leads: boolean; node: HTMLElement }>();
  // Items are placed in containers of CHUNK_SIZE items each (see CHUNK_SIZE).
  private readonly chunks: HTMLElement[] = [];
  // <details> the user opened, so re-rendering a card does not collapse it.
  private readonly expanded = new Set<string>();

  constructor(private readonly actions: TranscriptActions) {}

  render(items: TranscriptItem[]): void {
    // The scrolling element is the wrapper around the transcript's parent, not the direct parent.
    const container = this.element.closest<HTMLElement>('.chat-scroll-wrap');
    // Always follow when the user just sent a message; otherwise only if already near the bottom.
    const stick =
      !container ||
      sentMessage(items, this.nodes) ||
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;

    const seen = new Set<string>();
    let previous: HTMLElement | null = null;
    // Whether items were added or moved, as opposed to only updated in place (a streamed answer).
    let inserted = false;
    const chunkCount = Math.ceil(items.length / CHUNK_SIZE);
    while (this.chunks.length > chunkCount) this.chunks.pop()!.remove();
    for (const [index, item] of items.entries()) {
      seen.add(item.id);
      const chunk = this.chunk(Math.floor(index / CHUNK_SIZE));
      if (index % CHUNK_SIZE === 0) previous = null;
      let entry = this.nodes.get(item.id);
      // The assistant's avatar is shown once per turn: on the first item after the user's message.
      const leads = item.kind !== 'user' && (index === 0 || items[index - 1]!.kind === 'user');
      if (!entry || entry.item !== item || entry.leads !== leads) {
        const node = this.renderItem(item, leads);
        // Update a changed item in place rather than swapping its element: a new element among the transcript's
        // children makes the browser recheck the styles of the whole (long) list, on every streamed frame.
        if (entry && entry.node.tagName === node.tagName) {
          const focus = focusKeyWithin(entry.node);
          morph(entry.node, node);
          if (focus !== null) restoreFocus(entry.node, focus);
        } else if (entry) entry.node.replaceWith(node);
        entry = { item, leads, node: entry && entry.node.tagName === node.tagName ? entry.node : node };
        this.nodes.set(item.id, entry);
      }
      const expectedNext: ChildNode | null = previous ? previous.nextSibling : chunk.firstChild;
      if (expectedNext !== entry.node) {
        chunk.insertBefore(entry.node, expectedNext);
        inserted = true;
      }
      previous = entry.node;
    }
    for (const [id, entry] of this.nodes) {
      if (!seen.has(id)) {
        entry.node.remove();
        this.nodes.delete(id);
      }
    }

    if (container && stick) {
      container.scrollTop = container.scrollHeight;
      // A chat that was just opened, or a new item at the end: their real heights are only known a frame or more
      // later, so jump again for a few frames.
      if (!this.primed) this.stickFor(container, 10);
      else if (inserted) this.stickFor(container, 2);
    }
    if (container) this.watchContainer(container, stick);

    // The first render after a reset is a chat being opened, not news.
    if (!this.primed) {
      markAnnounced(items, this.announced);
      this.primed = true;
    } else {
      for (const message of newAnnouncements(items, this.announced)) this.announcer.appendChild(h('div', {}, message));
    }
  }

  // Items that were off screen (content-visibility: auto) count at a placeholder height until they have been laid out,
  // so a jump to the bottom lands short: by thousands of pixels when a long chat is opened, or by most of a new
  // approval card. After either, the view jumps to the bottom again for a few frames, unless the user scrolls. Streamed
  // updates insert nothing and pay nothing: every other way tried (following all height changes, a ResizeObserver on
  // the transcript, laying out the newest items with an inline style) made streaming in a 5,000-item chat two to
  // three times slower (docs/PERFORMANCE.md).
  private stickFrame = 0;
  private stuck = false;
  private watchedContainer: HTMLElement | null = null;

  private stickFor(container: HTMLElement, frames: number): void {
    cancelAnimationFrame(this.stickFrame);
    let left = frames;
    const again = () => {
      if (!this.stuck) return;
      container.scrollTop = container.scrollHeight;
      if (--left > 0) this.stickFrame = requestAnimationFrame(again);
    };
    this.stickFrame = requestAnimationFrame(again);
  }

  // Whether the view is at the bottom is known from the user's own scrolling (wheel, touch, keys, the scrollbar); the
  // position alone cannot tell, as the browser also moves it to keep the view steady while items above settle. When
  // the scroll area itself gets smaller (a bar appears above it), a view at the bottom stays there. The scroll area's
  // size does not change while an answer streams, so watching it costs nothing then.
  private watchContainer(container: HTMLElement, stuck: boolean): void {
    // Measured by render() before it changed anything. Reading the position again after the jump to the bottom made
    // the browser lay the page out a second time on every streamed frame.
    this.stuck = stuck;
    if (this.watchedContainer === container) return;
    this.watchedContainer = container;
    const scrolledByUser = () => {
      cancelAnimationFrame(this.stickFrame);
      requestAnimationFrame(
        () => (this.stuck = container.scrollHeight - container.scrollTop - container.clientHeight < 80),
      );
    };
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'])
      container.addEventListener(type, scrolledByUser, { passive: true });
    new ResizeObserver(() => {
      if (this.stuck) container.scrollTop = container.scrollHeight;
    }).observe(container);
  }

  // Draws every item again in place (after a theme change, for the diffs' colors). The elements are kept, so the
  // scroll position and the details the user opened stay as they are.
  redraw(items: TranscriptItem[]): void {
    for (const entry of this.nodes.values()) entry.item = null;
    this.render(items);
  }

  reset(): void {
    this.announced.clear();
    this.primed = false;
    this.announcer.replaceChildren();
    this.nodes.clear();
    this.chunks.length = 0;
    this.expanded.clear();
    this.element.replaceChildren();
  }

  // The container for items [index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), created when first needed.
  private chunk(index: number): HTMLElement {
    while (this.chunks.length <= index) {
      const chunk = h('div', { class: 'transcript-chunk' });
      this.element.appendChild(chunk);
      this.chunks.push(chunk);
    }
    return this.chunks[index]!;
  }

  // Every item is a row: an avatar column, then the content. The user's rows show "U"; the assistant's avatar is shown
  // on the first row of its turn (`leads`) and the other rows keep the column empty, so the turn lines up.
  private renderItem(item: TranscriptItem, leads: boolean): HTMLElement {
    const avatar = leads
      ? h('div', { class: 'avatar avatar-assistant', 'aria-hidden': 'true' }, sym('smart_toy'))
      : h('div', { class: 'avatar-space', 'aria-hidden': 'true' });
    switch (item.kind) {
      case 'user':
        return h(
          'div',
          { class: 'message user', dataset: { id: item.id } },
          h('div', { class: 'avatar avatar-user', 'aria-hidden': 'true' }, 'U'),
          h(
            'div',
            { class: 'message-body' },
            h('div', { class: 'bubble' }, item.text),
            item.imageCount > 0
              ? h('div', { class: 'attachments' }, sym('image'), ` ${item.imageCount} image(s)`)
              : null,
          ),
        );
      case 'assistant':
        return h(
          'div',
          { class: `message assistant${item.streaming ? ' streaming' : ''}`, dataset: { id: item.id } },
          avatar,
          h(
            'div',
            { class: 'message-body' },
            // Rendered only when opened: while an answer streams, the thinking would otherwise be parsed and
            // highlighted again on every frame, although it is usually collapsed.
            item.thinking
              ? this.details(`${item.id}:thinking`, h('span', {}, sym('psychology'), ' Thinking'), () => [
                  trustedHtml('div', 'markdown thinking', renderMarkdown(item.thinking)),
                ])
              : null,
            item.text ? trustedHtml('div', 'markdown', renderMarkdown(item.text, !item.streaming)) : null,
            item.streaming && !item.text ? h('div', { class: 'typing' }, h('span'), h('span'), h('span')) : null,
          ),
        );
      case 'tool':
        return this.renderTool(item, avatar);
      case 'error':
        return h(
          'div',
          { class: 'message error', dataset: { id: item.id } },
          avatar,
          h('div', { class: 'message-body alert alert-danger' }, sym('error'), ' ', item.text),
        );
      case 'notice':
        return h(
          'div',
          { class: 'message notice', dataset: { id: item.id } },
          avatar,
          h('div', { class: 'message-body' }, sym('info'), ' ', item.text),
        );
    }
  }

  private renderTool(item: Extract<TranscriptItem, { kind: 'tool' }>, avatar: HTMLElement): HTMLElement {
    // The full summary ("Read notes.txt (2 lines)") names the card for screen readers and its Undo button; on screen
    // the row shows the tool name, its target and the result in a chip, as in a code editor's log.
    const title = item.summary ?? item.preview?.title ?? item.name.replace(/_/g, ' ');
    const { target, chip } = toolLabel(item);
    const awaiting = item.status === 'awaiting-approval';
    const status: Record<typeof item.status, HTMLElement> = {
      'awaiting-approval': h(
        'span',
        { class: item.preview?.command ? 'status-chip' : 'status-pill' },
        item.preview?.command ? 'Awaiting approval' : 'Pending Approval',
      ),
      running: h('span', {
        class: 'spinner-border spinner-border-sm tool-spinner',
        role: 'img',
        'aria-label': 'Running',
      }),
      done: h('span', { class: 'tool-status' }, sym('check', 'ok'), h('span', { class: 'visually-hidden' }, 'Done')),
      error: h(
        'span',
        { class: 'tool-status' },
        sym('error', 'failed'),
        h('span', { class: 'visually-hidden' }, 'Failed'),
      ),
      declined: h('span', { class: 'status-chip' }, 'Declined'),
    };

    const header = h(
      'div',
      { class: 'tool-header' },
      awaiting ? sym(TOOL_ICONS[item.name] ?? 'build', 'tool-icon') : sym('expand_more', 'tool-chevron'),
      h(
        'span',
        { class: 'tool-title', title },
        h('span', { class: 'tool-name' }, item.name),
        target ? h('span', { class: 'tool-target' }, target) : null,
        h('span', { class: 'visually-hidden' }, ` ${title}`),
      ),
      // Not for a diff shown only in part, whose counts would be too low.
      item.preview?.diff && !item.preview.diffOmittedLines ? diffStats(item.preview.diff) : null,
      h(
        'span',
        { class: 'tool-meta' },
        chip && !awaiting ? h('span', { class: 'tool-chip' }, chip) : null,
        item.path && !awaiting
          ? h(
              'button',
              {
                class: 'tool-action',
                title: 'Open in editor',
                dataset: { focusKey: 'open' },
                onclick: (event: Event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  this.actions.openFile(item.path!);
                },
              },
              sym('open_in_new'),
            )
          : null,
        item.undo === 'available'
          ? h(
              'button',
              {
                class: 'tool-action undo-button',
                title: 'Put the file back the way it was before this edit',
                'aria-label': `Undo ${title}`,
                dataset: { focusKey: 'undo' },
                onclick: (event: Event) => {
                  // The button sits in the card's summary; do not also open or close the card.
                  event.preventDefault();
                  event.stopPropagation();
                  this.actions.undoEdit(item.id, item.path);
                },
              },
              sym('undo'),
              h('span', {}, 'Undo'),
            )
          : item.undo === 'undone'
            ? // Takes the Undo button's focus key, so a keyboard user who pressed Undo lands on the result.
              h('span', { class: 'tool-chip', tabindex: -1, dataset: { focusKey: 'undo' } }, 'Undone')
            : null,
        item.durationMs !== undefined && !awaiting
          ? h('span', { class: 'tool-duration', title: 'How long the tool ran' }, formatDuration(item.durationMs))
          : null,
        status[item.status],
      ),
    );

    const preview = () => this.renderPreview(item);
    const output = () =>
      item.output
        ? h(
            'div',
            {},
            item.outputOmittedChars
              ? h('div', { class: 'tool-truncated' }, icon('scissors'), ` ${outputNotice(item.outputOmittedChars)}`)
              : null,
            h('pre', { class: 'tool-output' }, item.output),
          )
        : null;

    if (awaiting) {
      const command = Boolean(item.preview?.command);
      const feedback = h('input', {
        type: 'text',
        class: 'approval-note',
        placeholder: command ? 'Optional: tell the assistant what to do instead…' : 'Add revision feedback or note...',
        'aria-label': 'Optional feedback if you decline',
      }) as HTMLInputElement;
      const decide = (approved: boolean) =>
        this.actions.decide(item.id, { approved, feedback: approved ? undefined : feedback.value });
      feedback.addEventListener('keydown', (event) => {
        // Enter with a note declines with it, the way the note is meant to be used.
        if (event.key === 'Enter' && feedback.value.trim()) decide(false);
      });
      const decline = h(
        'button',
        { class: 'btn btn-outline-secondary btn-sm', onclick: () => decide(false) },
        command ? 'Skip' : 'Decline',
      );
      const approve = h(
        'button',
        { class: 'btn btn-primary btn-sm', onclick: () => decide(true) },
        sym(command ? 'play_arrow' : 'done'),
        h('span', {}, command ? 'Approve & Run' : 'Approve'),
      );
      // A command card keeps its buttons in the header and the command below it; other cards end in a footer bar.
      const box = command
        ? h(
            'div',
            { class: 'tool-box command-box' },
            h(
              'div',
              { class: 'tool-header' },
              ...header.childNodes,
              h('span', { class: 'tool-buttons' }, decline, approve),
            ),
            preview(),
            feedback,
          )
        : h(
            'div',
            { class: 'tool-box' },
            header,
            preview(),
            h('div', { class: 'approval' }, feedback, h('span', { class: 'tool-buttons' }, decline, approve)),
          );
      return h(
        'div',
        {
          class: 'tool-card awaiting',
          role: 'group',
          'aria-label': `Approval needed: ${title}`,
          dataset: { id: item.id },
        },
        avatar,
        box,
      );
    }

    if (item.status === 'running') {
      return h(
        'div',
        { class: 'tool-card running', dataset: { id: item.id } },
        avatar,
        h('div', { class: 'tool-box' }, header, output()),
      );
    }

    const hasBody = Boolean(item.preview?.diff || item.preview?.command || item.preview?.text || item.output);
    return h(
      'div',
      { class: `tool-card ${item.status}`, dataset: { id: item.id } },
      avatar,
      h(
        'div',
        { class: `tool-box${hasBody ? '' : ' no-body'}` },
        // Built when the card is first opened: a long chat has many finished cards, most of them never opened, and
        // their diffs are by far the largest part of the page.
        hasBody ? this.details(item.id, header, () => [preview(), output()].filter(Boolean) as HTMLElement[]) : header,
      ),
    );
  }

  private renderPreview(item: Extract<TranscriptItem, { kind: 'tool' }>): HTMLElement | null {
    const preview = item.preview;
    // Approving a change that is only partly shown needs a clear warning; afterwards a plain note is enough.
    const notice = (text: string) =>
      item.status === 'awaiting-approval'
        ? h(
            'div',
            { class: 'alert alert-warning py-1 px-2 mb-1 small', role: 'note' },
            icon('exclamation-triangle'),
            ` ${text}`,
          )
        : h('div', { class: 'tool-truncated' }, icon('scissors'), ` ${text}`);
    if (preview?.diff) {
      return h(
        'div',
        {},
        trustedHtml('div', 'tool-diff', renderDiff(preview.diff, this.actions.theme())),
        preview.diffOmittedLines
          ? notice(diffNotice(preview.diffOmittedLines, item.status === 'awaiting-approval'))
          : null,
      );
    }
    if (preview?.command) {
      return h(
        'div',
        {},
        h('pre', { class: 'tool-command' }, `$ ${preview.command}${preview.commandOmittedChars ? ' …' : ''}`),
        preview.commandOmittedChars ? notice(commandNotice(preview.commandOmittedChars)) : null,
        preview.note ? h('div', { class: 'tool-truncated' }, icon('shield'), ` ${preview.note}`) : null,
      );
    }
    // Free-form preview text (the plan in plan mode), rendered as sanitized markdown.
    if (preview?.text) {
      return h(
        'div',
        {},
        trustedHtml('div', 'markdown tool-plan', renderMarkdown(preview.text)),
        preview.textOmittedChars ? notice(planNotice(preview.textOmittedChars)) : null,
      );
    }
    return null;
  }

  // `content` may be a function, which is then called only when the details are first opened.
  private details(id: string, summary: HTMLElement, content: HTMLElement | (() => HTMLElement[])): HTMLElement {
    const open = this.expanded.has(id);
    const build = typeof content === 'function' ? content : () => [content];
    // The expanded state is noted when the summary is clicked, not only in the later `toggle` event: a streamed frame
    // re-rendering this item in between would otherwise build it with the old state and undo the click.
    const summaryElement = h(
      'summary',
      {
        dataset: { focusKey: 'summary' },
        onclick: () => (details.open ? this.expanded.delete(id) : this.expanded.add(id)),
      },
      summary,
    );
    const details = h('details', { open }, summaryElement, ...(open ? build() : []));
    let built = open;
    details.addEventListener('toggle', () => {
      if (details.open && !built) {
        built = true;
        details.append(...build());
      }
      if (details.open) this.expanded.add(id);
      else this.expanded.delete(id);
    });
    return details;
  }
}
