import type { TranscriptItem } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { sentMessage } from './transcript';

describe('following a sent message', () => {
  const user = (id: string): TranscriptItem => ({ kind: 'user', id, text: id, imageCount: 0 });
  const answer = (id: string): TranscriptItem => ({ kind: 'assistant', id, text: id, thinking: '', streaming: true });

  it('sees a new message even when the reply arrived in the same render', () => {
    const items = [user('u1'), answer('a1'), user('u2'), answer('a2')];
    expect(sentMessage(items, new Set(['u1', 'a1']))).toBe(true);
    expect(sentMessage(items, new Set(['u1', 'a1', 'u2']))).toBe(false);
  });

  it('ignores streamed updates and messages already shown', () => {
    const items = [user('u1'), answer('a1')];
    expect(sentMessage(items, new Set(['u1', 'a1']))).toBe(false);
    expect(sentMessage(items, new Set(['u1']))).toBe(false);
  });
});
