import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAnthropicCompatProxy, type ProxyHandle } from '@cindy/anthropic-compat-proxy';
import { createResponsesCustomToolFunctionAdapter } from '@cindy/responses-chat-bridge';
import { afterEach, describe, expect, it } from 'vitest';

import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import {
  AppServerHost,
  type ThreadSubscription,
} from '../../../../../../packages/maker-core/src/agents/codex/app-server/host.js';
import {
  Method,
  type ItemEnvelope,
  type ThreadStartResponse,
} from '../../../../../../packages/maker-core/src/agents/codex/app-server/protocol.js';
import { createStdioTransport } from '../../../../../../packages/maker-core/src/agents/codex/app-server/stdioTransport.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..');
const codexBinary = path.join(
  repoRoot,
  'apps',
  'codex-bin',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex.exe' : 'codex',
);
const codexBoundaryAvailable = existsSync(codexBinary);
const fixtureContents = 'issue-3168-real-command-result';

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
};

function sse(events: unknown[]): string {
  return events
    .map((event) => {
      const type = (event as { type: string }).type;
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join('');
}

function responseCreated(id: string): unknown {
  return { type: 'response.created', response: { id } };
}

function responseCompleted(id: string): unknown {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe.skipIf(!codexBoundaryAvailable)('Codex custom exec function adapter E2E', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it('reads a fixture through a real commandExecution and returns it without Web Search', async () => {
    const providerRequests: Array<Record<string, unknown>> = [];
    let execFunctionName = '';
    const command =
      process.platform === 'win32'
        ? "Get-Content -LiteralPath 'issue-3168-fixture.txt' -Raw"
        : "cat 'issue-3168-fixture.txt'";
    const code = [
      'const result = typeof tools.exec_command === "function"',
      `  ? await tools.exec_command(${JSON.stringify({ cmd: command })})`,
      `  : await tools.shell_command(${JSON.stringify({ command })});`,
      'text(JSON.stringify(result));',
    ].join('\n');

    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      providerRequests.push(body);

      let responseBody: string;
      if (providerRequests.length === 1) {
        const tools = Array.isArray(body.tools)
          ? (body.tools as Array<Record<string, unknown>>)
          : [];
        const execFunction = tools.find((tool) => {
          const parameters = tool.parameters as { required?: string[] } | undefined;
          return tool.type === 'function' && parameters?.required?.includes('input');
        });
        execFunctionName = typeof execFunction?.name === 'string' ? execFunction.name : '';
        const args = JSON.stringify({ input: code });
        responseBody = sse([
          responseCreated('response-1'),
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'function-call-1',
              type: 'function_call',
              status: 'in_progress',
              call_id: 'exec-call-1',
              name: execFunctionName,
              arguments: '',
            },
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: 'function-call-1',
            output_index: 0,
            arguments: args,
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'function-call-1',
              type: 'function_call',
              status: 'completed',
              call_id: 'exec-call-1',
              name: execFunctionName,
              arguments: args,
            },
          },
          responseCompleted('response-1'),
        ]);
      } else if (providerRequests.length === 2) {
        responseBody = sse([
          responseCreated('response-2'),
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'message-1',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: fixtureContents }],
            },
          },
          responseCompleted('response-2'),
        ]);
      } else {
        res.writeHead(500).end('unexpected extra Responses request');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end(responseBody);
    });
    const providerUrl = await listen(provider);
    cleanups.push(() =>
      new Promise<void>((resolve) => {
        provider.closeAllConnections();
        provider.close(() => resolve());
      }),
    );

    const adapter = createResponsesCustomToolFunctionAdapter(['exec']);
    const proxy: ProxyHandle = await createAnthropicCompatProxy({
      upstream: providerUrl,
      transformRequest: [(body, ctx) => adapter.adaptRequest(body, ctx.reqId)],
      transformResponse: (ctx) =>
        adapter.createResponseTransform(ctx.reqId, {
          contentType: ctx.responseHeaders['content-type'] ?? '',
          contentEncoding: ctx.responseHeaders['content-encoding'] ?? '',
        }),
    });
    cleanups.push(() => proxy.dispose());

    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-issue-3168-e2e-'));
    const codexHome = path.join(tempRoot, 'codex-home');
    const workingDir = path.join(tempRoot, 'workdir');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    writeFileSync(path.join(workingDir, 'issue-3168-fixture.txt'), fixtureContents);
    writeFileSync(
      path.join(codexHome, 'config.toml'),
      `
model = "stealth/ox-alpha"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"

[features.code_mode]
enabled = true

[model_providers.mock_provider]
name = "Issue 3168 loopback fake Provider"
base_url = "${proxy.url}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
    );
    cleanups.push(() =>
      rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
    );

    const host = new AppServerHost({
      createTransport: () =>
        createStdioTransport({
          binaryPath: codexBinary,
          cwd: workingDir,
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
            OPENAI_API_KEY: 'test-key',
          },
        }),
      logger,
      clientInfo: { name: 'cindy-issue-3168-e2e', version: '0.0.0' },
    });
    let subscription: ThreadSubscription | undefined;
    cleanups.push(async () => {
      // This test owns the host. Shut it down before releasing the thread so a
      // slow thread/unsubscribe cannot consume most of Vitest's hook budget.
      await host.shutdown();
      await subscription?.release();
    });

    const thread = await withTimeout(
      host.request<ThreadStartResponse>(
        Method.ThreadStart,
        {
          model: 'stealth/ox-alpha',
          modelProvider: 'mock_provider',
          cwd: workingDir,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
        { timeoutMs: 20_000 },
      ),
      25_000,
      'thread/start',
    );

    let resolveTurnCompleted!: () => void;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    const startedItems: ItemEnvelope[] = [];
    const completedItems: ItemEnvelope[] = [];
    subscription = host.subscribeThread(thread.thread.id, {
      turnCompleted: () => resolveTurnCompleted(),
      itemStarted: ({ item }) => startedItems.push(item),
      itemCompleted: ({ item }) => completedItems.push(item),
    });

    await withTimeout(
      host.request(
        Method.TurnStart,
        {
          threadId: thread.thread.id,
          input: [
            { type: 'text', text: 'Read issue-3168-fixture.txt and return its exact contents.' },
          ],
        },
        { timeoutMs: 20_000 },
      ),
      25_000,
      'turn/start',
    );
    await withTimeout(turnCompleted, 30_000, 'turn/completed');

    expect(providerRequests).toHaveLength(2);
    const firstTools = providerRequests[0]?.tools as Array<Record<string, unknown>>;
    expect(execFunctionName).not.toBe('');
    expect(firstTools).toContainEqual(
      expect.objectContaining({ type: 'function', name: execFunctionName }),
    );
    expect(firstTools).not.toContainEqual(
      expect.objectContaining({ type: 'custom', name: 'exec' }),
    );

    const secondInput = providerRequests[1]?.input as Array<Record<string, unknown>>;
    const execOutput = secondInput.find(
      (item) => item.type === 'function_call_output' && item.call_id === 'exec-call-1',
    );
    expect(JSON.stringify(execOutput?.output)).toContain(fixtureContents);
    expect(startedItems).toContainEqual(expect.objectContaining({ type: 'commandExecution' }));
    expect(completedItems).toContainEqual(
      expect.objectContaining({
        type: 'commandExecution',
        status: 'completed',
      }),
    );
    expect(completedItems).toContainEqual(
      expect.objectContaining({
        type: 'agentMessage',
        text: fixtureContents,
      }),
    );
    expect([...startedItems, ...completedItems].some((item) => item.type === 'webSearch')).toBe(
      false,
    );
  }, 45_000);
});
