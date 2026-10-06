import { describe, expect, it } from 'vitest';
import { containsRedaction, redactSecrets, REDACTION_MARK } from './redact';

describe('redactSecrets', () => {
  it.each([
    ['AWS key', 'id AKIAIOSFODNN7EXAMPLE end'],
    ['GitHub token', `token ghp_${'a'.repeat(36)}`],
    ['Anthropic key', `key sk-ant-${'x1'.repeat(20)}`],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghij1234567890'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQ\nabc\n-----END RSA PRIVATE KEY-----'],
  ])('replaces a %s', (_name, text) => {
    const out = redactSecrets(text);
    expect(containsRedaction(out)).toBe(true);
    expect(out).not.toContain('EXAMPLE');
  });

  it('keeps the surrounding text', () => {
    expect(redactSecrets('before AKIAIOSFODNN7EXAMPLE after')).toBe(`before ${REDACTION_MARK} after`);
  });

  it('redacts quoted credential values and .env lines', () => {
    expect(redactSecrets('const password = "hunter2hunter2";')).toBe(`const password = "${REDACTION_MARK}";`);
    expect(redactSecrets('{"api_key": "abcdefgh12345"}')).toBe(`{"api_key": "${REDACTION_MARK}"}`);
    expect(redactSecrets('A=1\nDB_PASSWORD=supersecret1\nPORT=80')).toBe(`A=1\nDB_PASSWORD=${REDACTION_MARK}\nPORT=80`);
    expect(redactSecrets('export STRIPE_SECRET_KEY="sk_live_abcdefgh"')).toContain(REDACTION_MARK);
  });

  // #123: connection strings in config files reach the model through read_file, which needs no approval.
  it.each([
    [
      'DATABASE_URL=postgres://admin:hunter2secret@db.example.com/prod',
      `DATABASE_URL=postgres://admin:${REDACTION_MARK}@db.example.com/prod`,
    ],
    [
      'const mongoUri = "mongodb+srv://user:P@ssw0rd123@cluster0.mongodb.net/db"',
      `const mongoUri = "mongodb+srv://user:${REDACTION_MARK}@cluster0.mongodb.net/db"`,
    ],
    ['redis://:mypassword123@redis.internal:6379/0', `redis://:${REDACTION_MARK}@redis.internal:6379/0`],
    ['amqp://guest:p%40ss%3Aword@rabbit:5672', `amqp://guest:${REDACTION_MARK}@rabbit:5672`],
    [
      'origin  https://deploy:abcd1234efgh@git.example.com/team/repo.git (fetch)',
      `origin  https://deploy:${REDACTION_MARK}@git.example.com/team/repo.git (fetch)`,
    ],
    ["url: 'mysql://root:pa:ss@localhost/app'", `url: 'mysql://root:${REDACTION_MARK}@localhost/app'`],
  ])('redacts the password in %s', (text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });

  it('leaves URLs without a password alone', () => {
    const text = [
      'ssh://git@github.com:22/team/repo.git',
      'https://example.com/a:b@c',
      'see https://user@example.com/path',
      'postgres://localhost:5432/app',
      'mailto:someone@example.com',
      'http://[::1]:8080/health',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  it('is unchanged by a second pass', () => {
    const once = redactSecrets('postgres://admin:hunter2secret@db/prod');
    expect(redactSecrets(once)).toBe(once);
  });

  it('stays fast on long lines that look partly like URLs', () => {
    const lines = [
      'a'.repeat(512 * 1024),
      `x://${'a'.repeat(512 * 1024)}`,
      `x://u:${'p'.repeat(512 * 1024)}`,
      'x://u:p'.repeat(70_000),
    ];
    for (const line of lines) {
      const started = Date.now();
      redactSecrets(line);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('leaves ordinary code alone', () => {
    const code = [
      'const token = getAccessToken();',
      'let password: string;',
      'if (token === undefined) return;',
      'const secret = process.env.SECRET_VALUE;',
      'task-management-and-other-long-words',
      'NODE_ENV=production',
    ].join('\n');
    expect(redactSecrets(code)).toBe(code);
  });
});
