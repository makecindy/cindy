/** #10499: real Agent + native MCP startup, isolated homes and loopback model.
 * Existing MCP tests inspect catalogs, but do not check task-visible errors.
 * Minimal failure: helper exits before initialize while docs remains healthy.
 * Opt-in native tier keeps real processes/sockets out of default unit tests.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { CodexAgent } from './index.js';
import { AppServerHost } from './app-server/host.js';
import { createStdioTransport } from './app-server/stdioTransport.js';
import type { AgentDeps, AgentSessionHandle } from '../base-agent.js';
import type { AgentEvent } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

it.skipIf(!binaryPath)('reports failed expected helper and preserves healthy/disabled native turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-helper-readiness-'));
  let modelCalls = 0;
  const modelServer = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"models":[]}');
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { model: string };
    modelCalls++;
    const item = { type: 'message', role: 'assistant', id: 'done', status: 'completed',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'resp', object: 'response', status: 'completed', model: body.model, output: [item],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    } })}\n\n`);
  });
  try {
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
    const address = modelServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    const script = path.join(root, 'mcp.mjs');
    await fs.writeFile(script, `import { createInterface } from 'node:readline';
if (process.argv[2] === 'fail') process.exit(42);
for await (const line of createInterface({ input: process.stdin })) {
  const q = JSON.parse(line);
  if (q.id === undefined) continue;
  let result = {};
  if (q.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } };
  if (q.method === 'tools/list') result = { tools: ['list_tools', 'call_tool'].map(name => ({ name, description: 'Synthetic tool', inputSchema: { type: 'object', properties: {} } })) };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
}`);
    for (const mode of ['failed', 'healthy', 'disabled'] as const) {
      const home = path.join(root, mode);
      await fs.mkdir(home);
      const host = new AppServerHost({
        logger, clientInfo: { name: 'cindy-helper-readiness-test', version: '1' },
        buildSessionMcpConfig: () => ({
          'mcp_servers.cindy_helper.command': process.execPath,
          'mcp_servers.cindy_helper.args': [script, mode === 'healthy' ? 'healthy' : 'fail'],
          'mcp_servers.cindy_helper.enabled': mode !== 'disabled',
        }),
        createTransport: () => createStdioTransport({
          binaryPath: binaryPath!, cwd: root,
          env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, CODEX_HOME: home,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
          extraArgs: [
            '-c', 'model_provider="probe"', '-c', 'model_providers.probe.name="Probe"',
            '-c', `model_providers.probe.base_url="http://127.0.0.1:${address.port}"`,
            '-c', 'model_providers.probe.wire_api="responses"', '-c', 'model_providers.probe.requires_openai_auth=false',
            '-c', `mcp_servers.cindy_docs.command=${JSON.stringify(process.execPath)}`,
            '-c', `mcp_servers.cindy_docs.args=${JSON.stringify([script, 'healthy'])}`,
          ],
        }),
      });
      const agent = new CodexAgent({
        auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}),
          triggerLogin: async () => ({ authenticated: true }), logout: async () => {} },
        runtimeConfig: {}, binaryPath: process.execPath, logger,
      } satisfies AgentDeps);
      // Only host construction is injected: Agent, host, native stdio and events are real.
      Object.defineProperty(agent, 'getHost', { value: async () => {
        (agent as unknown as { hosts: Map<string, AppServerHost> }).hosts.set('local', host);
        return host;
      } });
      let handle: AgentSessionHandle | undefined;
      try {
        handle = await agent.startSession({ sessionId: `helper-${mode}`, sessionInstanceId: `instance-${mode}`,
          workingDir: root, model: 'gpt-5.6-luna' });
        const events: AgentEvent[] = [];
        const consume = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'Return Done.' });
        await consume;
        expect((await handle.readMcpServerTools?.('cindy_docs'))?.state).toBe('connected');
        const errors = events.filter(event => event.type === 'error');
        expect(errors).toHaveLength(mode === 'failed' ? 1 : 0);
        if (mode === 'failed') {
          expect(errors[0].data).toMatchObject({ message: expect.stringContaining('cindy_helper is enabled but unavailable'), isTerminal: false });
          expect(events.findIndex(event => event.type === 'error')).toBeLessThan(events.findIndex(event => event.type === 'text'));
        }
        expect(events.filter(event => event.standaloneText)).toHaveLength(mode === 'failed' ? 1 : 0);
        expect(events.filter(event => event.type === 'text' && !event.standaloneText)
          .some(event => (event.data as { text?: string }).text === 'Done.')).toBe(true);
        expect(events.some(event => event.type === 'done')).toBe(true);
      } finally {
        await handle?.close();
        await agent.dispose();
        await host.retire('helper readiness test cleanup');
      }
    }
    expect(modelCalls).toBe(3);
  } finally {
    await new Promise<void>(resolve => { modelServer.close(() => resolve()); modelServer.closeAllConnections(); });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
