/** #11061: unit notifications cannot prove native retries actually stop.
 * Real CodexAgent + a private native home + loopback Responses server exercise
 * automatic compaction after one successful request, followed by model denial.
 * Integration tier: needs CINDY_CODEX_TEST_BINARY; no cloud/account or shared data.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { CodexAgent } from './index.js';
import type { AgentEvent } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};

// #11484: nested gateway 407 must stop native requests, not just change the UI.
it.skipIf(!binaryPath).each([{ deny: 403, compact: true }, { deny: 407, compact: true },
  { deny: 407, compact: false }, { deny: 0, compact: true }])('native access denial=$deny compact=$compact', async ({ deny, compact }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-model-denial-'));
  const home = path.join(root, 'codex');
  const work = path.join(root, 'work');
  const events: AgentEvent[] = [];
  let requests = 0;
  let deniedRequests = 0;
  let compactPhase = !compact;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain the synthetic request */ }
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
    requests++;
    if (compactPhase && deny) {
      deniedRequests++;
      if (deny === 407) {
        res.writeHead(407, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
          code: '407', message: 'litellm.APIError: APIError: NovaException - ' + JSON.stringify({ error: {
            code: 'ACCOUNT_SHARING_ACCESS_DENIED',
            message: 'Apply for model access: https://example.invalid/apply',
          } }),
        } }));
        return;
      }
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
        code: 'user_model_access_denied', message: 'user not allowed to access model. This user can only access models=[qwen/synthetic]. Tried to access group/synthetic-model',
      } }));
      return;
    }
    const id = `response-${requests}`;
    const item = { id: `message-${requests}`, type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: compactPhase ? 'Synthetic summary.' : 'Synthetic answer.' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item],
        usage: { input_tokens: compactPhase ? 50 : 8100, output_tokens: 5, total_tokens: compactPhase ? 55 : 8105 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  let agent: CodexAgent | undefined;
  let pump: Promise<void> | undefined;
  try {
    await Promise.all([mkdir(home), mkdir(work)]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    await writeFile(path.join(home, 'config.toml'), [
      'model_provider="fixture"', 'cli_auth_credentials_store="ephemeral"',
      'check_for_update_on_startup=false', '[analytics]', 'enabled=false',
      '[features]', 'plugins=false', 'remote_plugin=false',
      '[mcp_servers.cindy_memory]', 'command="false"', 'enabled=false',
      '[model_providers.fixture]', 'name="Local denial fixture"',
      `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"',
      'requires_openai_auth=false', 'supports_websockets=false',
    ].join('\n'));
    agent = new CodexAgent({ binaryPath: binaryPath!, logger, runtimeConfig: {},
      resolveCodexLocalAuthPolicy: () => 'isolated',
      resolveModelContextLimit: () => 8192,
      resolveModelCompactionPct: () => 90,
      prepareCodexExtraSpawnConfig: async () => ({ extraArgs: [], extraEnv: {}, codexProxyActive: true }),
      auth: {
        getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {}, getAuthEnv: async () => ({
          HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CODEX_HOME: home,
          TMPDIR: root, OPENAI_API_KEY: '', CODEX_API_KEY: '',
          HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
          ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    const handle = await agent.startSession({ sessionId: 'model-denial-fixture', providerId: 'cprov-fixture',
      model: 'group/synthetic-model', workingDir: work, makerMemoryEnabled: false });
    pump = (async () => { for await (const event of handle.events()) events.push(event); })();
    const doneCount = () => events.filter(e => e.type === 'done').length;
    await handle.send({ type: 'user', content: 'Return a synthetic answer without tools.' }, { throwOnStartFailure: true });
    if (compact) {
      await vi.waitFor(() => expect(doneCount()).toBe(1), { timeout: 15_000 });
      compactPhase = true;
      await handle.send({ type: 'user', content: 'Continue without tools.' }, { throwOnStartFailure: true });
    }
    if (deny) {
      await vi.waitFor(() => expect(events.some(e => e.type === 'error' &&
        (e.data as { reason?: string }).reason === (deny === 407 ? 'account_access_denied' : 'model_unavailable'))).toBe(true), { timeout: 30_000 });
      await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));
      expect(deniedRequests).toBe(1);
      expect(events.filter(e => e.type === 'error')).toEqual([expect.objectContaining({ data: expect.objectContaining({
        reason: deny === 407 ? 'account_access_denied' : 'model_unavailable', isTerminal: true, willRetry: false,
        message: expect.stringContaining(deny === 407 ? 'https://example.invalid/apply' : '[MODEL_SELECTION_UNAVAILABLE]'),
      }) })]);
    } else {
      await vi.waitFor(() => expect(doneCount()).toBe(2), { timeout: 15_000 });
      expect(events.some(e => e.type === 'compact_boundary')).toBe(true);
      expect(events.filter(e => e.type === 'error')).toEqual([]);
    }
    await handle.close();
  } finally {
    await agent?.dispose();
    await pump;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
