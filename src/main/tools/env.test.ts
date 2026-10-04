import { describe, expect, it } from 'vitest';
import { scrubEnv } from './env';

describe('scrubEnv', () => {
  it('removes credential-like variables and keeps the rest', () => {
    const out = scrubEnv({
      PATH: '/bin',
      HOME: '/h',
      OPENAI_API_KEY: 'x',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'x',
      DEEZER_ARL_TOKEN: 'x',
      DB_PASSWORD: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      SSH_AUTH_SOCK: '/s',
      SESSIONNAME: 'Console',
      TAURI_SIGNING_PRIVATE_KEY: 'x',
      ComSpec: 'cmd',
    });
    expect(Object.keys(out).sort()).toEqual(['ComSpec', 'HOME', 'PATH', 'SESSIONNAME', 'SSH_AUTH_SOCK']);
  });
});
