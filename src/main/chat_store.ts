import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { searchSnippet, transcriptSearchText, type ChatSummary } from '@shared/chat';
import { estimateCost } from '@shared/models';
import type { SavedChat } from './agent/session';
import { appLog } from './app_log';
import { cancelJsonWrite, readJson, writeJson, writeJsonLater } from './storage/json_file';

const ID_PATTERN = /^[0-9a-f-]{36}$/;

// Saved chats, one JSON file each in userData/chats, plus an index for fast listing.
export class ChatStore {
  private index: ChatSummary[];
  private readonly textCache = new Map<string, { updatedAt: string; text: string }>();
  // Checkpoints still being written, by chat id.
  private readonly checkpoints = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.index = readJson<ChatSummary[]>(this.indexFile, []);
    // Indexes written before costs were listed have no `cost`; rebuilding once from the chat files adds it.
    if (this.index.length === 0 || this.index.some((item) => !('cost' in item))) this.rebuildIndex();
  }

  list(): ChatSummary[] {
    return [...this.index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // A `checkpoint` save is a crash-resume checkpoint: it writes only the chat file, which is all a resume needs, and
  // leaves the index to the next full save. The chat is serialized before this returns and its file is written in the
  // background, so a tool batch in a long chat does not hold up the main process for the write. A chat missing from
  // the index is saved and indexed at once, so it is never orphaned. Any other save is complete when this returns
  // and replaces a checkpoint that is still being written.
  // Returns whether the index was written, i.e. whether the chat list changed.
  save(chat: SavedChat, checkpoint = false): boolean {
    // The cached search text is keyed to the index timestamp, which a checkpoint leaves unchanged.
    this.textCache.delete(chat.id);
    if (checkpoint && this.has(chat.id)) {
      this.writeLater(chat);
      return false;
    }
    writeJson(this.chatFile(chat.id), chat);
    const summary = summarize(chat);
    this.index = [summary, ...this.index.filter((item) => item.id !== chat.id)];
    writeJson(this.indexFile, this.index);
    return true;
  }

  private writeLater(chat: SavedChat): void {
    const id = chat.id;
    const done = writeJsonLater(this.chatFile(id), chat);
    // Checkpoints that join a write already running share its promise.
    if (this.checkpoints.get(id) === done) return;
    this.checkpoints.set(id, done);
    void done
      // The next save writes the chat again. The log gets the error only, never the chat.
      .catch((error: unknown) => appLog.warn('chats', error, { operation: 'checkpoint' }))
      .finally(() => {
        if (this.checkpoints.get(id) === done) this.checkpoints.delete(id);
        // A search may have read the file before the checkpoint replaced it.
        this.textCache.delete(id);
      });
  }

  // Settles when the checkpoints still being written are on disk.
  async flush(): Promise<void> {
    while (this.checkpoints.size > 0) await Promise.allSettled([...this.checkpoints.values()]);
  }

  // Chats whose title, project or messages contain every word of the query, newest first. Message text is read from
  // the chat files the first time it is needed and kept in memory until the chat changes. The search gives the event
  // loop a turn after each file it reads, so the first search over a long history does not freeze the window. Each
  // file is read in one synchronous step: a file held open across turns would make a save of that chat fail on
  // Windows, where an open file cannot be renamed over.
  async search(query: string): Promise<ChatSummary[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.list();
    const results: ChatSummary[] = [];
    let waited = false;
    for (const summary of this.list()) {
      const head = `${summary.title} ${summary.projectPath ?? ''}`.toLowerCase();
      if (words.every((word) => head.includes(word))) {
        results.push(summary);
        continue;
      }
      const cached = this.textCache.get(summary.id);
      let text: string;
      if (cached?.updatedAt === summary.updatedAt) {
        text = cached.text;
      } else {
        text = this.readMessageText(summary);
        await nextTurn();
        waited = true;
      }
      const all = `${head}\n${text.toLowerCase()}`;
      if (words.every((word) => all.includes(word))) results.push({ ...summary, snippet: searchSnippet(text, words) });
    }
    // Chats deleted while the search was waiting are not results.
    return waited ? results.filter((result) => this.has(result.id)) : results;
  }

  private readMessageText(summary: ChatSummary): string {
    const text = transcriptSearchText(this.load(summary.id)?.transcript ?? []);
    if (this.has(summary.id)) this.textCache.set(summary.id, { updatedAt: summary.updatedAt, text });
    return text;
  }

  private has(id: string): boolean {
    return this.index.some((item) => item.id === id);
  }

  load(id: string): SavedChat | null {
    if (!ID_PATTERN.test(id)) return null;
    const chat = readJson<SavedChat | null>(this.chatFile(id), null);
    return chat?.version === 1 ? chat : null;
  }

  delete(id: string): void {
    if (!ID_PATTERN.test(id)) return;
    // A checkpoint still being written would put the file back.
    cancelJsonWrite(this.chatFile(id));
    rmSync(this.chatFile(id), { force: true });
    this.textCache.delete(id);
    this.index = this.index.filter((item) => item.id !== id);
    writeJson(this.indexFile, this.index);
  }

  deleteAll(): void {
    for (const item of this.index) {
      cancelJsonWrite(this.chatFile(item.id));
      rmSync(this.chatFile(item.id), { force: true });
    }
    this.textCache.clear();
    this.index = [];
    writeJson(this.indexFile, this.index);
  }

  private get indexFile(): string {
    return join(this.dir, 'index.json');
  }

  private chatFile(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  // Recovers the index if it was lost or corrupted.
  private rebuildIndex(): void {
    if (!existsSync(this.dir)) return;
    this.index = readdirSync(this.dir)
      .filter((name) => ID_PATTERN.test(name.replace(/\.json$/, '')))
      .map((name) => readJson<SavedChat | null>(join(this.dir, name), null))
      .filter((chat): chat is SavedChat => chat?.version === 1)
      .map(summarize);
    if (this.index.length > 0) writeJson(this.indexFile, this.index);
  }
}

// Lets the events that arrived in the meantime (window input, other requests) run before the caller continues.
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// What the chat list shows for a chat, including its estimated cost so far.
export function summarize(chat: SavedChat): ChatSummary {
  // Chats saved before officialPricing was stored: Claude and OpenAI's own API (Responses) have official prices, a
  // custom endpoint (Chat Completions) may not.
  const official =
    chat.officialPricing ?? (chat.conversation.provider === 'anthropic' || chat.conversation.api === 'responses');
  let usage = chat.usage;
  // Older OpenAI totals counted cache reads in the input too, as ChatSession corrects when it loads them.
  if (usage && chat.conversation.provider === 'openai' && usage.cacheWriteTokens === undefined) {
    usage = { ...usage, inputTokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens) };
  }
  return {
    id: chat.id,
    title: chat.title,
    projectPath: chat.projectPath,
    updatedAt: chat.updatedAt,
    cost: usage ? estimateCost(chat.conversation.model, usage, official) : null,
    tokens: usage ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + (usage.cacheWriteTokens ?? 0) : 0,
  };
}
