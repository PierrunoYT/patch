import { execFile } from 'node:child_process';

// Windows has no process groups. Once a shell exits, `taskkill /T` cannot find the programs it started (`Start-Process
// npm.cmd run dev`, `cmd /c start ...`), since the tree is walked from a live pid. Their ParentProcessId still names the
// shell, though, so the leftovers are found by looking at every process (#165).

export interface ProcessRow {
  pid: number;
  parent: number;
  // Creation time in epoch milliseconds.
  created: number;
}

// Clock readings of the process list and of Node can differ a little.
const CLOCK_SLACK_MS = 2000;

// The programs the shell started and left running: its children, and theirs. A pid is reused only after its process
// exits, so a child of `root` created before the shell ended is the shell's own; one created later belongs to a
// process that took the number. Deeper levels need the parent to be in the list, still running, and older than the
// child.
export function findLeftovers(
  rows: readonly ProcessRow[],
  root: number,
  lifetime: { startedAt: number; endedAt: number },
  excluded: readonly number[] = [],
): number[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parent);
    if (siblings) siblings.push(row);
    else byParent.set(row.parent, [row]);
  }
  const found: ProcessRow[] = [];
  const seen = new Set<number>([root]);
  const collect = (parent: number, created: number | undefined) => {
    for (const row of byParent.get(parent) ?? []) {
      if (seen.has(row.pid)) continue;
      if (created === undefined) {
        if (row.created < lifetime.startedAt - CLOCK_SLACK_MS || row.created > lifetime.endedAt + CLOCK_SLACK_MS)
          continue;
      } else if (row.created < created) continue;
      seen.add(row.pid);
      found.push(row);
      collect(row.pid, row.created);
    }
  };
  collect(root, undefined);
  return found.map((row) => row.pid).filter((pid) => pid > 4 && !excluded.includes(pid));
}

export function parseProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(\d+)$/.exec(line.trim());
    if (match) rows.push({ pid: Number(match[1]), parent: Number(match[2]), created: Number(match[3]) });
  }
  return rows;
}

const LIST_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { ' +
  '"$($_.ProcessId),$($_.ParentProcessId),$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" } }';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT];
const SWEEP_TIMEOUT_MS = 15_000;

// Runs a program and returns its output, or null when it fails. Never rejects.
function run(file: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) =>
        resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

async function killPids(pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  await run('taskkill', ['/F', ...pids.flatMap((pid) => ['/PID', String(pid)])], 10_000);
}

// A process as listed for a tree walk. `started` identifies the process together with its pid, so one that took a
// pid meanwhile is not mistaken for it: creation time in epoch milliseconds on Windows, `ps` lstart elsewhere.
export interface TreeRow {
  pid: number;
  parent: number;
  started: string;
}

// `ps -A -o pid= -o ppid= -o lstart=` output.
export function parsePsRows(text: string): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), parent: Number(match[2]), started: match[3]! });
  }
  return rows;
}

// `root` and everything below it. Children are found even when `root` itself has already exited: Windows keeps a
// process's ParentProcessId after its parent ends.
export function processTree(rows: readonly TreeRow[], root: number): TreeRow[] {
  const found = rows.filter((row) => row.pid === root);
  const pending = [root];
  const seen = new Set([root]);
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const row of rows) {
      if (row.parent !== parent || seen.has(row.pid)) continue;
      seen.add(row.pid);
      found.push(row);
      pending.push(row.pid);
    }
  }
  return found;
}

// Every process with its parent, or null when they cannot be listed. Never rejects.
export async function listProcesses(): Promise<TreeRow[] | null> {
  if (process.platform === 'win32') {
    const listed = await run('powershell.exe', POWERSHELL_ARGS, SWEEP_TIMEOUT_MS);
    return listed === null
      ? null
      : parseProcessRows(listed).map((row) => ({ pid: row.pid, parent: row.parent, started: String(row.created) }));
  }
  const listed = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart='], SWEEP_TIMEOUT_MS);
  return listed === null ? null : parsePsRows(listed);
}

// Kills the processes of `tree` that still run as the same process (same pid and start time). Never rejects.
export async function killSurvivors(tree: readonly TreeRow[]): Promise<void> {
  if (tree.length === 0) return;
  const now = await listProcesses();
  if (!now) return;
  const pids = now
    .filter((row) => tree.some((old) => old.pid === row.pid && old.started === row.started))
    .map((row) => row.pid)
    .filter((pid) => pid > 4 && pid !== process.pid);
  if (process.platform === 'win32') return killPids(pids);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

// Kills what the shell `root` left running. Asynchronous, so the process listing (a few hundred milliseconds, up to
// the sweep timeout) does not freeze the main process (#112); quitting waits for it. Never rejects.
export async function killWindowsLeftovers(
  root: number,
  lifetime: { startedAt: number; endedAt: number },
): Promise<void> {
  try {
    const listed = await run('powershell.exe', POWERSHELL_ARGS, SWEEP_TIMEOUT_MS);
    if (listed === null) return;
    await killPids(findLeftovers(parseProcessRows(listed), root, lifetime, [process.pid]));
  } catch {
    // Nothing more can be done for programs that cannot be listed.
  }
}
