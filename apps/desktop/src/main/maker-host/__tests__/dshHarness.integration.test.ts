import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import {
  DshAgent,
  type AgentDeps,
  type AgentEvent,
  type AgentSessionHandle,
} from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const logger: AgentDeps['logger'] = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return logger;
  },
};

function dshLauncher(): string {
  return require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin');
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fake DeepSeek server did not expose a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('DSH Harness integration (bundled runtime + fake DeepSeek stream)', () => {
  it(
    'sends the selected Pro model and a text-only user message through the real Harness child process',
    { timeout: 45_000 },
    async () => {
      const requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));

        if (req.method !== 'POST' || req.url !== '/chat/completions') {
          res.writeHead(404).end();
          return;
        }

        requests.push({
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close',
        });
        res.write(
          `data: ${JSON.stringify({
            id: 'dsh-test-response',
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'dsh-test-response',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
      const endpoint = await listen(server);
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-dsh-harness-'));
      const workingDir = path.join(tempRoot, 'workdir');
      const sessionRoot = path.join(tempRoot, 'sessions');
      await Promise.all([mkdir(workingDir), mkdir(sessionRoot)]);

      const originalBaseUrl = process.env.DEEPSEEK_BASE_URL;
      const originalSnapshot = process.env.DSH_SNAPSHOT;
      const originalHome = process.env.DSH_HOME;
      const originalSystemPrompt = process.env.DSH_SYSTEM_PROMPT;
      let handle: AgentSessionHandle | undefined;
      try {
        // The only network target is this loopback server. Keep every DSH file
        // (including its anonymous id) beneath the disposable test directory.
        // The Harness must receive this endpoint from the selected DSH runtime
        // configuration, not from the ambient developer environment.
        delete process.env.DEEPSEEK_BASE_URL;
        process.env.DSH_SNAPSHOT = '1';
        process.env.DSH_HOME = path.join(tempRoot, 'home');
        process.env.DSH_SYSTEM_PROMPT = 'Reply with exactly OK.';

        const agent = new DshAgent({
          binaryPath: dshLauncher(),
          auth: {} as AgentDeps['auth'],
          runtimeConfig: {} as AgentDeps['runtimeConfig'],
          logger,
        });
        handle = await agent.startSession({
          sessionId: 'dsh-harness-pro-text',
          workingDir,
          model: 'deepseek-v4-pro',
          vendorOptions: {
            dshApiKey: 'dsh-harness-test-key',
            dshBaseUrl: endpoint,
            dshModels: [
              {
                id: 'deepseek-v4-pro',
                name: 'Configured Pro',
                contextWindow: 640_000,
              },
            ],
            dshReasoningEffort: 'low',
            dshSessionRoot: sessionRoot,
            dshBashLocal: false,
          },
        });

        const events: AgentEvent[] = [];
        const collectUntilDone = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'error') {
              throw new Error(
                (event.data as { message?: string }).message ?? 'DSH Harness reported an error',
              );
            }
            if (event.type === 'done') return;
          }
          throw new Error('DSH event stream ended before the turn completed');
        })();

        await handle.send({
          type: 'user',
          content: [{ type: 'text', text: 'Return the word OK.' }],
        });
        await withTimeout(collectUntilDone, 30_000, 'DSH text response');

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'text',
            source: 'dsh',
            data: expect.objectContaining({ text: 'OK' }),
          }),
        );
        expect(events.some((event) => event.type === 'done')).toBe(true);

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ authorization: 'Bearer dsh-harness-test-key' });
        expect(requests[0].body).toMatchObject({
          model: 'deepseek-v4-pro',
          stream: true,
          thinking: { type: 'enabled' },
          reasoning_effort: 'low',
        });
        const messages = requests[0].body.messages as Array<{ role?: string; content?: unknown }>;
        expect(messages).toContainEqual({ role: 'user', content: 'Return the word OK.' });
        expect(messages.every((message) => typeof message.content === 'string')).toBe(true);
      } finally {
        await handle?.close();
        restoreEnv('DEEPSEEK_BASE_URL', originalBaseUrl);
        restoreEnv('DSH_SNAPSHOT', originalSnapshot);
        restoreEnv('DSH_HOME', originalHome);
        restoreEnv('DSH_SYSTEM_PROMPT', originalSystemPrompt);
        await close(server);
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );
});
