import { win32 } from 'node:path';

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

// Only runtime/toolchain locations, never credentials, agent/display handles or startup options.
const SANDBOX_COMMON = new Set(['PATH', 'JAVA_HOME', 'GOROOT', 'GOPATH', 'RUSTUP_HOME']);
const SANDBOX_UNIX = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ']);
const SANDBOX_WINDOWS = new Set([
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  // Windows rewrites this to the AppContainer profile during process creation.
  'LOCALAPPDATA',
]);
const SANDBOX_BLOCKED =
  /^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|ZDOTDIR|LD_.*|DYLD_.*|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|PYTHON.*|PERL.*|RUBY.*|GIT_.*|PSMODULEPATH|SSH_AUTH_SOCK|GPG_TTY|KEYCHAIN_PATH|XAUTHORITY|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS)$/i;

export function sandboxEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  tmp: string,
  options: { envAllowList?: string; path?: string } = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const allowed = platform === 'win32' ? SANDBOX_WINDOWS : SANDBOX_UNIX;
  // These grants come only from native-confirmed app settings, not a repository or tool call.
  const extra = new Set(
    (options.envAllowList ?? '')
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SANDBOX_BLOCKED.test(name))
      .map((name) => (platform === 'win32' ? name.toUpperCase() : name)),
  );
  for (const [name, value] of Object.entries(env)) {
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (value !== undefined && (SANDBOX_COMMON.has(key) || allowed.has(key) || extra.has(key))) out[key] = value;
  }
  if (options.path?.trim()) out.PATH = options.path.trim();
  out.HOME = home;
  out.TMPDIR = tmp;
  if (platform === 'win32') {
    out.USERPROFILE = home;
    out.TEMP = tmp;
    out.TMP = tmp;
    // AppContainer cannot discover user-profile module folders. Supply Windows PowerShell's built-in
    // modules explicitly; never restore the host's PSModulePath (which may include user/startup code).
    out.PSMODULEPATH = win32.join(out.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  }
  return out;
}
