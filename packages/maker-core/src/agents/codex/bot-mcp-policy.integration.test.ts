import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CodexAgent } from './index.js';
import type { AgentSessionHandle, AgentMcpServerToolsReport } from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';

// Integration tier: real native process and loopback MCP/Responses fixtures, no account.
// Units cannot prove that Codex accepts the feature-only Apps restriction or that
// the thread actually exposes only the selected external transport.
const binaryPath = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

it.skipIf(!binaryPath).each([
  { external: false, collision: false }, { external: true, collision: false }, { external: false, collision: true },
])('enforces Bot MCP selection in a real native thread ($external, collision=$collision)', async ({ external, collision }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-bot-mcp-native-'));
  const home = path.join(root, 'codex');
  const workingDir = path.join(root, 'work');
  await mkdir(home);
  await mkdir(workingDir);
  const requests: Record<string, unknown>[] = [];
  let activeHandle: AgentSessionHandle | undefined;
  let duringToolReport: AgentMcpServerToolsReport | null | undefined;
  let duringToolError: unknown;
  let collisionConnections = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/collision') collisionConnections += 1;
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const message = JSON.parse(body);
    if (req.url === '/responses') {
      requests.push(message);
      const item = requests.length === 1
        ? { type: 'custom_tool_call', id: 'fc', call_id: 'call', name: 'exec', input: 'text(await tools.mcp__cindy_helper__routine_list({}));' }
        : { type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: 'fixture complete' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end([
        { type: 'response.created', response: { id: 'resp' } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: 'resp', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === 'tools/call') {
      try { duringToolReport = await activeHandle?.readMcpServerTools?.('fixture_external'); }
      catch (error) { duringToolError = error; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'local read complete' }] } }));
      return;
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: req.url === '/helper' ? 'routine_list' : 'external_echo', description: 'Read-only local fixture', inputSchema: { type: 'object', properties: {} } }] }
        : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  let agent: CodexAgent | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agent = new CodexAgent({
      binaryPath: binaryPath!, logger, runtimeConfig: {},
      prepareCodexExtraSpawnConfig: async () => ({ extraArgs: [
        '-c', 'model_provider="fixture"',
        '-c', `model_providers.fixture={name="Local validation",base_url="${endpoint}",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
        '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
        '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
        '-c', 'mcp_servers.cindy_memory={command="false",enabled=false}',
        '-c', `mcp_servers.cindy_helper={url="${endpoint}/helper"}`,
        '-c', `mcp_servers.fixture_external={url="${endpoint}/external"}`,
        ...(collision ? ['-c', `mcp_servers.codex_apps={url="${endpoint}/collision"}`] : []),
      ], extraEnv: {} }),
      auth: {
        getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
        getAuthEnv: async () => ({ HOME: root, USERPROFILE: root, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '', NO_PROXY: '127.0.0.1,localhost' }),
      },
    });
    const handle = await agent.startSession({
      sessionId: `mcp-fixture-${external}`, model: 'gpt-6-astra', workingDir,
      permissionMode: 'bypassPermissions', makerMemoryEnabled: false,
      botProfilePrompt: 'You are a test teammate inside Cindy.',
      botRuntimeProfile: {
        botId: 'fixture', profileVersion: 1,
        skillPolicy: { mode: 'allowlist', configured: [], catalog: [] },
        toolsetPolicy: { mode: 'allowlist', configured: [], catalog: [] },
        mcpPolicy: { mode: 'allowlist', configured: external ? ['fixture_external', 'codex_apps'] : [], catalog: [
          { name: 'cindy_helper', source: 'builtin' },
          { name: 'fixture_external', source: 'custom' },
          { name: 'codex_apps', source: 'harness' },
        ] },
      },
    });
    activeHandle = handle;
    try {
      const events = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await handle.send({ type: 'user', content: 'Inspect the available tools; do not create automation.' }, { throwOnStartFailure: true });
            await events;
          })(),
          new Promise<never>((_, reject) => {
            // real-wait: native process failure deadline; cleanup must run before Vitest times out.
            timer = setTimeout(() => reject(new Error('Native fixture turn timed out')), 20_000);
          }),
        ]);
      } finally { clearTimeout(timer); }
      expect(requests).toHaveLength(2);
      expect(duringToolError).toBeUndefined();
      expect(duringToolReport?.tools.map(tool => tool.name)).toEqual(external ? ['external_echo'] : []);
      expect(await handle.readMcpServerTools?.('cindy_helper')).toMatchObject({ state: 'connected', tools: [{ name: 'routine_list' }] });
      const report = await handle.readMcpServerTools?.('fixture_external');
      if (external) expect(report).toMatchObject({ state: 'connected', tools: [{ name: 'external_echo' }] });
      else expect(report?.tools).toEqual([]);
      if (collision) {
        expect((await handle.readMcpServerTools?.('codex_apps'))?.tools).toEqual([]);
        expect(collisionConnections).toBe(0);
      }
    } finally { await handle.close(); }
  } finally {
    await agent?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
