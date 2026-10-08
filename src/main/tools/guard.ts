// Files an edit must never touch without the user looking at it, even in Auto mode: credentials and keys, Git
// internals, and the folders of editors and agents (their config can change what runs on the machine), shell start-up
// files, databases, and system folders. Paths are project-relative with forward slashes, or absolute for a file
// outside the project.

const GUARDED: RegExp[] = [
  // Credentials and keys. Example files such as .env.example hold no secrets and stay open.
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i,
  /(^|\/)\.(ssh|gnupg|aws|kube|azure|docker)(\/|$)/i,
  /(^|\/)\.(npmrc|netrc|pypirc)$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)\.config\/gcloud\//i,
  // Version-control internals.
  /(^|\/)\.git(\/|$)/i,
  // Editor and agent configuration.
  /(^|\/)\.(cursor|windsurf|claude|codex|vscode|idea|amp)(\/|$)/i,
  // Shell start-up files.
  /(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|profile|zshenv)$/i,
  /(^|\/)\.config\/fish\//i,
  // Databases.
  /\.(sqlite3?|db)$/i,
  // System folders.
  /^[A-Za-z]:\/(Windows|Program Files)/i,
  /^\/(etc|boot|sys|proc)\//i,
];

export function isGuardedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return GUARDED.some((pattern) => pattern.test(normalized));
}
