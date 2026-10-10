import { describe, expect, it } from 'vitest';
import { MAX_MEMORY_NOTE_CHARS, MAX_MEMORY_NOTES, memoryNotes, mergeAllowLists, projectMemory } from './project';

describe('project memory helpers', () => {
  it('cleans notes: one per line, collapsed, deduplicated, capped', () => {
    expect(memoryNotes('  Use   pnpm \n\nUse pnpm\r\nNo changelog')).toEqual(['Use pnpm', 'No changelog']);
    expect(memoryNotes('x'.repeat(500))[0]).toHaveLength(MAX_MEMORY_NOTE_CHARS);
    expect(memoryNotes(Array.from({ length: 80 }, (_, i) => `n${i}`).join('\n'))).toHaveLength(MAX_MEMORY_NOTES);
    expect(memoryNotes(undefined)).toEqual([]);
  });

  it('gives no notes when memory is off, and an empty list when it is on without notes', () => {
    expect(projectMemory({ memory: 'a', memoryEnabled: false })).toBeNull();
    expect(projectMemory({})).toEqual([]);
    expect(projectMemory({ memory: 'a\nb' })).toEqual(['a', 'b']);
    expect(projectMemory(null)).toEqual([]);
  });
});

describe('mergeAllowLists', () => {
  it('adds the project list to the global one', () => {
    expect(mergeAllowLists('npm test', 'cargo check')).toBe('npm test\ncargo check');
    expect(mergeAllowLists('', 'cargo check')).toBe('\ncargo check');
  });

  it('keeps the global list when the project has none', () => {
    expect(mergeAllowLists('npm test', undefined)).toBe('npm test');
    expect(mergeAllowLists('npm test', '  \n ')).toBe('npm test');
  });
});
