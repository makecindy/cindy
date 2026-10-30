/** Opt-in native MCP recovery check. No credentials or external requests. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { AppServerHost } from './app-server/host.js';
import { createStdioTransport } from './app-server/stdioTransport.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

it.skipIf(!binaryPath)('loads an authorized MCP on cold resume of the same thread', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-mcp-resume-'));
  let modelRequests = 0;
  let codeModeSawScheduler = false;
  const modelServer = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"models":[]}');
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { model: string; input?: unknown[] };
    const number = ++modelRequests;
    if (number === 3) codeModeSawScheduler = JSON.stringify(body.input).includes('SCHEDULER_PRESENT');
    const output = number === 2
      ? [{ type: 'custom_tool_call', name: 'exec', call_id: 'check-scheduler',
          input: 'text(["list_tools", "call_tool"].every(name => ALL_TOOLS.some(x => x.name === `mcp__cindy_scheduler__${name}`)) ? "SCHEDULER_PRESENT" : "SCHEDULER_MISSING")' }]
      : [{
          type: 'message', role: 'assistant', id: 'done', status: 'completed',
          content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
        }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: output[0] })}\n\n`);
    response.end(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_test', object: 'response', status: 'completed', model: body.model, output,
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    })}\n\n`);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const mcpPath = path.join(root, 'mcp.mjs');
  await fs.writeFile(mcpPath, `import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cindy_scheduler', version: '1' } };
  if (request.method === 'tools/list') result = { tools: [
    { name: 'list_tools', description: 'List scheduler tools', inputSchema: { type: 'object' } },
    { name: 'call_tool', description: 'Call scheduler tool', inputSchema: { type: 'object' } },
  ] };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}`);
  const host = new AppServerHost({
    logger,
    clientInfo: { name: 'cindy-mcp-resume-test', version: '1' },
    createTransport: () => createStdioTransport({
      binaryPath: binaryPath!, cwd: root,
      env: {
        PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, CODEX_HOME: root,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      extraArgs: [
        '-c', 'model_provider="probe"',
        '-c', 'model_providers.probe.name="Probe"',
        '-c', `model_providers.probe.base_url="http://127.0.0.1:${address.port}"`,
        '-c', 'model_providers.probe.wire_api="responses"',
        '-c', 'model_providers.probe.requires_openai_auth=false',
        '-c', `mcp_servers.cindy_scheduler.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.cindy_scheduler.args=[${JSON.stringify(mcpPath)}]`,
      ],
    }),
  });
  try {
    await host.ensureStarted();
    const started = await host.request<{ thread: { id: string } }>('thread/start', {
      cwd: root, model: 'gpt-5.6-luna', modelProvider: 'probe',
      config: { 'mcp_servers.cindy_scheduler.enabled': false },
    });
    const threadId = started.thread.id;
    const list = () => host.request<{ data: Array<{ name: string; tools: Record<string, unknown> }>; nextCursor: string | null }>(
      'mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100, cursor: null },
    );
    const before = await list();
    expect(before.data.some((server) => server.name === 'cindy_scheduler' && 'list_tools' in server.tools)).toBe(false);
    let complete = false;
    const subscription = host.subscribeThread(threadId, { turnCompleted: () => { complete = true; } });
    await host.request('turn/start', { threadId, input: [{ type: 'text', text: 'Say done.' }] });
    await expect.poll(() => complete, { timeout: 15_000 }).toBe(true);
    await host.request('thread/resume', {
      threadId, cwd: root, excludeTurns: true,
      model: 'gpt-5.6-luna', modelProvider: 'probe',
      config: { 'mcp_servers.cindy_scheduler.enabled': true },
    });
    const loaded = await list();
    expect(loaded.data.some((server) => server.name === 'cindy_scheduler' && 'list_tools' in server.tools)).toBe(false);
    await subscription.release();
    await host.request('thread/resume', {
      threadId, cwd: root, excludeTurns: true,
      model: 'gpt-5.6-luna', modelProvider: 'probe',
      config: { 'mcp_servers.cindy_scheduler.enabled': true },
    });
    const after = await list();
    expect(after.data.some((server) => server.name === 'cindy_scheduler' &&
      'list_tools' in server.tools && 'call_tool' in server.tools)).toBe(true);
    let secondComplete = false;
    const resumedSubscription = host.subscribeThread(threadId, { turnCompleted: () => { secondComplete = true; } });
    await host.request('turn/start', { threadId, input: [{ type: 'text', text: 'Check scheduler.' }] });
    await expect.poll(() => secondComplete, { timeout: 15_000 }).toBe(true);
    expect(modelRequests).toBe(3);
    expect(codeModeSawScheduler).toBe(true);
    await resumedSubscription.release();
  } finally {
    await host.retire('native MCP recovery test complete');
    await new Promise<void>((resolve) => { modelServer.close(() => resolve()); modelServer.closeAllConnections(); });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
