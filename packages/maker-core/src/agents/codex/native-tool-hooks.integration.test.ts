import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../interfaces/logger.js';
import { AppServerClient } from './app-server/client.js';
import { createStdioTransport } from './app-server/stdioTransport.js';
import { codexToolHookConfig } from './native-tool-hooks.js';

// Test value: native session config -> observable hook execution and tool denial.
// plugin-security-and-authoring §3: native trust and Agent cancellation must hold.
// Existing mock-transport tests do not run native hook discovery/MCP/permission parsing.
// Minimal input: one fake Responses tool call and one trusted/untrusted MCP handler.
// Integration tier: real subprocess and loopback HTTP; explicit binary, no user credentials.
const binary = process.env.CINDY_CODEX_HOOKS_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const defer = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe.skipIf(!binary)('Codex native tool hook boundary', () => {
  const cleanups: Array<() => Promise<unknown> | void> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  it.each(['trusted', 'untrusted', 'disabled', 'deny', 'rewrite', 'error', 'cancel'] as const)('%s', async mode => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-native-hooks-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    await mkdir(home); await mkdir(work);
    const calls: Array<Record<string, unknown>> = [];
    const hookStatuses: string[] = [];
    const modelInputs: Array<Array<Record<string, unknown>>> = [];
    const entered = defer<void>();
    const completed = defer<{ status: string }>();
    let pending: ServerResponse | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (req.url === '/mcp') {
        if (body.id === undefined) { res.writeHead(202).end(); return; }
        let result: unknown = {};
        if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } };
        if (body.method === 'tools/list') result = { tools: [{ name: 'hook', description: 'Hook probe', inputSchema: { type: 'object', additionalProperties: true } }] };
        if (body.method === 'tools/call') {
          const args = body.params.arguments.args;
          calls.push(args); entered.resolve();
          if (mode === 'cancel') { pending = res; return; }
          const output = mode === 'deny' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'probe denied' } }
            : mode === 'rewrite' && args.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'printf hook-rewritten' } } } : {};
          result = { content: [{ type: 'text', text: mode === 'error' ? 'probe failure' : JSON.stringify(output) }], isError: mode === 'error' };
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
      modelInputs.push(body.input);
      const done = body.input.some((item: Record<string, unknown>) => item.type === 'function_call_output');
      const item = done ? { type: 'message', role: 'assistant', id: 'probe-answer', content: [{ type: 'output_text', text: 'done' }] }
        : { type: 'function_call', call_id: 'probe-call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf probe-ok' }) };
      const events = [{ type: 'response.created', response: { id: 'probe-response' } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: 'probe-response', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { pending?.destroy(); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(path.join(home, 'config.toml'), `model="probe-model"\nmodel_provider="probe"\n[model_providers.probe]\nname="Probe"\nbase_url="${url}/v1"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n[mcp_servers.probe]\nurl="${url}/mcp"\n`);
    const client = new AppServerClient({ logger, createTransport: () => createStdioTransport({
      binaryPath: binary!, cwd: work, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'fake-probe-key' },
    }) });
    cleanups.push(() => client.close());
    client.onNotification('turn/completed', params => { completed.resolve((params as { turn: { status: string } }).turn); });
    client.onNotification('hook/completed', params => { hookStatuses.push((params as { run: { status: string } }).run.status); });
    client.start();
    await client.initialize({ name: 'cindy-native-hook-test', version: '1' }, { experimentalApi: true });
    const config: Record<string, unknown> = { ...codexToolHookConfig('probe', 'hook', 2), 'features.code_mode': false };
    if (mode === 'untrusted') delete config['hooks.state'];
    if (mode === 'disabled') for (const state of Object.values(config['hooks.state'] as Record<string, Record<string, unknown>>)) state.enabled = false;
    const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: work, model: 'probe-model', modelProvider: 'probe', sandbox: 'read-only', approvalPolicy: 'never', config });
    const listing = await client.request<{ data: Array<{ hooks: Array<{ trustStatus: string; enabled: boolean }> }> }>('hooks/list', { threadId: thread.thread.id });
    expect(listing.data[0].hooks).toHaveLength(2);
    for (const hook of listing.data[0].hooks) {
      expect(hook.trustStatus).toBe(mode === 'untrusted' ? 'untrusted' : 'trusted');
      expect(hook.enabled).toBe(mode !== 'disabled');
    }
    const turn = await client.request<{ turn: { id: string } }>('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'probe' }] });
    if (mode === 'cancel') {
      await entered.promise;
      await client.request('turn/interrupt', { threadId: thread.thread.id, turnId: turn.turn.id });
    }
    expect((await completed.promise).status).toBe(mode === 'cancel' ? 'interrupted' : 'completed');
    expect(calls).toHaveLength(mode === 'untrusted' || mode === 'disabled' ? 0 : mode === 'deny' || mode === 'cancel' ? 1 : 2);
    if (calls.length) expect(calls[0]).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf probe-ok' }, tool_use_id: 'probe-call' });
    if (mode === 'trusted') expect(calls[1]).toHaveProperty('tool_response');
    if (mode === 'rewrite') expect(JSON.stringify(modelInputs.at(-1))).toContain('hook-rewritten');
    if (mode === 'deny') {
      expect(hookStatuses).toContain('blocked');
      expect(JSON.stringify(modelInputs.at(-1))).toContain('probe denied');
      expect(JSON.stringify(modelInputs.at(-1))).not.toContain('probe-ok\n');
    }
    if (mode === 'error') expect(hookStatuses).toEqual(['failed', 'failed']);
  }, 15_000);
});
