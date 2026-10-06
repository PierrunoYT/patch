import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppLog, logNativeCrashDumps, redact } from './app_log';

let dir: string;
let file: string;
let log: AppLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-applog-'));
  file = join(dir, 'logs', 'app.log.jsonl');
  log = new AppLog();
  log.setFile(file);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entries = () =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

describe('AppLog', () => {
  it('writes one line per entry with time, level, source and message', () => {
    log.info('app', 'Started.', { version: '1.0.0' });
    log.warn('window', 'The window stopped responding.');
    log.error('ipc', new Error('boom'), { channel: 'chat:send' });

    const [started, warned, failed] = entries();
    expect(started).toEqual({
      time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      level: 'info',
      source: 'app',
      message: 'Started.',
      context: { version: '1.0.0' },
    });
    expect(warned).toMatchObject({ level: 'warn', source: 'window' });
    expect(failed).toMatchObject({
      level: 'error',
      source: 'ipc',
      message: 'Error: boom',
      context: { channel: 'chat:send' },
    });
    expect(failed.stack).toContain('app_log.test.ts');
  });

  it('does not persist chat failure text, stacks or context', () => {
    const error = new Error('Provider echoed private prompt content');
    error.stack = `${error.message}\n    at request`;
    log.error('chat', error, { detail: 'private context' });
    const eventText = 'Provider echoed event string content';
    log.error('chat', eventText);

    const [entry, eventEntry] = entries();
    expect(entry.message).toBe('Chat request failed; see the conversation for details.');
    expect(entry.stack).toBeUndefined();
    expect(entry.context).toBeUndefined();
    expect(eventEntry.message).toBe('Chat request failed; see the conversation for details.');
    expect(readFileSync(file, 'utf8')).not.toContain('private');
    expect(readFileSync(file, 'utf8')).not.toContain(eventText);
  });

  it('accepts problems that are not Error objects', () => {
    log.error('unhandled-rejection', 'plain text');
    log.error('unhandled-rejection', { code: 42 });
    log.error('unhandled-rejection', undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.error('unhandled-rejection', circular);

    expect(entries().map((entry) => entry.message)).toEqual([
      'plain text',
      '{"code":42}',
      'undefined',
      '[object Object]',
    ]);
    expect(entries().every((entry) => entry.stack === undefined)).toBe(true);
  });

  it('keeps API keys and tokens out of messages and stacks', () => {
    const error = new Error('401 for key sk-ant-api03-abcdef123456 with header x-api-key: abcd1234efgh');
    error.stack = `${error.message}\n    at Bearer eyJhbGciOi.payload.sig`;
    log.error('provider', error);
    log.error('provider', 'search failed for AIzaSyA1234567890abcdefghijk');

    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/abcdef123456|abcd1234efgh|eyJhbGciOi|AIzaSyA1234567890/);
    expect(text).toContain('sk-[redacted]');
    expect(text).toContain('x-api-key: [redacted]');
    expect(text).toContain('Bearer [redacted]');
    expect(text).toContain('AIza[redacted]');
  });

  it.each(['gsk_', 'xai-'])('redacts %s keys in persisted messages and stacks before clipping', (prefix) => {
    const key = `${prefix}synthetic_Test-123456789`;
    const error = new Error(`${'m'.repeat(1968)} rejected ${key}`);
    error.stack = `${'s'.repeat(3968)} rejected ${key}`;
    log.error('provider', error);
    log.error('provider', { detail: `Rejected ${key}` });

    const [failed, serialized] = entries();
    expect(failed.message).toContain(`${prefix}[redacted]`);
    expect(failed.stack).toContain(`${prefix}[redacted]`);
    expect(serialized.message).toBe(JSON.stringify({ detail: `Rejected ${prefix}[redacted]` }));
    expect(readFileSync(file, 'utf8')).not.toContain('synthetic');
  });

  it('cuts very long messages and stacks', () => {
    const error = new Error('m'.repeat(5000));
    error.stack = 's'.repeat(9000);
    log.error('provider', error);

    const [entry] = entries();
    expect(entry.message.length).toBeLessThan(2100);
    expect(entry.message).toContain('more characters');
    expect(entry.stack.length).toBeLessThan(4100);
  });

  it('drops entries until a file is set, and never throws when the file cannot be written', () => {
    const early = new AppLog();
    expect(() => early.error('app', 'too early')).not.toThrow();

    writeFileSync(join(dir, 'blocker'), '');
    const broken = new AppLog();
    broken.setFile(join(dir, 'blocker', 'app.log.jsonl'));
    expect(() => broken.error('app', 'cannot write')).not.toThrow();
    expect(existsSync(join(dir, 'blocker', 'app.log.jsonl'))).toBe(false);
  });

  it('starts a new file once the log is large, keeping the previous one', () => {
    log.info('app', 'first');
    writeFileSync(file, `${'x'.repeat(600 * 1024)}\n`);
    log.info('app', 'after rotation');

    expect(readFileSync(`${file}.old`, 'utf8')).toMatch(/^x+\n$/);
    expect(entries().map((entry) => entry.message)).toEqual(['after rotation']);
  });
});

describe('redact', () => {
  it.each(['gsk_', 'xai-'])('redacts standalone %s keys without consuming surrounding punctuation', (prefix) => {
    const text = `Rejected "${prefix}Ab12_-Cd", then (${prefix}synthetic123456).`;
    expect(redact(text)).toBe(`Rejected "${prefix}[redacted]", then (${prefix}[redacted]).`);
    expect(redact(text)).toBe(redact(redact(text)));
  });

  it('preserves short prefixes and embedded identifiers', () => {
    const text = 'gsk_ xai- gsk_1234567 xai-1234567 mygsk_12345678 myxai-12345678';
    expect(redact(text)).toBe(text);
  });

  it('leaves ordinary text alone', () => {
    const text = 'ENOENT: no such file or directory, open src/index.ts (status 404)';
    expect(redact(text)).toBe(text);
  });

  it('redacts JSON-style key fields', () => {
    expect(redact('{"apiKey":"supersecretvalue","model":"m"}')).toBe('{"apiKey":"[redacted]","model":"m"}');
  });
});

describe('logNativeCrashDumps', () => {
  it('logs each native dump once and remembers it across launches', () => {
    const crashDirectory = join(dir, 'crashes');
    const stateFile = join(dir, 'logs', 'native-crashes.json');
    mkdirSync(join(crashDirectory, 'pending'), { recursive: true });
    writeFileSync(join(crashDirectory, 'pending', 'first.dmp'), 'first crash');
    writeFileSync(join(crashDirectory, 'metadata'), 'not a dump');

    expect(logNativeCrashDumps(log, crashDirectory, stateFile)).toBe(1);
    mkdirSync(join(crashDirectory, 'completed'));
    renameSync(join(crashDirectory, 'pending', 'first.dmp'), join(crashDirectory, 'completed', 'first.dmp'));
    expect(logNativeCrashDumps(log, crashDirectory, stateFile)).toBe(0);

    const nativeCrashes = entries().filter((entry) => entry.source === 'native-crash');
    expect(nativeCrashes).toHaveLength(1);
    expect(nativeCrashes[0]).toMatchObject({
      level: 'error',
      message: expect.stringContaining('crashed natively'),
      context: {
        dump: 'first.dmp',
        bytes: 11,
        modified: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    });
  });

  it('does not disrupt startup when the crash database or marker is unreadable', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');

    expect(() => logNativeCrashDumps(log, blocker, join(blocker, 'state.json'))).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});
