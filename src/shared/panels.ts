export type PanelName = 'terminal' | 'browser' | 'git';

// The user's own browsing in the Browser panel. It keeps cookies and sign-ins across restarts.
export const USER_BROWSER_PARTITION = 'persist:browser';
// Pages the agent's browser tool opens. Without the "persist:" prefix Electron keeps this session in memory only, so
// the agent never sees the user's cookies or sign-ins and nothing it collects is written to disk.
export const AGENT_BROWSER_PARTITION = 'agent-browser';
export const BROWSER_PARTITIONS: readonly string[] = [USER_BROWSER_PARTITION, AGENT_BROWSER_PARTITION];

// Whether the app window may attach a <webview> with these attributes. Only the Browser panel's two sessions are
// allowed, and a guest starts on about:blank or a web page; the app navigates it from there.
export function allowsWebviewAttach(partition: string | undefined, src: string | undefined): boolean {
  if (!partition || !BROWSER_PARTITIONS.includes(partition)) return false;
  return !src || src === 'about:blank' || /^https?:\/\//i.test(src);
}

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFile {
  path: string;
  status: GitFileStatus;
  // Lines added and removed against the last commit; missing for binary or very large files.
  added?: number;
  removed?: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  files: GitFile[];
  // The upstream branch (e.g. origin/main) and how far the local branch is ahead of and behind it.
  tracking: string | null;
  ahead: number;
  behind: number;
  // Whether the branch can be pushed: it has an upstream, or the repository has a remote named origin.
  canPush: boolean;
}

// Counts per path from `git diff --numstat` output ("added<TAB>removed<TAB>path"; "-" for binary files).
export function parseNumstat(output: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match || match[1] === '-' || match[2] === '-') continue;
    const previous = counts.get(match[3]!) ?? { added: 0, removed: 0 };
    counts.set(match[3]!, { added: previous.added + Number(match[1]), removed: previous.removed + Number(match[2]) });
  }
  return counts;
}

// The hunks of a unified diff, each with the file it belongs to, for stepping through them one at a time.
export interface DiffHunk {
  file: string;
  header: string;
  lines: string[];
}

export function diffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let file = '';
  let current: DiffHunk | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff ') || line.startsWith('Index: ') || line.startsWith('====')) {
      current = null;
      continue;
    }
    if (!current && line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '').split('\t')[0]!;
      continue;
    }
    if (!current && line.startsWith('--- ')) continue;
    if (line.startsWith('@@')) {
      current = { file, header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current && line !== '\\ No newline at end of file') current.lines.push(line);
  }
  // A trailing newline leaves an empty last line in each hunk.
  for (const hunk of hunks) while (hunk.lines.at(-1) === '') hunk.lines.pop();
  return hunks;
}
