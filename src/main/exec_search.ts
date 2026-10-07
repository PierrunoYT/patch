// Patch starts several programs by bare name (git, powershell.exe, docker, taskkill), most of them with the open
// project as their working directory. Windows looks for such a name in the working directory before PATH, and an empty
// or relative PATH entry makes every platform look there too, so a `git.exe` committed to a repository would run
// with the user's rights as soon as the project opened (#141). libuv reads both values from this process at every
// spawn, whatever environment the child gets, so they are fixed once, before anything is started.

const NO_CWD_SEARCH = 'NoDefaultCurrentDirectoryInExePath';

// A PATH entry that names the same folder wherever the child runs: a drive or UNC path on Windows, `/…` elsewhere.
// Empty, `.`, relative, drive-relative (`C:tools`) and root-relative (`\tools`) entries depend on the working
// directory.
function isFixedEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return entry.startsWith('/');
  const unquoted = entry.replace(/^"(.*)"$/, '$1');
  return /^[A-Za-z]:[\\/]/.test(unquoted) || /^[\\/]{2}[^\\/]/.test(unquoted);
}

// PATH without the entries that depend on the working directory, and the entries it dropped.
export function fixedSearchPath(value: string, platform: NodeJS.Platform): { path: string; dropped: string[] } {
  const separator = platform === 'win32' ? ';' : ':';
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of value.split(separator)) (isFixedEntry(entry, platform) ? kept : dropped).push(entry);
  return { path: kept.join(separator), dropped };
}

// Makes bare program names resolve only through fixed PATH folders. Returns how many PATH entries were dropped.
export function hardenExecutableSearch(env: NodeJS.ProcessEnv = process.env, platform = process.platform): number {
  if (platform === 'win32') env[NO_CWD_SEARCH] = '1';
  // Windows environment names are case-insensitive, and a copied environment may spell it `Path`.
  const key = platform === 'win32' ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') : 'PATH';
  const value = key ? env[key] : undefined;
  if (!key || value === undefined) return 0;
  const { path, dropped } = fixedSearchPath(value, platform);
  if (dropped.length > 0) env[key] = path;
  return dropped.length;
}
