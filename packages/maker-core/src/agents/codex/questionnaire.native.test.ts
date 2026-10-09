/** Real app-server, scripted local provider; no cloud model or user credentials. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { CodexAgent } from './index.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../types/events.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

it.skipIf(!binaryPath)('delivers a complete questionnaire through the native Codex tool round trip', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-questionnaire-'));
  const home = path.join(root, 'codex');
  const workingDir = path.join(root, 'work');
  await mkdir(home);
  await mkdir(workingDir);
  const questions = Array.from({ length: 5 }, (_, i) => ({
    id: `field-${i + 1}`, question: `Confirm contract field ${i + 1}?`,
  }));
  const requests: Array<{
    instructions?: string;
    tools?: unknown[];
    input: Array<Record<string, unknown>>;
  }> = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const item = requests.length === 1
      ? { type: 'function_call', id: 'questionnaire-item', call_id: 'questionnaire-call',
          name: 'cindy__ask_user_question', arguments: JSON.stringify({ questions }) }
      : { type: 'message', role: 'assistant', id: 'final-message',
          content: [{ type: 'output_text', text: 'All five fields confirmed.' }] };
    const events = [
      { type: 'response.created', response: { id: `response-${requests.length}` } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: `response-${requests.length}`, usage: {
        input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 10, total_tokens: 110,
      } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  let agent: CodexAgent | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    await writeFile(path.join(home, 'config.toml'), [
      'model="gpt-6-astra"', 'model_provider="fixture"',
      'approval_policy="never"', 'sandbox_mode="read-only"',
      'check_for_update_on_startup=false', '[analytics]', 'enabled=false',
      '[mcp_servers.cindy_memory]', 'command="unused-memory-server"', 'enabled=false',
      '[model_providers.fixture]', 'name="Local questionnaire fixture"',
      `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"',
      'requires_openai_auth=false', 'request_max_retries=0', 'stream_max_retries=0',
    ].join('\n'));
    agent = new CodexAgent({
      binaryPath: binaryPath!, logger, runtimeConfig: {},
      resolveCodexLocalAuthPolicy: () => 'isolated',
      prepareCodexExtraSpawnConfig: async () => ({ extraArgs: [], extraEnv: {}, codexProxyActive: true }),
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
        getAuthEnv: async () => ({
          CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '',
          HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
          ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    const handle = await agent.startSession({
      sessionId: 'questionnaire-native', model: 'gpt-6-astra', workingDir, makerMemoryEnabled: false,
    });
    let interaction: InteractionRequest | undefined;
    let answer!: (decision: InteractionDecision) => void;
    handle.setInteractionResolver((request) => {
      interaction = request;
      return new Promise((resolve) => { answer = resolve; });
    });
    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const event of handle.events()) {
        events.push(event);
        if (event.type === 'done') return;
      }
    })();
    await handle.send({ type: 'user', content: 'List all five contract fields and confirm each with me one by one.' },
      { throwOnStartFailure: true });
    await vi.waitFor(() => expect(interaction).toBeDefined(), { timeout: 10_000 });
    expect(interaction).toMatchObject({ kind: 'ask_user_question',
      questions: questions.map(({ question }) => ({ question })),
    });
    expect(requests).toHaveLength(1);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    answer({ kind: 'ask_user_question', answers: Object.fromEntries(
      questions.map((q, i) => [q.question, `Confirmed ${i + 1}`]),
    ) });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'done')).toBe(true), { timeout: 10_000 });
    await consume;
    expect(requests).toHaveLength(2);
    const output = requests[1].input.find((item) => item.type === 'function_call_output'
      && item.call_id === 'questionnaire-call');
    for (let i = 1; i <= 5; i += 1) {
      expect(JSON.stringify(output)).toContain(`field-${i}`);
      expect(JSON.stringify(output)).toContain(`Confirmed ${i}`);
    }
    // No mutable questionnaire progress is injected into the cacheable prefix.
    expect(requests[1].instructions).toEqual(requests[0].instructions);
    expect(requests[1].tools).toEqual(requests[0].tools);
    const prefix = (request: typeof requests[number]) => request.input
      .filter((item) => item.role === 'system' || item.role === 'developer')
      .map(({ id: _id, ...item }) => item);
    expect(prefix(requests[1])).toEqual(prefix(requests[0]));
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    await handle.close();
  } finally {
    await agent?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
