import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '../tools/workspace';
import { buildSystemPrompt, promptHasMemory, promptListsSkills, type SystemPromptInput } from './system_prompt';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-prompt-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{}');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function input(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    workspace: new Workspace(root),
    shell: 'PowerShell',
    platform: 'win32',
    date: '2026-09-29',
    customInstructions: '',
    agentFile: null,
    skills: { skills: [], omitted: 0 },
    memory: null,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('describes the environment and maps the project', () => {
    const prompt = buildSystemPrompt(input());
    expect(prompt).toContain('Operating system: Windows');
    expect(prompt).toContain('Shell for run_command: PowerShell');
    expect(prompt).toContain('# Project overview\n(1 file)\nsrc/ (0 files)\npackage.json');
    expect(prompt).not.toContain('top level');
    expect(prompt).not.toContain('node_modules');
    expect(prompt).toContain(
      'Send independent read-only calls (read_file, grep, glob, list_directory) together in one turn: they run at the same time and save round trips. Edit a file in a later turn than the one that reads it.',
    );
  });

  it('defers optional tool availability to the current tool list without changing the cached prompt', () => {
    const prompt = buildSystemPrompt(input());
    expect(prompt).toContain('search_code when it is in the currently offered tools');
    expect(prompt).toContain('browser tool when offered');
    expect(prompt).toContain('current tool list is authoritative');
  });

  it('appends project instructions', () => {
    const prompt = buildSystemPrompt(input({ customInstructions: 'Use tabs.' }));
    expect(prompt.endsWith('# Project instructions from the user\nUse tabs.')).toBe(true);
  });

  it('injects the agent file before the user instructions', () => {
    const prompt = buildSystemPrompt(
      input({
        agentFile: { name: 'AGENTS.md', content: 'Run tests.', truncated: false },
        customInstructions: 'Use tabs.',
      }),
    );
    expect(prompt).toContain('# Instructions from AGENTS.md in the project\nRun tests.');
    expect(prompt.indexOf('Run tests.')).toBeLessThan(prompt.indexOf('Use tabs.'));
  });

  it('is deterministic for the same input so the prefix stays cached', () => {
    expect(buildSystemPrompt(input())).toBe(buildSystemPrompt(input()));
  });

  it('lists project skills, says how many were left out, and is detected by promptListsSkills', () => {
    const prompt = buildSystemPrompt(
      input({ skills: { skills: [{ name: 'deploy', description: 'Release checklist.' }], omitted: 3 } }),
    );
    expect(prompt).toContain('# Project skills\n');
    expect(prompt).toContain('- deploy: Release checklist.');
    expect(prompt).toContain('3 more skill files are not listed');
    expect(promptListsSkills(prompt)).toBe(true);
  });

  it('puts memory notes after the project instructions and is detected by promptHasMemory', () => {
    const prompt = buildSystemPrompt(
      input({ customInstructions: 'Be brief.', memory: ['Use pnpm', 'src/gen is generated'] }),
    );
    expect(prompt).toContain('# Project memory\n');
    expect(prompt).toContain('- Use pnpm\n- src/gen is generated');
    expect(prompt.indexOf('# Project instructions from the user')).toBeLessThan(prompt.indexOf('# Project memory'));
    expect(promptHasMemory(prompt)).toBe(true);
  });

  it('has a memory section without notes when memory is on, and none when it is off', () => {
    const on = buildSystemPrompt(input({ memory: [] }));
    expect(on).toContain('(No notes yet.)');
    expect(promptHasMemory(on)).toBe(true);
    const off = buildSystemPrompt(input({ memory: null }));
    expect(off).not.toContain('# Project memory');
    expect(promptHasMemory(off)).toBe(false);
  });

  it('caps the memory notes in the prompt and says how many were left out', () => {
    const notes = Array.from({ length: 40 }, (_, index) => `note ${index} ${'x'.repeat(290)}`);
    const prompt = buildSystemPrompt(input({ memory: notes }));
    expect(prompt).toMatch(/\(\d+ more notes are not shown\.\)/);
    expect(prompt.length).toBeLessThan(10_000);
  });

  it('has no skills section, and offers no load_skill, when the project has no skills', () => {
    const prompt = buildSystemPrompt(input());
    expect(prompt).not.toContain('# Project skills');
    expect(promptListsSkills(prompt)).toBe(false);
  });
});
