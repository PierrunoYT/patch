import { spawn, spawnSync } from 'node:child_process';

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

function killPids(pids: number[]): void {
  if (pids.length === 0) return;
  spawnSync('taskkill', ['/F', ...pids.flatMap((pid) => ['/PID', String(pid)])], {
    stdio: 'ignore',
    timeout: 10_000,
    windowsHide: true,
  });
}

// Kills what the shell `root` left running. Synchronous: for Stop, closing a chat and quitting, which cannot wait.
export function killWindowsLeftovers(root: number, lifetime: { startedAt: number; endedAt: number }): void {
  try {
    const listed = spawnSync('powershell.exe', POWERSHELL_ARGS, {
      encoding: 'utf8',
      timeout: SWEEP_TIMEOUT_MS,
      windowsHide: true,
    });
    if (listed.status !== 0) return;
    killPids(findLeftovers(parseProcessRows(listed.stdout), root, lifetime, [process.pid]));
  } catch {
    // Nothing more can be done for programs that cannot be listed.
  }
}

// The same without blocking the main process: for a foreground command that has just finished, whose result must
// not wait for a process listing that takes a few hundred milliseconds.
export function killWindowsLeftoversLater(root: number, lifetime: { startedAt: number; endedAt: number }): void {
  try {
    const lister = spawn('powershell.exe', POWERSHELL_ARGS, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: SWEEP_TIMEOUT_MS,
    });
    let text = '';
    lister.stdout.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
    lister.on('error', () => undefined);
    lister.on('close', (code) => {
      if (code !== 0) return;
      try {
        killPids(findLeftovers(parseProcessRows(text), root, lifetime, [process.pid]));
      } catch {
        // Best effort.
      }
    });
  } catch {
    // Best effort.
  }
}
