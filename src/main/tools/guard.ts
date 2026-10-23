// Files an edit must never touch without the user looking at it, even in Auto mode: credentials and keys, Git
// internals, and the folders of editors and agents (their config can change what runs on the machine), shell start-up
// files, databases, and system folders. Paths are project-relative with forward slashes, or absolute for a file
// outside the project.

// Credentials and keys. Example files such as .env.example hold no secrets and stay open.
const SECRETS: RegExp[] = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i,
  /(^|\/)\.(ssh|gnupg|aws|kube|azure|docker)(\/|$)/i,
  /(^|\/)\.(npmrc|netrc|pypirc)$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)\.config\/gcloud\//i,
  // direnv files usually export tokens, and direnv runs them on cd.
  /(^|\/)\.envrc$/i,
  // Git, cloud and Terraform credentials and state (#283).
  /(^|\/)\.git-credentials$/i,
  /\.env$/i,
  /(^|\/)credentials\.json$/i,
  /\.tfvars(\.json)?$/i,
  /(^|\/)terraform\.tfstate(\.backup)?$/i,
];

const GUARDED: RegExp[] = [
  ...SECRETS,
  // Version-control internals.
  /(^|\/)\.git(\/|$)/i,
  // Editor and agent configuration.
  /(^|\/)\.(cursor|windsurf|claude|codex|vscode|idea|amp|gemini|zed|continue|kilo|kilocode|agents)(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
  // Patch's own instructions: the project's AGENTS.md or CLAUDE.md and its skills go into every new chat's system
  // prompt, so an unreviewed edit would carry over into later chats (#236).
  /^(AGENTS|CLAUDE)\.md$/i,
  /(^|\/)\.patch(\/|$)/i,
  // Husky's hooks run on git commit (direnv's .envrc is listed with the secrets).
  /(^|\/)\.husky(\/|$)/i,
  // Other hook managers run on git commit, yarn and pnpm run the files their config names, and a dev container or
  // workspace file can run a command when it is opened (#283). CI files (.gitlab-ci.yml, .circleci/ and so on) are left
  // to the normal approval rules like .github, but sandboxed commands may not change them (sandbox_config.ts).
  /(^|\/)(\.pre-commit-config\.yaml|\.?lefthook\.ya?ml|\.yarnrc\.yml|\.pnpmfile\.cjs)$/i,
  /(^|\/)\.simple-git-hooks\.[^/]+$/i,
  /(^|\/)\.devcontainer(\/|$)/i,
  /\.code-workspace$/i,
  // Other agents' configuration.
  /(^|\/)\.(roo|clinerules|cursorrules|windsurfrules|aider\.conf\.yml)(\/|$)/i,
  /^GEMINI\.md$/i,
  // Shell start-up files.
  /(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|profile|zshenv)$/i,
  /(^|\/)\.config\/fish\//i,
  // Databases.
  /\.(sqlite3?|db)$/i,
  // System folders.
  /^[A-Za-z]:\/(Windows|Program Files)/i,
  /^\/(etc|boot|sys|proc)\//i,
];

const matches = (patterns: RegExp[], path: string) => {
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => pattern.test(normalized));
};

export function isGuardedPath(path: string): boolean {
  return matches(GUARDED, path);
}

// Files that hold credentials: their content is never sent away for search indexing (#234).
export function isSecretPath(path: string): boolean {
  return matches(SECRETS, path);
}
