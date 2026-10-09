// Checks that a packaged build works: `node scripts/smoke-packaged.mjs <app executable> [args...]`.
// It starts the app on a throwaway profile with Chromium's remote debugging (the packaged app's fuses turn off the
// Node inspector Playwright's Electron support needs), opens a project, lists its files and runs a command in the
// terminal panel, which loads node-pty. It also connects a stdio and an HTTP MCP server: the MCP SDK client is
// bundled into the main process (it is a dev dependency), so only a packaged app shows that nothing it needs is
// missing. Last, it chats with a local stand-in for the Claude API and approves a file edit from its card. Exits
// non-zero, with what it saw, when anything fails.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { chromium } from 'playwright-core';
import { z } from 'zod';

const [executable, ...extraArgs] = process.argv.slice(2);
if (!executable) {
  console.error('Usage: node scripts/smoke-packaged.mjs <app executable> [args...]');
  process.exit(2);
}
const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'patch-smoke-profile-'));
const project = mkdtempSync(join(tmpdir(), 'patch-smoke-project-'));
writeFileSync(join(project, 'hello.txt'), 'hello\n');

// A stateless streamable HTTP MCP server: a fresh server and transport for each request.
const mcpHttp = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  const server = new McpServer({ name: 'smoke-http', version: '1.0.0' });
  server.registerTool('shout', { description: 'Upper-cases text.', inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: 'text', text: text.toUpperCase() }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});
await new Promise((resolve) => mcpHttp.listen(0, '127.0.0.1', resolve));

// A stand-in for the Claude API, reached through the custom base URL setting (a packaged app ignores the test
// hooks). The first turn asks to write approved.txt; after the tool result it answers. Titles get a fixed answer.
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events)
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.end();
};
const message = (stop, block, delta) => [
  [
    'message_start',
    {
      message: {
        id: 'msg_smoke',
        type: 'message',
        role: 'assistant',
        model: 'claude-smoke',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ],
  ['content_block_start', { index: 0, content_block: block }],
  ['content_block_delta', { index: 0, delta }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }],
  ['message_stop', {}],
];
let turns = 0;
const claude = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        id: 'msg_title',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: '{"title":"Smoke test"}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  }
  turns++;
  if (turns === 1)
    return sse(
      res,
      message(
        'tool_use',
        { type: 'tool_use', id: 'toolu_smoke', name: 'write_file', input: {} },
        { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'approved.txt', content: 'APPROVED\n' }) },
      ),
    );
  sse(res, message('end_turn', { type: 'text', text: '' }, { type: 'text_delta', text: 'Written after approval.' }));
});
await new Promise((resolve) => claude.listen(0, '127.0.0.1', resolve));
// Written before the start, as a saved profile: adding servers through settings:update would ask for confirmation.
const mockStdioServer = fileURLToPath(new URL('../tests/e2e/mock_mcp_server.mjs', import.meta.url));
writeFileSync(
  join(profile, 'settings.json'),
  JSON.stringify({
    settings: {
      mcpServers: [
        { name: 'stdio', transport: 'stdio', command: process.execPath, args: [mockStdioServer] },
        { name: 'http', transport: 'http', url: `http://127.0.0.1:${mcpHttp.address().port}/mcp` },
      ],
      anthropicBaseUrl: `http://127.0.0.1:${claude.address().port}`,
      approvalMode: 'ask',
    },
    secrets: { anthropicApiKey: 'plain:sk-ant-smoke' },
  }),
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(executable, [...extraArgs, `--remote-debugging-port=${port}`], {
  // The terminal's native confirmation (#157) cannot be clicked from here; this answers it in advance.
  env: { ...process.env, PATCH_USER_DATA: profile, PATCH_TERMINAL_CONFIRMED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  // Its own process group, so the whole app can be stopped at the end.
  detached: true,
});
let output = '';
child.stdout.on('data', (data) => (output += data));
child.stderr.on('data', (data) => (output += data));
let exited = null;
child.on('exit', (code, signal) => (exited = { code, signal }));

const seen = {};
let failure = null;
const deadline = setTimeout(() => {
  failure ??= 'Timed out after 120 s.';
  finish();
}, 120_000);

try {
  let browser;
  for (let attempt = 0; attempt < 120 && !browser; attempt++) {
    if (exited) throw new Error(`The app exited at start: ${JSON.stringify(exited)}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    } catch {
      await delay(500);
    }
  }
  if (!browser) throw new Error('Could not connect to the app.');
  let page;
  for (let attempt = 0; attempt < 80 && !page; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().endsWith('/renderer/index.html'));
    if (!page) await delay(250);
  }
  if (!page) throw new Error('The app window did not load its page.');
  page.setDefaultTimeout(20_000);
  await page.waitForLoadState('domcontentloaded');
  seen.title = await page.title();
  seen.info = await page.evaluate(() => window.api.invoke('app:info'));
  if (seen.info.version !== expectedVersion)
    throw new Error(`Version ${seen.info.version}, expected ${expectedVersion}.`);

  await page.evaluate((path) => window.api.invoke('project:open', path), project);
  seen.files = await page.evaluate(() => window.api.invoke('files:list'));
  if (!seen.files.includes('hello.txt')) throw new Error('The project files were not listed.');

  await page.evaluate(() => {
    window.__smokeTerminal = '';
    window.api.on('terminal:data', (data) => (window.__smokeTerminal += data));
  });
  await page.evaluate(() => window.api.invoke('terminal:start', 80, 24));
  await page.evaluate(() => window.api.invoke('terminal:write', 'echo SMOKE-$((6*7))\r'));
  await page.waitForFunction(() => window.__smokeTerminal.includes('SMOKE-42'));
  seen.terminal = 'ran a command';

  let mcp = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    mcp = await page.evaluate(() => window.api.invoke('mcp:status'));
    if (mcp.length === 2 && mcp.every((server) => server.state !== 'connecting')) break;
    await delay(250);
  }
  seen.mcp = mcp.map(({ name, state, error, tools }) => ({ name, state, error, tools }));
  if (mcp.length !== 2 || !mcp.every((server) => server.state === 'connected' && server.tools.length > 0))
    throw new Error('The MCP servers did not connect.');

  // A chat that edits a file, approved by clicking the card, as a user would.
  await page.getByLabel('Message').fill('Write approved.txt');
  await page.getByLabel('Message').press('Enter');
  const card = page.locator('.tool-card.awaiting');
  await card.waitFor();
  if (existsSync(join(project, 'approved.txt'))) throw new Error('The edit ran before it was approved.');
  await card.getByRole('button', { name: 'Approve' }).click();
  await page.getByText('Written after approval.', { exact: true }).waitFor();
  if (readFileSync(join(project, 'approved.txt'), 'utf8') !== 'APPROVED\n')
    throw new Error('The approved edit did not write the file.');
  seen.approval = 'approved an edit';

  // The AppImage launcher drops Chromium's sandbox where user namespaces are restricted (#22); the app then logs it
  // and shows a notice. A build that should keep the sandbox fails here.
  let log = '';
  try {
    log = readFileSync(join(profile, 'logs', 'app.log.jsonl'), 'utf8');
  } catch {
    // No problem was logged.
  }
  seen.chromiumSandbox = log.includes('Chromium sandbox is off') ? 'off' : 'on';
  if (seen.chromiumSandbox === 'off' && process.env.SMOKE_ALLOW_NO_SANDBOX !== '1')
    throw new Error("Chromium's sandbox is off (the app was started with --no-sandbox).");
  await page.screenshot({ path: process.env.SMOKE_SCREENSHOT || join(tmpdir(), 'patch-smoke.png') });
  await browser.close();
} catch (error) {
  failure ??= error instanceof Error ? error.message : String(error);
}
await finish();

async function finish() {
  clearTimeout(deadline);
  mcpHttp.close();
  claude.close();
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
  console.log(JSON.stringify(seen, null, 2));
  if (failure) {
    console.error(`Smoke test failed: ${failure}`);
    console.error(`App output:\n${output.slice(-4000) || '(none)'}`);
  } else {
    console.log('Smoke test passed.');
  }
  // The app writes to its profile while it quits.
  for (let waited = 0; !exited && waited < 10_000; waited += 250) await delay(250);
  for (const folder of [project, profile]) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A leftover temp folder is not a failure of the app.
    }
  }
  process.exit(failure ? 1 : 0);
}
