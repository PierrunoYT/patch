// Names that look like credentials. Agent commands run with the user's rights, so a prompt-injected command
// could read these from the environment and send them out.
const SECRET_NAME =
  /(^|_)(API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|ARL|AUTH|SESSION)(_|$)|^(AWS|AZURE|GCP|GOOGLE|OPENAI|ANTHROPIC|GITHUB|GITLAB|NPM|SUPABASE|TAURI)_.*(KEY|TOKEN|SECRET|PASSWORD)|_(KEY|PAT)$/i;
const KEEP = new Set(['SSH_AUTH_SOCK', 'GPG_TTY', 'KEYCHAIN_PATH', 'XAUTHORITY', 'TERM_SESSION_ID', 'SESSIONNAME']);

export function isSecretEnvName(name: string): boolean {
  return !KEEP.has(name.toUpperCase()) && SECRET_NAME.test(name);
}

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isSecretEnvName(name)) out[name] = value;
  }
  return out;
}
