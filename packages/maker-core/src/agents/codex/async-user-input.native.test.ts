/** Opt-in protocol check; uses a private home and a local fake model, no account or API spend. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { AppServerHost } from './app-server/host.js';
import { createStdioTransport } from './app-server/stdioTransport.js';
import { Method, type ItemEnvelope, type ThreadStartResponse, type TurnStartResponse } from './app-server/protocol.js';
import { asyncUserInputQuestions } from './async-user-input.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};

it.skipIf(!binaryPath).each(['during', 'after', 'unanswered'] as const)(
  'native async question lifecycle with answer=%s', async (answerTiming) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-async-question-'));
  const codexHome = path.join(root, 'codex-home');
  const workingDir = path.join(root, 'workdir');
  await mkdir(codexHome);
  await mkdir(workingDir);
  const requests: Array<{ instructions?: string; input: Array<Record<string, unknown>> }> = [];
  let continueResponse: ServerResponse | undefined;
  const send = (res: ServerResponse, item: unknown, number: number) => {
    const id = `response-${number}`;
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, usage: {
        input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 10, total_tokens: 110,
      } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  };
  const answer = { type: 'message', role: 'assistant', id: 'answer',
    content: [{ type: 'output_text', text: 'Independent work completed.' }] };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests.length === 1) {
      send(res, { type: 'function_call', name: 'request_user_input_async', call_id: 'ask-async-1',
        arguments: JSON.stringify({ questions: [{ title: 'Which bot?', options: ['Personal', 'Both'] }] }),
      }, 1);
    } else if (requests.length === 2) {
      continueResponse = res;
    } else {
      send(res, answer, requests.length);
    }
  });
  let host: AppServerHost | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing local address');
    await writeFile(path.join(codexHome, 'config.toml'), `
model = "gpt-6-astra"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.mock]
name = "Local async question test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
    host = new AppServerHost({
      createTransport: () => createStdioTransport({ binaryPath: binaryPath!, cwd: workingDir,
        env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'invalid-test-key' } }),
      logger, clientInfo: { name: 'cindy-async-question-test', version: '0.0.0' },
    });
    const thread = await host.request<ThreadStartResponse>(Method.ThreadStart, {
      model: 'gpt-6-astra', modelProvider: 'mock', cwd: workingDir,
      approvalPolicy: 'never', sandbox: 'read-only',
    }, { timeoutMs: 10_000 });
    const items: ItemEnvelope[] = [];
    let completed = false;
    const completedStatuses: string[] = [];
    const blockingQuestions = vi.fn(async () => ({ answers: {} }));
    const subscription = host.subscribeThread(thread.thread.id, {
      itemCompleted: (params) => { items.push(params.item); },
      requestUserInput: blockingQuestions,
      turnCompleted: (params) => { completedStatuses.push(params.turn.status); completed = true; },
    });
    const turn = await host.request<TurnStartResponse>(Method.TurnStart, {
      threadId: thread.thread.id, input: [{ type: 'text', text: 'Ask which bot and continue independent work.' }],
    }, { timeoutMs: 10_000 });
    await vi.waitFor(() => expect(continueResponse).toBeDefined(), { timeout: 10_000 });
    const question = items.find((item) => item.delivery === 'async');
    expect(question).toMatchObject({ type: 'agentMessage', id: 'ask-async-1',
      questions: [{ title: 'Which bot?', options: ['Personal', 'Both'] }] });
    expect(asyncUserInputQuestions(question!)?.[0]?.question).toBe('Which bot?');
    const answerInput = [{ type: 'text', text: 'Q: Which bot?\nA: Both' }];
    if (answerTiming === 'during') {
      await host.request(Method.TurnSteer, { threadId: thread.thread.id, expectedTurnId: turn.turn.id,
        input: answerInput,
      }, { timeoutMs: 10_000 });
    }
    send(continueResponse!, answer, 2);
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 10_000 });
    if (answerTiming !== 'during') {
      // There is no outstanding request holding the native turn open.
      expect(requests).toHaveLength(2);
      await expect(host.request(Method.TurnSteer, {
        threadId: thread.thread.id, expectedTurnId: turn.turn.id, input: answerInput,
      }, { timeoutMs: 10_000 })).rejects.toThrow(/no active turn/i);
    }
    if (answerTiming === 'after') {
      completed = false;
      await host.request(Method.TurnStart, { threadId: thread.thread.id, input: answerInput }, { timeoutMs: 10_000 });
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 10_000 });
    }
    await subscription.release();
    expect(blockingQuestions).not.toHaveBeenCalled();
    expect(completedStatuses).toEqual(answerTiming === 'after' ? ['completed', 'completed'] : ['completed']);
    expect(requests).toHaveLength(answerTiming === 'unanswered' ? 2 : 3);
    if (answerTiming !== 'unanswered') expect(JSON.stringify(requests[2].input)).toContain('A: Both');
    // The event bridge and answer must not change the stable prompt prefix.
    expect(requests.at(-1)?.instructions).toEqual(requests[0].instructions);
    const prefix = (request: typeof requests[number]) => request.input
      .filter((item) => item.role === 'system' || item.role === 'developer')
      .map(({ id: _id, ...item }) => item);
    expect(prefix(requests.at(-1)!)).toEqual(prefix(requests[0]));
  } finally {
    continueResponse?.destroy();
    await host?.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 25_000);
