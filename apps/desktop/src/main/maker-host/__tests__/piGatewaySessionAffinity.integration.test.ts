/** Real Pi RPC → production loopback proxy → fake upstream affinity regression. */
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { PiAgent } from '../../../../../../packages/maker-core/src/agents/pi/index.js';
import type { AgentDeps, AgentSessionHandle } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';

vi.mock('../model-discovery/xai.js', () => ({ discardXaiModelsDiskCache: vi.fn(async () => {}) }));
vi.mock('../grok-oauth-login.js', () => ({ hasGrokOAuthLogin: () => false }));
vi.mock('../anthropic-compat-proxy-host.js', () => ({ getClaudeEndpoint: () => undefined }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }) }));
import { resolvePiCindyGatewayModelSpec } from '../pi-host.js';
import { setActiveCatalog, setXdGatewayModels } from '../active-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const binary = process.env.CINDY_TEST_PI_BINARY || path.join(root, 'apps/pi-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi.exe' : 'pi');
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
afterEach(() => { setActiveCatalog(BUNDLED_CATALOG); setXdGatewayModels([]); });

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/** 最小合法的 Anthropic Messages SSE 流:一段 text + usage。 */
function anthropicStreamBody(text: string, model: string): string {
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test_1',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function chatCompletionsStreamBody(text: string, model: string): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl_pi_native_1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl_pi_native_1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl_pi_native_1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}


// Resolve the caller-created temporary directory before starting any HTTP/Pi processes.
// Opt-in audit output contains only synthetic identity/status fields, never bodies or auth.
function createEvidenceWriter(): (record: Record<string, unknown>) => void {
  const directory = process.env.CINDY_TEST_PI_EVIDENCE_DIR;
  if (!directory) return () => {};
  let resolvedDirectory: string;
  try {
    resolvedDirectory = realpathSync(directory);
    if (!statSync(resolvedDirectory).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new Error('CINDY_TEST_PI_EVIDENCE_DIR must already exist; create a dedicated directory with mkdtemp under os.tmpdir() before running the test');
  }
  const relative = path.relative(realpathSync(tmpdir()), resolvedDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Pi test evidence must use a dedicated directory below os.tmpdir()');
  }
  return (record) => {
    appendFileSync(path.join(resolvedDirectory, 'requests.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  };
}

async function collectTurn(handle: AgentSessionHandle, content: string) {
  const events = (async () => {
    const seen = [];
    for await (const event of handle.events()) {
      seen.push(event);
      if (event.type === 'done') break;
    }
    return seen;
  })();
  await handle.send({ type: 'user', content });
  return events;
}

async function sendTurn(handle: AgentSessionHandle, content: string) {
  const seen = await collectTurn(handle, content);
  expect(seen.filter(event => event.type === 'error')).toEqual([]);
  expect(seen.some(event => event.type === 'text')).toBe(true);
  expect(seen.at(-1)).toMatchObject({ type: 'done', data: { status: 'completed' } });
}

describe.skipIf(!existsSync(binary))('Gateway session affinity (real Pi RPC and proxy)', () => {
  it.each([
    ['moonshot/kimi-k3', 'openai-completions', 'positive-resume-isolation-byom'],
    ['claude-opus-5', 'anthropic-messages', 'positive-resume-isolation-byom'],
    ['moonshot/kimi-k3', 'openai-completions', 'upstream-401'],
    ['claude-opus-5', 'anthropic-messages', 'upstream-401'],
    ['moonshot/kimi-k3', 'openai-completions', 'affinity-disabled-control'],
    ['claude-opus-5', 'anthropic-messages', 'affinity-disabled-control'],
  ] as const)('%s / %s / %s', async (model, api, scenario) => {
    const writeEvidence = createEvidenceWriter();
    const temp = mkdtempSync(path.join(tmpdir(), 'cindy-pi-affinity-'));
    const workingDir = path.join(temp, 'workspace');
    mkdirSync(workingDir);
    const requests: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
    let upstreamStatus = scenario === 'upstream-401' ? 401 : 200;
    let phase = 'first-turn';
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url ?? '', headers: req.headers, body });
        writeEvidence({
          case: `${api}/${scenario}`, protocol: api, phase, turn: requests.length,
          status: upstreamStatus,
          affinity: {
            'x-session-affinity': req.headers['x-session-affinity'] ?? null,
            session_id: req.headers.session_id ?? null,
            'x-client-request-id': req.headers['x-client-request-id'] ?? null,
          },
        });
        if (upstreamStatus === 401) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'fixture unauthorized' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(api === 'openai-completions' ? chatCompletionsStreamBody('affinity-ok', model) : anthropicStreamBody('affinity-ok', model));
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`;
    let proxyRequests = 0;
    const proxy = await createAnthropicCompatProxy({
      upstream: endpoint,
      requestGuard: () => { proxyRequests += 1; return null; },
    });
    let handle: AgentSessionHandle | undefined;
    try {
      setActiveCatalog(BUNDLED_CATALOG);
      setXdGatewayModels([{ id: model, agents: ['pi'] }]);
      const deps: AgentDeps = {
        binaryPath: binary, logger,
        auth: {
          getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' as const }),
          triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
          getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'fixture-not-a-real-key', HOME: temp, USERPROFILE: temp }),
        },
        runtimeConfig: { endpoint: proxy.url },
        resolvePiAgentHome: () => path.join(temp, 'agent'),
        resolvePiGlobalContextHome: () => temp,
        resolvePiGatewayModelSpec: resolvePiCindyGatewayModelSpec,
        capabilityAdditions: { availableModels: [{ id: model, displayName: model, contextWindow: 200000, efforts: [], defaultEffort: null }] },
      };
      if (scenario === 'affinity-disabled-control') {
        deps.resolvePiGatewayModelSpec = (provider, id, context) => {
          const spec = resolvePiCindyGatewayModelSpec(provider, id, context);
          return spec ? { ...spec, compat: { ...spec.compat, sendSessionAffinityHeaders: false } } : spec;
        };
      }
      const assertAffinity = (headers: IncomingHttpHeaders, id: string) => {
        expect(headers['x-session-affinity']).toBe(id);
        if (api === 'openai-completions') {
          expect(headers.session_id).toBe(id);
          expect(headers['x-client-request-id']).toBe(id);
        }
      };
      const agent = new PiAgent(deps);
      handle = await agent.startSession({ sessionId: 'task-a', providerId: 'xd', model, workingDir });
      const nativeId = handle.id;
      if (scenario === 'upstream-401') {
        phase = 'unauthorized';
        const events = await collectTurn(handle, 'FIXTURE_AUTH_FAILURE');
        expect(requests).toHaveLength(1);
        expect(events.some(event => event.type === 'error')).toBe(true);
        expect(events.some(event => event.type === 'text')).toBe(false);
        expect(events.at(-1)).toMatchObject({ type: 'done', data: { status: 'failed', result: '' } });
        const failedAffinity = requests[0]!.headers['x-session-affinity'];
        expect(failedAffinity).toMatch(/^[0-9a-f-]{36}$/);
        assertAffinity(requests[0]!.headers, failedAffinity as string);
        writeEvidence({ case: `${api}/${scenario}`, phase, settlement: 'failed', errorEvent: true, textEvent: false });
        upstreamStatus = 200;
        phase = 'same-task-after-401';
        await sendTurn(handle, 'FIXTURE_RECOVERED');
        expect(requests).toHaveLength(2);
        const restoredId = JSON.parse(readFileSync(nativeId, 'utf8').split('\n')[0]!).id as string;
        expect(restoredId).toBe(failedAffinity);
        assertAffinity(requests[1]!.headers, restoredId);
        writeEvidence({ case: `${api}/${scenario}`, phase, settlement: 'completed', errorEvent: false });
        return;
      }
      await sendTurn(handle, 'AFFINITY_FIRST_TURN');
      const affinityId = JSON.parse(readFileSync(nativeId, 'utf8').split('\n')[0]!).id as string;
      expect(affinityId).toMatch(/^[0-9a-f-]{36}$/);
      if (scenario === 'affinity-disabled-control') {
        expect(requests).toHaveLength(1);
        for (const header of ['x-session-affinity', 'session_id', 'x-client-request-id']) {
          expect(requests[0]!.headers[header]).toBeUndefined();
        }
        // The exact positive contract rejects the pre-fix behavior, even though inference succeeds.
        expect(() => assertAffinity(requests[0]!.headers, affinityId)).toThrow();
        writeEvidence({ case: `${api}/${scenario}`, phase, settlement: 'completed', positiveContractRejected: true });
        return;
      }
      phase = 'second-turn';
      await sendTurn(handle, 'AFFINITY_SECOND_TURN');
      await handle.close(); handle = undefined;
      handle = await agent.startSession({ sessionId: 'task-a', providerId: 'xd', model, workingDir, resumeSessionId: nativeId });
      expect(handle.id).toBe(nativeId);
      phase = 'resumed-turn';
      await sendTurn(handle, 'AFFINITY_RESUMED_TURN');
      expect(requests).toHaveLength(3);
      expect(requests[2]!.body).toContain('AFFINITY_FIRST_TURN');
      expect(requests[2]!.body).toContain('AFFINITY_SECOND_TURN');
      for (const request of requests) {
        expect(request.url).toContain(api === 'openai-completions' ? '/chat/completions' : '/messages');
        assertAffinity(request.headers, affinityId);
      }
      await handle.close(); handle = undefined;
      handle = await agent.startSession({ sessionId: 'task-b', providerId: 'xd', model, workingDir });
      expect(handle.id).not.toBe(nativeId);
      phase = 'different-task';
      await sendTurn(handle, 'AFFINITY_OTHER_TASK');
      expect(requests).toHaveLength(4);
      expect(requests[3]!.headers['x-session-affinity']).toBe(JSON.parse(readFileSync(handle.id, 'utf8').split('\n')[0]!).id);
      expect(requests[3]!.headers['x-session-affinity']).not.toBe(affinityId);
      expect(requests[3]!.body).not.toContain('AFFINITY_FIRST_TURN');
      await handle.close(); handle = undefined;

      // Direct BYOM uses its own native provider without Gateway policy injection.
      deps.resolvePiNativeProviders = async () => ({ providers: [{
        id: 'fixture-byom', name: 'Fixture BYOM', baseUrl: endpoint, api,
        apiKeyEnvVar: 'CINDY_FIXTURE_BYOM_KEY', models: [{ id: 'fixture-model', name: 'Fixture model' }],
      }], env: { CINDY_FIXTURE_BYOM_KEY: 'fixture-not-a-real-key' } });
      const directAgent = new PiAgent(deps);
      handle = await directAgent.startSession({ sessionId: 'task-byom', providerId: 'fixture-byom', model: 'fixture-model', workingDir });
      phase = 'direct-byom';
      await sendTurn(handle, 'BYOM_UNCHANGED');
      expect(requests).toHaveLength(5);
      expect(proxyRequests).toBe(4);
      writeEvidence({ case: `${api}/${scenario}`, phase, settlement: 'completed', proxyRequests });
      for (const header of ['x-session-affinity', 'session_id', 'x-client-request-id']) {
        expect(requests[4]!.headers[header]).toBeUndefined();
      }
    } finally {
      await handle?.close();
      await proxy.dispose();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
    }
  }, 60000);
});
