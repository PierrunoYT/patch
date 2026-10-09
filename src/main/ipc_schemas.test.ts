import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS } from '@shared/ipc';
import { IPC_ARGS, parseIpcArgs } from './ipc_schemas';

describe('IPC argument schemas (#32)', () => {
  it('has a schema for every invoke channel and none for a channel that does not exist', () => {
    expect(Object.keys(IPC_ARGS).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('accepts the calls the renderer makes', () => {
    expect(parseIpcArgs('settings:get', [])).toEqual([]);
    expect(parseIpcArgs('chat:send', [{ text: 'hi' }])).toEqual([{ text: 'hi' }]);
    expect(
      parseIpcArgs('chat:send', [
        { text: 'look', images: [{ mediaType: 'image/png', base64: 'AAAA', name: 'a.png' }] },
      ]),
    ).toHaveLength(1);
    expect(parseIpcArgs('chat:decide', ['id-1', { approved: false, feedback: 'not that file' }])).toHaveLength(2);
    expect(parseIpcArgs('git:diff', [null])).toEqual([null]);
    expect(parseIpcArgs('git:diff', ['src/a.ts'])).toEqual(['src/a.ts']);
    expect(parseIpcArgs('terminal:resize', [80, 24])).toEqual([80, 24]);
    expect(parseIpcArgs('settings:set-secret', ['anthropicApiKey', ''])).toEqual(['anthropicApiKey', '']);
    expect(
      parseIpcArgs('project:update-settings', [
        '/p',
        { instructions: '', allowedCommands: '', allowedNetworkHosts: '' },
      ]),
    ).toHaveLength(2);
  });

  it('refuses an approval that is only truthy, and a decision without a boolean', () => {
    expect(() => parseIpcArgs('chat:decide', ['id', { approved: 'no' }])).toThrow(/chat:decide/);
    expect(() => parseIpcArgs('chat:decide', ['id', { approved: 1 }])).toThrow(/chat:decide/);
    expect(() => parseIpcArgs('chat:decide', ['id', { approved: true, feedback: 5 }])).toThrow(/chat:decide/);
    expect(() => parseIpcArgs('chat:decide', ['id'])).toThrow(/chat:decide/);
  });

  it('refuses images the model could not read or that are far too large', () => {
    const send = (images: unknown) => parseIpcArgs('chat:send', [{ text: 'x', images }]);
    expect(() => send([{ mediaType: 'image/bmp', base64: 'AAAA' }])).toThrow(/chat:send/);
    expect(() => send([{ mediaType: 'image/png', base64: 5 }])).toThrow(/chat:send/);
    expect(() => send([{ mediaType: 'image/png', base64: 'A'.repeat(7_200_001) }])).toThrow(/chat:send/);
    expect(() => send(Array.from({ length: 21 }, () => ({ mediaType: 'image/png', base64: 'AAAA' })))).toThrow(
      /chat:send/,
    );
  });

  it('refuses terminal arguments that are not sane numbers or text', () => {
    expect(() => parseIpcArgs('terminal:start', ['80', 24])).toThrow(/terminal:start/);
    expect(() => parseIpcArgs('terminal:start', [Number.NaN, 24])).toThrow(/terminal:start/);
    expect(() => parseIpcArgs('terminal:resize', [80, 1_000_000])).toThrow(/terminal:resize/);
    expect(() => parseIpcArgs('terminal:resize', [1.5, 24])).toThrow(/terminal:resize/);
    expect(() => parseIpcArgs('terminal:write', [{ toString: () => 'x' }])).toThrow(/terminal:write/);
  });

  it('refuses a secret with an unknown name or a value that is not text', () => {
    expect(() => parseIpcArgs('settings:set-secret', ['githubToken', 'x'])).toThrow(/settings:set-secret/);
    expect(() => parseIpcArgs('settings:set-secret', ['openaiApiKey', 42])).toThrow(/settings:set-secret/);
    expect(() => parseIpcArgs('settings:set-secret', ['openaiApiKey', 'x'.repeat(50_001)])).toThrow(
      /settings:set-secret/,
    );
  });

  it('refuses extra, missing and wrongly typed arguments, and names the channel but not the value', () => {
    expect(() => parseIpcArgs('settings:get', ['extra'])).toThrow(/settings:get/);
    expect(() => parseIpcArgs('project:open', [])).toThrow(/project:open/);
    expect(() => parseIpcArgs('project:open', [{}])).toThrow(/project:open/);
    expect(() => parseIpcArgs('settings:update', ['not an object'])).toThrow(/settings:update/);
    try {
      parseIpcArgs('git:commit', ['x'.repeat(2_000_001)]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('git:commit');
      expect((error as Error).message).not.toContain('xxxxxxxxxx');
    }
  });

  it('removed the unused project:set-instructions channel', () => {
    expect(INVOKE_CHANNELS).not.toContain('project:set-instructions');
  });
});
