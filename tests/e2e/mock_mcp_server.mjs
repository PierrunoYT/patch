// A minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC), used by the unit and end-to-end
// tests to exercise the real client code without any external service. Offers one tool: echo.
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'echo',
    description: 'Echoes the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];
// MOCK_MCP_PROBE=1 adds a tool that reports what the server process can reach, for the sandbox tests (#87).
if (process.env.MOCK_MCP_PROBE)
  tools.push({
    name: 'probe',
    description: 'Reads or writes a file, or connects to host:port, and reports the outcome.',
    inputSchema: { type: 'object', properties: { action: { type: 'string' }, target: { type: 'string' } } },
  });

function probe({ action, target }) {
  // Reports one of the server's environment variables, to check which project a ${project} server was started for.
  if (action === 'env') return Promise.resolve(`env:${process.env[target] ?? ''}`);
  if (action === 'connect') {
    const [host, port] = target.split(':');
    return new Promise((resolve) => {
      const socket = connect({ host, port: Number(port), timeout: 2000 });
      socket.once('connect', () => (socket.destroy(), resolve('connected')));
      socket.once('error', (error) => (socket.destroy(), resolve(error.code)));
      socket.once('timeout', () => (socket.destroy(), resolve('ETIMEDOUT')));
    });
  }
  try {
    if (action === 'read') return Promise.resolve(`content:${readFileSync(target, 'utf8')}`);
    writeFileSync(target, 'WRITTEN-BY-MCP');
    return Promise.resolve('written');
  } catch (error) {
    return Promise.resolve(error.code);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // a notification needs no answer
  if (message.method === 'initialize') {
    // Lets a test see how the client introduced itself.
    if (process.env.MOCK_MCP_CLIENT_FILE)
      writeFileSync(process.env.MOCK_MCP_CLIENT_FILE, JSON.stringify(message.params.clientInfo));
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  } else if (message.method === 'tools/call' && message.params.name === 'probe') {
    void probe(message.params.arguments).then((text) =>
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }),
    );
  } else if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: `echo:${message.params.arguments.text}` }] },
    });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
