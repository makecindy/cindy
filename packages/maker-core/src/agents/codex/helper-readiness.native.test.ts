/** #10499: real Agent + native MCP startup, isolated homes and loopback model.
 * Existing MCP tests inspect catalogs, but do not check task-visible errors.
 * Minimal failure: helper exits before initialize while docs remains healthy.
 * Opt-in native tier keeps real processes/sockets out of default unit tests.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { CodexAgent } from './index.js';
import { AppServerHost } from './app-server/host.js';
import { createStdioTransport } from './app-server/stdioTransport.js';
import type { AgentDeps, AgentSessionHandle } from '../base-agent.js';
import type { AgentEvent } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

async function stopWindowsFixtureTree(pid?: number): Promise<void> {
  if (process.platform !== 'win32' || !pid) return;
  // Only the PID this fixture created. Native MCP/code-mode descendants can
  // retain the fixture cwd after app-server exits on Windows.
  await promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F']).catch(error => {
    // A child may exit between taskkill's enumeration and termination. Accept
    // that race only when the fixture's root is now confirmed gone.
    try { process.kill(pid, 0); } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    throw error;
  });
}

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
      let nativePid: number | undefined;
      const host = new AppServerHost({
        logger, clientInfo: { name: 'cindy-helper-readiness-test', version: '1' },
        buildSessionMcpConfig: () => ({
          'mcp_servers.cindy_helper.command': process.execPath,
          'mcp_servers.cindy_helper.args': [script, mode === 'healthy' ? 'healthy' : 'fail'],
          'mcp_servers.cindy_helper.enabled': mode !== 'disabled',
        }),
        createTransport: () => createStdioTransport({
          binaryPath: binaryPath!, cwd: root,
          onProcessSpawned: pid => { nativePid = pid; return () => { nativePid = undefined; }; },
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
        try { await handle?.close(); }
        finally {
          await stopWindowsFixtureTree(nativePid);
          await agent.dispose();
          await host.retire('helper readiness test cleanup');
        }
      }
    }
    expect(modelCalls).toBe(3);
  } finally {
    await new Promise<void>(resolve => { modelServer.close(() => resolve()); modelServer.closeAllConnections(); });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);

// Supplier triage 2026-11-18: startup deadlines permanently removed helper from
// subsequent turns. #10499 only checks the warning, not recovery or real calls.
// Integration/native tier: real Agent -> host -> native HTTP MCP -> read-only
// call. Minimal failure is one stalled initialize/tools/list, then a healthy URL.
it.skipIf(!binaryPath).each(['initialize', 'tools/list'] as const)(
  'recovers a timed-out %s helper in the same task without retiring a healthy peer', async (failedMethod) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-helper-recovery-'));
    let healthy = false;
    let helperCalls = 0;
    let helperInitializes = 0;
    let docsInitializes = 0;
    let modelCalls = 0;
    let toolResultSeen = false;
    let attemptedRead = false;
    let historyPreserved = false;
    const models = new Set<string>();
    let nativePid: number | undefined;
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const q = JSON.parse(raw);
      if (req.url === '/model/responses') {
        modelCalls++;
        models.add(q.model);
        if (healthy && JSON.stringify(q.input).includes('READ_ONLY_HELPER_OK')) toolResultSeen = true;
        const requestRead = healthy && !attemptedRead && JSON.stringify(q.input).includes('recover helper');
        if (requestRead) historyPreserved = JSON.stringify(q.input).includes('first turn before recovery');
        if (requestRead) attemptedRead = true;
        const output = requestRead
          ? [{ type: 'custom_tool_call', name: 'exec', call_id: 'read-helper', input:
            'const tool = ALL_TOOLS.find(t => t.name === "mcp__cindy_helper__list_tools"); if (!tool) throw new Error("HELPER_MISSING"); text(await tools[tool.name]({}));' }]
          : [{ type: 'message', role: 'assistant', id: `done-${modelCalls}`, status: 'completed',
            content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: output[0] })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
          id: `resp-${modelCalls}`, object: 'response', status: 'completed', model: q.model, output,
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        } })}\n\n`);
        return;
      }
      const helper = req.url === '/helper';
      if (q.method === 'initialize') { if (helper) helperInitializes++; else docsInitializes++; }
      if (helper && !healthy && q.method === failedMethod) return; // Native deadline, not a synthetic host error.
      if (q.id === undefined) { res.writeHead(202); res.end(); return; }
      let result = {};
      if (q.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } };
      if (q.method === 'tools/list') result = { tools: ['list_tools', 'call_tool'].map(name => ({ name, description: 'Read-only probe', inputSchema: { type: 'object', properties: {} } })) };
      if (q.method === 'tools/call') { if (helper) helperCalls++; result = { content: [{ type: 'text', text: 'READ_ONLY_HELPER_OK' }] }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
    });
    let host: AppServerHost | undefined;
    let agent: CodexAgent | undefined;
    const handles: AgentSessionHandle[] = [];
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      const endpoint = `http://127.0.0.1:${address.port}`;
      host = new AppServerHost({
        logger, clientInfo: { name: 'cindy-helper-recovery-test', version: '1' },
        buildSessionMcpConfig: instance => ({
          'mcp_servers.cindy_helper.url': `${endpoint}/helper`,
          'mcp_servers.cindy_helper.enabled': instance !== 'peer',
          'mcp_servers.cindy_helper.startup_timeout_sec': 0.25,
          'mcp_servers.cindy_docs.url': `${endpoint}/docs`,
        }),
        createTransport: () => createStdioTransport({ binaryPath: binaryPath!, cwd: root,
          onProcessSpawned: pid => { nativePid = pid; return () => { nativePid = undefined; }; },
          env: { PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, CODEX_HOME: root,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
          extraArgs: ['-c', 'model_provider="probe"', '-c', 'model_providers.probe.name="Probe"',
            '-c', `model_providers.probe.base_url="${endpoint}/model"`, '-c', 'model_providers.probe.wire_api="responses"',
            '-c', 'model_providers.probe.requires_openai_auth=false'],
        }),
      });
      const resumes = vi.spyOn(host, 'request');
      const unsubscribes = vi.spyOn(host, 'unsubscribeThread');
      agent = new CodexAgent({ auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {} }, runtimeConfig: {}, binaryPath: process.execPath, logger });
      const nativeHost = host;
      Object.defineProperty(agent, 'getHost', { value: async () => {
        (agent as unknown as { hosts: Map<string, AppServerHost> }).hosts.set('local', nativeHost);
        return nativeHost;
      } });
      const run = async (handle: AgentSessionHandle, content: string) => {
        const events: AgentEvent[] = [];
        const consume = (async () => { for await (const event of handle.events()) { events.push(event); if (event.type === 'done') break; } })();
        await handle.send({ type: 'user', content });
        await consume;
        return events;
      };
      const peer = await agent.startSession({ sessionId: 'healthy-peer', sessionInstanceId: 'peer', workingDir: root, model: 'gpt-5.6-luna', permissionMode: 'bypassPermissions' });
      handles.push(peer);
      const handle = await agent.startSession({ sessionId: 'recovering-task', sessionInstanceId: 'recovering', workingDir: root, model: 'gpt-5.6-luna', permissionMode: 'bypassPermissions' });
      handles.push(handle);
      const originalId = handle.id;
      await run(handle, 'first turn before recovery');
      expect((await handle.readMcpServerTools?.('cindy_helper'))?.tools).toHaveLength(0);
      healthy = true;
      const recovered = await run(handle, 'recover helper with a read-only call');
      expect(handle.id).toBe(originalId);
      expect((await handle.readMcpServerTools?.('cindy_helper'))?.state).toBe('connected');
      expect(helperCalls).toBe(1);
      expect(toolResultSeen).toBe(true);
      expect(historyPreserved).toBe(true);
      expect([...models]).toEqual(['gpt-5.6-luna']);
      expect(helperInitializes).toBeGreaterThan(1);
      expect(resumes.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1);
      expect(unsubscribes.mock.calls.map(([id]) => id)).toEqual([originalId]);
      expect(recovered.some(event => event.type === 'error')).toBe(false);
      expect(host.activeSubscriptions).toBe(2);
      expect((await handle.readMcpServerTools?.('cindy_docs'))?.state).toBe('connected');
      const docsBeforePeer = docsInitializes;
      await run(peer, 'healthy peer continues');
      expect(docsInitializes).toBe(docsBeforePeer);
      expect((await peer.readMcpServerTools?.('cindy_docs'))?.state).toBe('connected');
    } finally {
      try { for (const handle of handles) await handle.close(); }
      finally {
        await stopWindowsFixtureTree(nativePid);
        await agent?.dispose();
        await host?.retire('helper recovery fixture complete');
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }, 30_000,
);
