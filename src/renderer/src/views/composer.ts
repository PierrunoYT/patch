import type { ImageAttachment } from '@shared/ipc';
import { h, sym } from '../dom';
import { estimateTokens, formatTokens } from '../format';

export interface ComposerActions {
  send(text: string, images: ImageAttachment[]): Promise<boolean>;
  stop(): void;
  resume(): void;
  pickImages(): Promise<ImageAttachment[]>;
  // Project-relative paths offered when the user types @.
  listFiles(): Promise<string[]>;
  // Shown when an image is pasted for a model that does not accept images.
  notice(message: string): void;
}

export interface Draft {
  text: string;
  images: ImageAttachment[];
  // Files mentioned with @, sent as "@path" at the start of the message.
  mentions: string[];
}

const PASTE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// The API limit for one image, as for attached files (src/main/files.ts).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Suggestions shown at once while typing an @-mention.
const MAX_SUGGESTIONS = 8;

// The message as sent: mentioned files first, so the assistant knows which files the request is about.
export function messageWithMentions(text: string, mentions: string[]): string {
  if (mentions.length === 0) return text;
  const line = mentions.map((path) => `@${path}`).join(' ');
  return text ? `${line}\n\n${text}` : line;
}

// The @-mention being typed just before the caret, if any: "@src/sig" gives its query and where it starts.
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { query: match[2]!, start: caret - match[2]!.length - 1 } : null;
}

// Files matching a mention query: names starting with it first, then paths containing it, shorter paths first.
export function matchFiles(files: string[], query: string, limit = MAX_SUGGESTIONS): string[] {
  const needle = query.toLowerCase();
  const scored: Array<[number, string]> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    const score = name.startsWith(needle) ? 0 : lower.includes(needle) ? 1 : -1;
    if (score >= 0) scored.push([score, file]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, file]) => file);
}

export class Composer {
  readonly element: HTMLElement;
  readonly controls = h('div', { class: 'composer-controls' });
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly attachmentList: HTMLElement;
  private readonly attachButton: HTMLButtonElement;
  private readonly tokenCount = h('span', { class: 'composer-tokens', title: 'Rough size of this message' });
  private readonly suggestions = h('div', { class: 'mention-list', role: 'listbox', hidden: true });
  // Why images cannot be attached for the chat's model, or null when they can.
  private imagesBlocked: string | null = null;
  private images: ImageAttachment[] = [];
  private mentions: string[] = [];
  private busy = false;
  private draftVersion = 0;
  private files: Promise<string[]> | null = null;
  private suggestionItems: string[] = [];
  private selectedSuggestion = 0;

  constructor(private readonly actions: ComposerActions) {
    this.input = h('textarea', {
      class: 'composer-input',
      rows: 2,
      placeholder: 'Ask anything, or describe what you want to build…',
      'aria-label': 'Message',
      'aria-autocomplete': 'list',
      oninput: () => {
        this.autosize();
        this.updateTokens();
        void this.updateSuggestions();
      },
      onkeydown: (event: KeyboardEvent) => this.keydown(event),
      onblur: () => setTimeout(() => this.closeSuggestions(), 150),
      onpaste: (event: ClipboardEvent) => this.paste(event),
    });
    this.sendButton = h(
      'button',
      { class: 'composer-send', title: 'Send (Enter)', onclick: () => void this.submit() },
      h('span', {}, 'Send'),
      sym('arrow_upward'),
    );
    this.stopButton = h(
      'button',
      { class: 'composer-stop', title: 'Stop (Ctrl+.)', disabled: true, onclick: () => this.actions.stop() },
      'Stop',
    );
    this.resumeButton = h(
      'button',
      {
        class: 'composer-resume',
        title: 'Resume stopped task',
        hidden: true,
        onclick: () => this.actions.resume(),
      },
      sym('play_arrow'),
      h('span', {}, 'Resume'),
    );
    this.attachmentList = h('div', { class: 'composer-attachments' });
    this.attachButton = h(
      'button',
      {
        class: 'icon-button composer-attach',
        title: 'Attach images',
        'aria-label': 'Attach images',
        onclick: () => void this.attach(),
      },
      sym('attach_file'),
    );

    this.element = h(
      'div',
      { class: 'composer' },
      h(
        'div',
        { class: 'composer-box' },
        this.suggestions,
        this.input,
        this.attachmentList,
        h(
          'div',
          { class: 'composer-row' },
          h('div', { class: 'composer-left' }, this.attachButton, this.controls),
          h('div', { class: 'composer-right' }, this.tokenCount, this.resumeButton, this.stopButton, this.sendButton),
        ),
      ),
      h(
        'div',
        { class: 'composer-hint' },
        'Enter to send',
        h('span', { 'aria-hidden': 'true' }, '·'),
        'Shift+Enter for a new line',
        h('span', { 'aria-hidden': 'true' }, '·'),
        '@ to mention a file',
      ),
    );
    this.updateTokens();
  }

  setState(busy: boolean, resumable: boolean): void {
    this.busy = busy;
    this.sendButton.disabled = busy;
    this.stopButton.disabled = !busy;
    this.resumeButton.hidden = busy || !resumable;
  }

  focus(): void {
    this.input.focus();
  }

  // `reason` is why the chat's model cannot take images, or null when it can. Images already in the draft stay, marked,
  // so nothing the user attached disappears; sending them is refused with the same reason.
  setImagesBlocked(reason: string | null): void {
    if (reason === this.imagesBlocked) return;
    this.imagesBlocked = reason;
    this.attachButton.disabled = reason !== null;
    this.attachButton.title = reason ?? 'Attach images';
    this.renderAttachments();
  }

  getDraft(): Draft {
    return { text: this.input.value, images: [...this.images], mentions: [...this.mentions] };
  }

  // Also called when the project changes, so the file list for mentions is read again.
  setDraft(draft: Draft): void {
    this.draftVersion++;
    this.files = null;
    this.input.value = draft.text;
    this.images = [...draft.images];
    this.mentions = [...draft.mentions];
    this.closeSuggestions();
    this.renderAttachments();
    this.autosize();
    this.updateTokens();
  }

  private keydown(event: KeyboardEvent): void {
    if (!this.suggestions.hidden && this.suggestionItems.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.selectedSuggestion =
          (this.selectedSuggestion + step + this.suggestionItems.length) % this.suggestionItems.length;
        this.renderSuggestions();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.chooseSuggestion(this.suggestionItems[this.selectedSuggestion]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeSuggestions();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.submit();
    }
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (this.busy || (!text && this.images.length === 0 && this.mentions.length === 0)) return;
    const version = this.draftVersion;
    const sent = await this.actions.send(messageWithMentions(text, this.mentions), this.images);
    if (sent && version === this.draftVersion) {
      this.input.value = '';
      this.images = [];
      this.mentions = [];
      this.renderAttachments();
      this.autosize();
      this.updateTokens();
    }
  }

  private async updateSuggestions(): Promise<void> {
    const mention = mentionAt(this.input.value, this.input.selectionStart ?? this.input.value.length);
    if (!mention) {
      this.closeSuggestions();
      return;
    }
    const version = this.draftVersion;
    this.files ??= this.actions.listFiles();
    const files = await this.files;
    // The text may have changed while the list was read.
    const current = mentionAt(this.input.value, this.input.selectionStart ?? this.input.value.length);
    if (version !== this.draftVersion || current?.query !== mention.query) return;
    this.suggestionItems = matchFiles(files, mention.query).filter((file) => !this.mentions.includes(file));
    this.selectedSuggestion = 0;
    this.renderSuggestions();
  }

  private renderSuggestions(): void {
    this.suggestions.hidden = this.suggestionItems.length === 0;
    this.suggestions.replaceChildren(
      ...this.suggestionItems.map((file, index) =>
        h(
          'div',
          {
            class: `mention-option${index === this.selectedSuggestion ? ' selected' : ''}`,
            role: 'option',
            'aria-selected': String(index === this.selectedSuggestion),
            // mousedown, so the textarea does not lose focus (and close the list) first.
            onmousedown: (event: Event) => {
              event.preventDefault();
              this.chooseSuggestion(file);
            },
          },
          sym('description'),
          h('span', {}, file),
        ),
      ),
    );
  }

  private chooseSuggestion(file: string): void {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const mention = mentionAt(this.input.value, caret);
    if (mention) {
      const value = this.input.value;
      this.input.value = value.slice(0, mention.start) + value.slice(caret).replace(/^ /, '');
      this.input.setSelectionRange(mention.start, mention.start);
    }
    if (!this.mentions.includes(file)) this.mentions.push(file);
    this.closeSuggestions();
    this.renderAttachments();
    this.updateTokens();
    this.input.focus();
  }

  private closeSuggestions(): void {
    this.suggestionItems = [];
    this.suggestions.hidden = true;
    this.suggestions.replaceChildren();
  }

  private async attach(): Promise<void> {
    const version = this.draftVersion;
    const images = await this.actions.pickImages();
    if (version !== this.draftVersion) return;
    this.images.push(...images);
    this.renderAttachments();
  }

  private paste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => PASTE_TYPES.has(file.type));
    if (files.length === 0) return;
    // Text copied with a preview image (for example table cells) keeps the browser's normal paste behavior.
    if (event.clipboardData?.types.includes('text/plain')) return;
    if (this.imagesBlocked) {
      // Copying from Word, Excel or a browser often puts text and an image on the clipboard together: let the text
      // paste as usual, and only say why the image was left out when there is nothing else.
      event.preventDefault();
      this.actions.notice(this.imagesBlocked);
      return;
    }
    event.preventDefault();
    const tooLarge = files.filter((file) => file.size > MAX_IMAGE_BYTES);
    if (tooLarge.length > 0)
      this.actions.notice(`${tooLarge.map((file) => file.name || 'The pasted image').join(', ')} is larger than 5 MB.`);
    const version = this.draftVersion;
    for (const file of files.filter((candidate) => candidate.size <= MAX_IMAGE_BYTES)) {
      const reader = new FileReader();
      reader.onload = () => {
        if (version !== this.draftVersion) return;
        const base64 = String(reader.result).split(',')[1] ?? '';
        this.images.push({
          name: file.name || 'pasted image',
          mediaType: file.type as ImageAttachment['mediaType'],
          base64,
        });
        this.renderAttachments();
      };
      reader.readAsDataURL(file);
    }
  }

  private renderAttachments(): void {
    this.attachmentList.replaceChildren(
      ...this.mentions.map((path, index) =>
        h(
          'span',
          { class: 'composer-chip', title: path },
          sym('description'),
          h('span', {}, `@${path}`),
          h(
            'button',
            {
              'aria-label': `Remove @${path}`,
              onclick: () => {
                this.mentions.splice(index, 1);
                this.renderAttachments();
                this.updateTokens();
              },
            },
            sym('close'),
          ),
        ),
      ),
      ...this.images.map((image, index) =>
        h(
          'span',
          {
            class: `composer-chip badge${this.imagesBlocked ? ' blocked' : ''}`,
            title: this.imagesBlocked ?? image.name,
          },
          sym('image'),
          h('span', {}, image.name),
          h(
            'button',
            {
              'aria-label': `Remove ${image.name}`,
              onclick: () => {
                this.images.splice(index, 1);
                this.renderAttachments();
              },
            },
            sym('close'),
          ),
        ),
      ),
    );
  }

  private updateTokens(): void {
    const text = messageWithMentions(this.input.value.trim(), this.mentions);
    this.tokenCount.textContent = `${formatTokens(estimateTokens(text))} tokens`;
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }
}
