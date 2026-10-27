/** #6351: real app-server + local Responses stream; no account, private logs or API spend.
 * Unit notification fixtures cannot prove which notifications a truncated SSE
 * response actually emits. The minimum input is one completed assistant item
 * followed by EOF without response.completed; this opt-in integration tier
 * covers the native process/socket boundary through CodexAgent.startSession.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { CodexAgent } from './index.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';

const binaryPath = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};

it.skipIf(!binaryPath).each(['success', 'exhausted', 'stop', 'steer'] as const)(
  'attributes native sampling retries through %s and a later manual send', async (ending) => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-sampling-retry-'));
    const home = path.join(root, 'codex-home');
    const workingDir = path.join(root, 'workdir');
    const requests: unknown[] = [];
    const events: AgentEvent[] = [];
    let heldResponse: ServerResponse | undefined;
    let settled = 0;
    let recover = false;
    const sendEvent = (res: ServerResponse, event: { type: string; [key: string]: unknown }) =>
      res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    const complete = (res: ServerResponse, request: number) => {
      sendEvent(res, { type: 'response.completed', response: { id: 'response-' + request,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
      res.end();
    };
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const request = requests.length;
      const willComplete = recover || request > 2 || (request === 2 && ending === 'success');
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      sendEvent(res, { type: 'response.created', response: { id: 'response-' + request } });
      if (willComplete) {
        for (const [id, phase] of [['accepted-commentary-', 'commentary'], ['accepted-intro-', 'final_answer']] as const) {
          sendEvent(res, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant',
            id: id + request, phase, content: [{ type: 'output_text', text: id + request }] } });
        }
      }
      sendEvent(res, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant',
        id: 'answer-' + request, phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Opening from request ' + request }] } });
      if (willComplete) {
        complete(res, request);
      } else if (request === 2 && (ending === 'stop' || ending === 'steer')) {
        heldResponse = res;
      } else {
        // The assistant item is complete, but response.completed is absent.
        // Native Codex must retry this sampling request rather than complete the turn.
        res.end();
      }
    });
    let agent: CodexAgent | undefined;
    let pump: Promise<void> | undefined;
    try {
      await mkdir(home);
      await mkdir(workingDir);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing local address');
      await writeFile(path.join(home, 'config.toml'), [
        'model="fixture-model"', 'model_provider="fixture"',
        'cli_auth_credentials_store="ephemeral"', 'check_for_update_on_startup=false',
        '[analytics]', 'enabled=false',
        '[mcp_servers.cindy_memory]', 'command="false"', 'enabled=false',
        '[model_providers.fixture]', 'name="Local retry fixture"',
        'base_url="http://127.0.0.1:' + address.port + '/v1"', 'wire_api="responses"',
        'requires_openai_auth=false', 'supports_websockets=false', 'request_max_retries=0', 'stream_max_retries=1',
      ].join('\n'));
      agent = new CodexAgent({ binaryPath: binaryPath!, logger, runtimeConfig: {},
        resolveCodexLocalAuthPolicy: () => 'isolated',
        prepareCodexExtraSpawnConfig: async () => ({ extraArgs: [], extraEnv: {}, codexProxyActive: true }),
        auth: {
          getState: async () => ({ authenticated: true }),
          triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
          getAuthEnv: async () => ({ HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
            CODEX_HOME: home, TMPDIR: root, OPENAI_API_KEY: '', CODEX_API_KEY: '',
            HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
            ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' }),
        },
      });
      const handle = await agent.startSession({ sessionId: 'sampling-fixture', providerId: 'cprov-fixture',
        model: 'fixture-model', workingDir, makerMemoryEnabled: false });
      pump = (async () => {
        for await (const event of handle.events()) {
          events.push(event);
          const data = event.data as { isRunning?: boolean };
          if (event.type === 'done' || (event.type === 'status' && data.isRunning === false)) settled++;
        }
      })();
      await handle.send({ type: 'user', content: 'Introduce yourself once.' }, { throwOnStartFailure: true });
      if (ending === 'stop' || ending === 'steer') {
        await vi.waitFor(() => expect(events.some(event => event.type === 'text' &&
          (event.data as { agentMessageId?: string }).agentMessageId === 'answer-2')).toBe(true), { timeout: 10_000 });
        expect(settled).toBe(0);
        if (ending === 'stop') await handle.abort();
        else {
          await handle.steer({ type: 'user', content: 'Also include the word steered.' });
          complete(heldResponse!, 2);
        }
      }
      await vi.waitFor(() => expect(settled).toBeGreaterThan(0), { timeout: 15_000 });
      // A terminal native error may settle without a synthetic done. Steering
      // adds a successful sampling request in the same turn after the held one.
      if (ending !== 'exhausted') {
        await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
      }
      expect(requests).toHaveLength(ending === 'steer' ? 3 : 2);
      if (ending === 'exhausted') {
        expect(events.some(event => event.type === 'error' &&
          (event.data as { isTerminal?: boolean }).isTerminal === true)).toBe(true);
      }
      if (ending === 'stop') {
        expect(events.some(event => event.type === 'done' &&
          (event.data as { cancelled?: boolean }).cancelled === true)).toBe(true);
      }
      const failures = events.flatMap(event => {
        const data = event.data as { assistantAttemptFailure?: { agentMessageIds: string[]; turnId: string } };
        return data?.assistantAttemptFailure ? [data.assistantAttemptFailure] : [];
      });
      expect(failures.flatMap(failure => failure.agentMessageIds)).toContain('answer-1');
      expect(new Set(failures.map(failure => failure.turnId)).size).toBe(1);
      if (ending === 'exhausted' || ending === 'stop') {
        expect(failures.flatMap(failure => failure.agentMessageIds)).toContain('answer-2');
      } else {
        expect(failures.flatMap(failure => failure.agentMessageIds)).not.toContain('answer-2');
      }
      expect(events.filter(event => event.type === 'text').map(event =>
        (event.data as { text?: string }).text)).toContain('Opening from request 1');
      expect(events.some(event => event.type === 'error' &&
        (event.data as { willRetry?: boolean }).willRetry === true)).toBe(true);
      if (ending === 'success' || ending === 'steer') {
        const acceptedRequest = ending === 'success' ? 2 : 3;
        const acceptedIds = ['accepted-commentary-' + acceptedRequest, 'accepted-intro-' + acceptedRequest];
        const textIds = events.filter(event => event.type === 'text').map(event =>
          (event.data as { agentMessageId?: string }).agentMessageId);
        expect(textIds).toEqual(expect.arrayContaining(acceptedIds));
        expect(failures.flatMap(failure => failure.agentMessageIds).some(id => acceptedIds.includes(id))).toBe(false);
      }
      const failureCount = failures.length;
      recover = true;
      const boundary = events.length;
      await handle.send({ type: 'user', content: 'Continue.' }, { throwOnStartFailure: true });
      await vi.waitFor(() => expect(events.slice(boundary).some(event => event.type === 'done')).toBe(true),
        { timeout: 10_000 });
      expect(events.slice(boundary).some(event =>
        (event.data as { assistantAttemptFailure?: unknown })?.assistantAttemptFailure)).toBe(false);
      expect(failureCount).toBeGreaterThan(0);
      await handle.close();
      await pump;
    } finally {
      heldResponse?.destroy();
      await agent?.dispose();
      await pump;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 45_000,
);
