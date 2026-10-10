import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';

// At most this many names are kept between two commands; a big install adds many more, and the helper only needs
// the ones moved in from elsewhere, which are few.
const MAX_NAMES = 1000;

// Entries added to a project since its last sandboxed Windows command. A file or folder moved into the project keeps
// the permissions it had, without the project's sandbox grant, so the helper makes these inherit from their new folder
// again (#140). Entries created in the project already have the grant; the helper skips them after one check. One
// recursive watch per project, started with its first sandboxed command, so entries moved in before that, or while
// Patch was closed, are not seen.
export class AddedEntries {
  private root: string | null = null;
  private watcher: FSWatcher | null = null;
  private names = new Set<string>();

  // Starts watching `root`, or keeps watching it; another root replaces the one watched.
  track(root: string): void {
    if (this.root === root) return;
    this.close();
    this.root = root;
    try {
      // Only names added, removed or renamed: a change of content or permissions is not an entry moved in, and the
      // helper must not undo permissions someone set on purpose.
      this.watcher = watch(root, { recursive: true }, (event, name) => {
        if (event === 'rename' && name && this.names.size < MAX_NAMES) this.names.add(name.toString());
      });
      this.watcher.on('error', () => this.close());
      this.watcher.unref();
    } catch {
      // No watching (a folder that vanished, too many watches): nothing is refreshed, as before #140.
      this.watcher = null;
    }
  }

  // The added entries that still exist, as absolute paths, outermost only (a folder covers what is inside it), and
  // forgets them. Starts watching `root` when it is not watched yet.
  take(root: string): string[] {
    if (this.root !== root) {
      this.track(root);
      return [];
    }
    const names = [...this.names].sort((a, b) => a.length - b.length);
    this.names.clear();
    const kept: string[] = [];
    for (const name of names) {
      if (kept.some((outer) => name.startsWith(`${outer}${sep}`))) continue;
      if (existsSync(join(root, name))) kept.push(name);
    }
    return kept.map((name) => join(root, name));
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.root = null;
    this.names.clear();
  }
}
