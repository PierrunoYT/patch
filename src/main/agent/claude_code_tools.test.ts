import { describe, expect, it } from 'vitest';
import { describeClaudeCodeTool, toolResultText } from './claude_code_tools';

const cwd = '/work/project';

describe('describeClaudeCodeTool', () => {
  it('shows a Bash command with its description, and says which sandbox it runs under', () => {
    const linux = describeClaudeCodeTool('Bash', { command: 'npm test', description: 'Run tests' }, cwd, 'linux');
    expect(linux).toMatchObject({ preview: { title: 'Run tests', command: 'npm test' }, showsOutput: true });
    expect(linux.preview.note).toContain('not Patch’s command sandbox');
    expect(linux.preview.note).not.toContain('unsandboxed');
  });

  it('says a Windows command runs unsandboxed', () => {
    const windows = describeClaudeCodeTool('Bash', { command: 'dir' }, cwd, 'win32');
    expect(windows.preview).toMatchObject({ title: 'Run command', command: 'dir' });
    expect(windows.preview.note).toContain('unsandboxed');
  });

  it('says when a command asks to run outside the sandbox', () => {
    const asked = describeClaudeCodeTool(
      'Bash',
      { command: 'git push', dangerouslyDisableSandbox: true },
      cwd,
      'darwin',
    );
    expect(asked.preview.note).toContain('outside the sandbox');
    const plain = describeClaudeCodeTool(
      'Bash',
      { command: 'git status', dangerouslyDisableSandbox: false },
      cwd,
      'darwin',
    );
    expect(plain.preview.note).not.toContain('outside the sandbox');
  });

  it('shows a file inside the project relative to it, and one outside it as written', () => {
    expect(describeClaudeCodeTool('Read', { file_path: '/work/project/src/a.ts' }, cwd, 'linux')).toMatchObject({
      preview: { title: 'Read src/a.ts' },
      path: 'src/a.ts',
      showsOutput: false,
    });
    expect(describeClaudeCodeTool('Read', { file_path: '/etc/hosts' }, cwd, 'linux')).toMatchObject({
      preview: { title: 'Read /etc/hosts' },
      path: '/etc/hosts',
    });
    expect(describeClaudeCodeTool('Edit', { file_path: 'docs\\guide.md' }, cwd, 'win32').path).toBe('docs/guide.md');
  });

  it('shows an edit and a write as a diff of the file', () => {
    const edit = describeClaudeCodeTool(
      'Edit',
      { file_path: 'a.txt', old_string: 'one', new_string: 'two' },
      cwd,
      'linux',
    );
    expect(edit.preview.diff).toContain('-one');
    expect(edit.preview.diff).toContain('+two');
    expect(edit.showsOutput).toBe(false);
    const write = describeClaudeCodeTool('Write', { file_path: 'new.txt', content: 'hello' }, cwd, 'linux');
    expect(write).toMatchObject({ preview: { title: 'Write new.txt' }, path: 'new.txt' });
    expect(write.preview.diff).toContain('+hello');
  });

  it('shows a checklist, and leaves out malformed entries', () => {
    const todos = describeClaudeCodeTool(
      'TodoWrite',
      {
        todos: [
          { content: 'Plan', status: 'completed' },
          { content: 'Build', status: 'in_progress' },
          { content: 'Test' },
          null,
          'loose',
        ],
      },
      cwd,
      'linux',
    );
    expect(todos.preview.text).toBe('- [x] Plan\n- [ ] Build (in progress)\n- [ ] Test\n- [ ] \n- [ ] ');
    expect(describeClaudeCodeTool('TodoWrite', { todos: 'not a list' }, cwd, 'linux').preview.text).toBe('');
  });

  it('shows a subagent by its description and prompt', () => {
    const agent = describeClaudeCodeTool('Agent', { description: 'Survey', prompt: 'Look around' }, cwd, 'linux');
    expect(agent.preview).toEqual({ title: 'Subagent: Survey', text: 'Look around' });
    expect(describeClaudeCodeTool('Task', {}, cwd, 'linux').preview.title).toBe('Subagent: task');
  });

  it('shows an MCP tool or an unknown tool with its input as JSON', () => {
    const mcp = describeClaudeCodeTool('mcp__docs__search', { query: 'x', limit: 2 }, cwd, 'linux');
    expect(mcp).toMatchObject({
      preview: { title: 'mcp__docs__search', arguments: '{\n  "query": "x",\n  "limit": 2\n}' },
    });
    expect(mcp.showsOutput).toBe(false);
  });

  it('shows the plan of ExitPlanMode, or a default line', () => {
    expect(describeClaudeCodeTool('ExitPlanMode', { plan: '1. Do' }, cwd, 'linux').preview.text).toBe('1. Do');
    expect(describeClaudeCodeTool('ExitPlanMode', {}, cwd, 'linux').preview.text).toContain('ready to leave plan mode');
  });
});

describe('toolResultText', () => {
  it('returns a string as it is', () => {
    expect(toolResultText('out')).toBe('out');
  });

  it('joins the text blocks and leaves out images and other blocks', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'first' },
        { type: 'image', source: {} },
        { type: 'text', text: 'second' },
        { type: 'text' },
      ]),
    ).toBe('first\nsecond');
  });

  it('returns nothing for content of another shape', () => {
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText({ text: 'not a list' })).toBe('');
  });
});
