import { basename } from 'node:path';
import type { SkillList } from '../tools/skills';
import type { Workspace } from '../tools/workspace';
import type { AgentFile } from './agent_file';
import { buildProjectMap } from './project_map';

export interface SystemPromptInput {
  workspace: Workspace;
  shell: string;
  platform: string;
  date: string;
  customInstructions: string;
  agentFile: AgentFile | null;
  // The project's skills when the chat starts. Listed once, like the rest of the prompt.
  skills: SkillList;
  // The project's memory notes, or null when memory is off (no section, and no remember tool).
  memory: string[] | null;
}

const MEMORY_HEADING = '# Project memory';
const MAX_MEMORY_PROMPT_CHARS = 4000;

// Whether a chat's (possibly saved) system prompt has the project memory section. remember is offered exactly when it
// does, so a chat's tool list and prompt agree, even when memory is switched during the chat.
export function promptHasMemory(system: string): boolean {
  return system.includes(`\n\n${MEMORY_HEADING}\n`);
}

const SKILLS_HEADING = '# Project skills';

// Whether a chat's (possibly saved) system prompt lists skills. load_skill is offered exactly when it does, so the
// tool and the list the model was given never disagree, even when skills are added or removed during the chat.
export function promptListsSkills(system: string): boolean {
  return system.includes(`\n\n${SKILLS_HEADING}\n`);
}

// Built once when a chat starts and kept byte-identical afterwards so the prompt prefix stays cached.
export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections = [
    `You are Patch, a coding assistant working directly in the user's project on their computer. You can read and change files, run commands and look things up, using the tools provided.`,

    `# Environment
- Project: ${basename(input.workspace.root)} at ${input.workspace.root}
- Operating system: ${platformName(input.platform)}
- Shell for run_command: ${input.shell}
- Date: ${input.date}`,

    `# How to work
- Understand the code before changing it, but read only what the task needs. Locate first, then read: use grep, find_definition and find_references to locate a symbol's declaration and uses, use search_code when it is in the currently offered tools, and use list_directory only when you do not know where something lives. Then read just the files, or the line range (offset and limit), that you will change or depend on. Follow the project's existing conventions, libraries and style. Optional tools can become available during the chat; the current tool list is authoritative.
- Do not explore for its own sake. Skip files the project overview, the instructions above or the conversation already answer; do not re-read a file you have read unless it may have changed; do not read whole files to find one symbol (grep it); and do not read neighbouring files, tests or docs unless the task touches them. Questions that need no code (explanations, general advice, a command to run) need no reading at all. Stop exploring as soon as you can act, and read more only when something turns out to be missing.
- Make focused changes with edit_file; use write_file for new files; use apply_patch for a change that spans several files. Do not change code unrelated to the task.
- Change files only with edit_file, write_file and apply_patch, never with shell commands (sed, perl, PowerShell scripts, redirects), even for the same change in many files: the edit tools show the user a diff, ask for approval and can be undone; changes made by a command cannot. For one string in many files, use edit_file with replace_all once per file.
- Send independent read-only calls (read_file, grep, glob, list_directory) together in one turn: they run at the same time and save round trips. Edit a file in a later turn than the one that reads it.
- Verify your work: run the project's tests, build or linter with run_command when they exist, and check web UIs with the browser tool when offered. If something fails, fix it or explain why you could not.
- Commands run non-interactively in a fresh shell in the project root. Start servers and watchers with background=true.
- Changes to files and commands may need the user's approval. If the user declines an action, adjust based on their feedback rather than retrying the same thing.
- When a request is ambiguous and the choice matters, ask the user instead of guessing.
- Keep the user informed in a few words as you go. When finished, summarize what you changed and how you verified it.`,

    `# Project overview\n${buildProjectMap(input.workspace)}`,
  ];

  if (input.agentFile) {
    const { name, content, truncated } = input.agentFile;
    sections.push(`# Instructions from ${name} in the project\n${content}${truncated ? '\n(truncated)' : ''}`);
  }
  if (input.customInstructions.trim()) {
    sections.push(`# Project instructions from the user\n${input.customInstructions.trim()}`);
  }
  if (input.memory) {
    const kept: string[] = [];
    let size = 0;
    for (const note of input.memory) {
      size += note.length + 3;
      if (size > MAX_MEMORY_PROMPT_CHARS) break;
      kept.push(note);
    }
    const more =
      kept.length < input.memory.length ? `\n(${input.memory.length - kept.length} more notes are not shown.)` : '';
    const notes = kept.length > 0 ? `\n${kept.map((note) => `- ${note}`).join('\n')}` : '\n(No notes yet.)';
    sections.push(
      `${MEMORY_HEADING}\nNotes the user approved for this project, kept outside the repository. Treat them as the user's instructions. They do not change during the chat; propose a new one with the remember tool only for a durable fact worth keeping (the user approves each).${notes}${more}`,
    );
  }
  const { skills, omitted } = input.skills;
  if (skills.length > 0) {
    const more =
      omitted > 0 ? `\n(${omitted} more skill files are not listed; only the first ${skills.length} are.)` : '';
    sections.push(
      `${SKILLS_HEADING}\nShort instruction files for recurring tasks, loaded on demand with the load_skill tool. Load the matching skill before doing work it covers:\n${skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n')}${more}`,
    );
  }
  return sections.join('\n\n');
}

function platformName(platform: string): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
}
