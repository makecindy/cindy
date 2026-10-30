/** Opt-in: real harnesses, isolated homes and a loopback fake model; no account or API spend. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { ClaudeCodeAgent } from '../claude-code/index.js';
import { PiAgent } from '../pi/index.js';
import { Session } from '../../session.js';
import type { AgentDeps } from '../base-agent.js';
import type { AgentEvent, InteractionDecision } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

function reply(res: ServerResponse, model: string, text = 'Independent work completed.') {
  const events = [
    { type: 'message_start', message: { id: 'test-message', type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, usage: { input_tokens: 42, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

for (const agentKind of ['claude-code', 'pi'] as const) {
  const binary = agentKind === 'pi' ? process.env.CINDY_TEST_PI_BINARY : process.env.CINDY_TEST_CLAUDE_BINARY;
  it.skipIf(!binary).each(['during', 'twice', 'unanswered'] as const)(`${agentKind} native async question: %s`, async (timing) => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-async-harness-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'work');
    await Promise.all([mkdir(home), mkdir(cwd)]);
    const model = agentKind === 'pi' ? 'pi-test-model' : 'claude-opus-4-6';
    const bodies: Array<Record<string, unknown>> = [];
    let held: ServerResponse | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.url?.includes('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}');
        return;
      }
      if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Claude also performs a separate title query; it is not an agent turn.
      if (!Array.isArray(body.tools) || body.tools.length === 0) { reply(res, model); return; }
      bodies.push(body);
      if (bodies.length === 1) held = res;
      else reply(res, model, 'Answer received.');
    });
    let session: Session | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing loopback address');
      const endpoint = `http://127.0.0.1:${address.port}`;
      const deps: AgentDeps = {
        binaryPath: binary!, logger, runtimeConfig: { endpoint },
        auth: {
          getState: async () => ({ authenticated: true, authSource: 'api-key' as const }),
          triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
          getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'invalid-test-key', CINDY_PI_API_KEY: 'invalid-test-key',
            CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: endpoint }),
        },
        resolvePiAgentHome: () => home, resolvePiGlobalContextHome: () => home,
        resolvePiGatewayModelApi: () => 'anthropic-messages',
        capabilityAdditions: { availableModels: [{ id: model, displayName: 'Test', contextWindow: 200_000,
          efforts: [], defaultEffort: null }] },
      };
      const agent = agentKind === 'pi' ? new PiAgent(deps) : new ClaudeCodeAgent(deps);
      const handle = await agent.startSession({ sessionId: 'async-native-test', workingDir: cwd, model });
      const steer = vi.spyOn(handle, 'steer');
      session = new Session({ id: 'async-native-test', agentKind, workDir: cwd, handle, logger,
        capabilities: { sameTurnSteer: { supported: true } } as never, turnStallMs: 0 });
      let answer!: (decision: InteractionDecision) => void;
      session.setInteractionListener(() => new Promise((resolve) => { answer = resolve; }));
      const events: AgentEvent[] = [];
      session.onEvent((event) => events.push(event));
      await session.send('Do independent work.');
      await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 20_000 });
      const id = session.askUserQuestionAsync([{ question: 'Which scope?' }]);
      expect(session.getTurnControlSnapshot().pendingInteractionCount).toBe(0);
      if (timing !== 'unanswered') {
        answer({ kind: 'ask_user_question', answers: { 'Which scope?': 'BOTH_BOTS_CANARY' } });
        await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
        await steer.mock.results[0].value;
        if (timing === 'twice') {
          session.askUserQuestionAsync([{ question: 'Which style?' }]);
          answer({ kind: 'ask_user_question', answers: { 'Which style?': 'SECOND_ANSWER_CANARY' } });
          await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
          await steer.mock.results[1].value;
        }
      }
      reply(held!, model);
      await vi.waitFor(() => expect(events.some((event) => event.type === 'done')).toBe(true), { timeout: 20_000 });
      if (timing !== 'unanswered') {
        await vi.waitFor(() => expect(bodies.some((body) => JSON.stringify(body.messages).includes('BOTH_BOTS_CANARY'))).toBe(true), { timeout: 10_000 });
        expect(bodies.at(-1)?.system).toEqual(bodies[0].system);
        expect(bodies.at(-1)?.tools).toEqual(bodies[0].tools);
        await vi.waitFor(() => expect(events.some((event) => event.type === 'text'
          && JSON.stringify(event.data).includes('Answer received.'))).toBe(true));
        await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));
        if (timing === 'twice') expect(JSON.stringify(bodies.at(-1)?.messages)).toContain('SECOND_ANSWER_CANARY');
        expect(events.filter((event) => event.type === 'done' && event.turnContinuationId === undefined)).toHaveLength(1);
      } else {
        expect(events.some((event) => event.type === 'interaction_dismissed' && (event.data as { requestId?: string }).requestId === id)).toBe(true);
        answer({ kind: 'ask_user_question', answers: { 'Which scope?': 'BOTH_BOTS_CANARY' } });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(steer).not.toHaveBeenCalled();
        expect(bodies).toHaveLength(1);
      }
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    } finally {
      held?.destroy();
      await session?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 45_000);
}
