export interface ProjectInfo {
  path: string;
  name: string;
  // Added to the system prompt of every chat in this project.
  instructions: string;
  // Added to the global lists in Settings, for this project only (same format: one entry per line). Kept in the app's
  // data folder, not in the project, so a repository cannot allow its own commands. Missing in files written before
  // these existed.
  allowedCommands?: string;
  allowedNetworkHosts?: string;
  // The project's memory: notes the user approved (through the agent's `remember` tool) or wrote, one per line, kept in
  // the app's data folder, not in the repository. Added to the system prompt of new chats. Missing: none yet.
  memory?: string;
  // Missing means on. Off: no notes in the prompt and no `remember` tool in new chats.
  memoryEnabled?: boolean;
  // A command that checks the project (`npx tsc --noEmit -p .`, `ruff check`, `cargo check`). After a turn's edits the
  // agent runs it and tells the model the errors in the edited files (#81). Empty: no check. Also kept in the app's data.
  checkCommand?: string;
  lastOpened: string;
}

// What the Project settings dialog changes.
// A missing memory, memoryEnabled or checkCommand leaves the stored one alone.
export type ProjectSettings = Pick<ProjectInfo, 'instructions'> &
  Required<Pick<ProjectInfo, 'allowedCommands' | 'allowedNetworkHosts'>> &
  Pick<ProjectInfo, 'memory' | 'memoryEnabled' | 'checkCommand'>;

export const MAX_MEMORY_NOTES = 50;
export const MAX_MEMORY_NOTE_CHARS = 300;

// Cleans memory text into notes: one per line, whitespace collapsed, long notes cut, duplicates and blanks dropped,
// at most MAX_MEMORY_NOTES.
export function memoryNotes(text: string | undefined): string[] {
  const notes = (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_NOTE_CHARS).trim())
    .filter(Boolean);
  return [...new Set(notes)].slice(0, MAX_MEMORY_NOTES);
}

// The notes a new chat gets, or null when the project's memory is off.
export function projectMemory(
  project: Pick<ProjectInfo, 'memory' | 'memoryEnabled'> | null | undefined,
): string[] | null {
  return project?.memoryEnabled === false ? null : memoryNotes(project?.memory);
}

// An allow-list made of the global one and the project's own: an entry in either counts.
export function mergeAllowLists(global: string, project: string | undefined): string {
  return project?.trim() ? `${global}\n${project}` : global;
}
