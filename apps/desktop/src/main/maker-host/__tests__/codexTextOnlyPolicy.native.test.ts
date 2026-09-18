import { WebSocketServer } from 'ws';
/** Opt-in native enforcement probe: isolated home, fake model, loopback only.
 * CINDY_CODEX_TEST_BINARY=<absolute path> vitest run <this file>
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createAnthropicCompatProxy, type ProxyHandle } from '@cindy/anthropic-compat-proxy';
import { selectedHeaderValue, STABLE_THREAD_ID_HEADERS } from '@cindy/model-compat';
import { AppServerHost } from '../../../../../../packages/maker-core/src/agents/codex/app-server/host';
import { createStdioTransport } from '../../../../../../packages/maker-core/src/agents/codex/app-server/stdioTransport';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger';
import { codexTextOnlyRequestGuard, codexTextOnlyWebSocketTransforms, isCodexTextOnly, registerCodexTextOnlyPolicy } from '../codex-text-only-policy';

const binary = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
it.skipIf(!binary).each([false, true])('native full-access welcome refuses rogue tools and restores ordinary execution without reconfiguration (WebSocket=%s)', async websocket => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-text-only-native-'));
  const sentinel = path.join(root, 'tool-executed');
  let disabled = true;
  const observed: Array<{ tools: unknown[]; tool_choice?: unknown }> = [];
  const modelOutput = (body: { input: Array<{ type?: string }>; model: string; tools: unknown[] }) => {
    observed.push(body);
    const hasResult = body.input.some(item => item.type === 'function_call_output');
    const output = hasResult ? [{ type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }]
      : [{ type: 'function_call', id: 'fc', name: 'exec_command', call_id: 'call', arguments: JSON.stringify({ cmd: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('tool-executed','yes')"` }) }];
    return [...output.map(item => ({ type: 'response.output_item.done', output_index: 0, item })),
      { type: 'response.completed', response: { id: 'resp', object: 'response', status: 'completed', model: body.model, output, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }];
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{"models":[]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of modelOutput(JSON.parse(raw))) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  let upgrades = 0;
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => {
    upgrades++;
    socket.on('message', bytes => {
      for (const event of modelOutput(JSON.parse(bytes.toString()))) socket.send(JSON.stringify(event));
    });
  });
  let proxy: ProxyHandle | undefined; let host: AppServerHost | undefined; let unregister: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    proxy = await createAnthropicCompatProxy({ upstream, transformRequest: [],
      requestGuard: ctx => codexTextOnlyRequestGuard(isCodexTextOnly(selectedHeaderValue(ctx.headers, STABLE_THREAD_ID_HEADERS) ?? ''), ctx),
      resolveWebSocketUpstream: () => upstream,
      webSocketTransforms: ctx => codexTextOnlyWebSocketTransforms(() => isCodexTextOnly(selectedHeaderValue(ctx.headers, STABLE_THREAD_ID_HEADERS) ?? '')),
    });
    host = new AppServerHost({ logger, clientInfo: { name: 'cindy-native-text-only', version: '1' },
      createTransport: () => createStdioTransport({ binaryPath: binary!, cwd: root,
        env: { PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, CODEX_HOME: root,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        extraArgs: ['-c', 'model_provider="probe"', '-c', 'model_providers.probe.name="Probe"',
          '-c', `model_providers.probe.base_url=${JSON.stringify(proxy!.url)}`, '-c', 'model_providers.probe.wire_api="responses"',
          '-c', 'model_providers.probe.requires_openai_auth=false', '-c', 'model_providers.probe.request_max_retries=0',
          '-c', 'model_providers.probe.stream_max_retries=0', '-c', `model_providers.probe.supports_websockets=${websocket}`],
      }),
    });
    await host.ensureStarted();
    const { thread } = await host.request<{ thread: { id: string } }>('thread/start', {
      cwd: root, model: 'gpt-5.4', modelProvider: 'probe', ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access',
    });
    unregister = registerCodexTextOnlyPolicy(thread.id, () => disabled);
    let done = 0;
    const subscription = host.subscribeThread(thread.id, { turnCompleted: () => { done++; } });
    try {
      await host.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Say hello.' }] });
      await expect.poll(() => done, { timeout: 20000 }).toBe(1);
      expect(observed.length).toBeGreaterThan(0);
      for (const body of observed) { expect(body.tools).toEqual([]); expect(body.tool_choice).toBe('none'); }
      await expect(fs.stat(sentinel)).rejects.toThrow();
      observed.length = 0; disabled = false;
      await host.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run the requested command.' }] });
      await expect.poll(() => done, { timeout: 20000 }).toBe(2);
      expect(observed[0]!.tools.length).toBeGreaterThan(0);
      expect(await fs.readFile(sentinel, 'utf8')).toBe('yes');
      if (websocket) expect(upgrades).toBeGreaterThan(0);
    } finally { await subscription.release(); }
  } finally {
    unregister?.(); await host?.retire('text-only probe completed'); await proxy?.dispose();
    for (const client of sockets.clients) client.terminate(); sockets.close();
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45000);
