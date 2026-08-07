import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Logger } from '../../interfaces/logger.js';
import { AppServerHost } from './app-server/host.js';
import { Method, type ThreadStartResponse } from './app-server/protocol.js';
import { createStdioTransport } from './app-server/stdioTransport.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const codexBinary = path.join(
  repoRoot,
  'apps',
  'codex-bin',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex.exe' : 'codex',
);
const codexBoundaryAvailable = process.platform !== 'win32' && existsSync(codexBinary);

const answerPayload = {
  pr_3322_decision: { answers: ['缩回重发'] },
};

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
  return events.map((event) => {
    const type = (event as { type: string }).type;
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join('');
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
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
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
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

// This is a real app-server/functions.exec boundary test. Keep it out of unit lanes
// that cannot provide a reliable bundled Codex binary (notably Windows); local runs
// with the binary present still exercise the complete boundary.
describe.skipIf(!codexBoundaryAvailable)('Codex Ask code-mode return contract', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('returns the dynamic Ask response to functions.exec as a directly parseable JSON string', async () => {
    const responseBodies: Array<Record<string, unknown>> = [];
    const code = `
const raw = await tools.cindy__ask_user_question({
  questions: [{
    id: "pr_3322_decision",
    header: "熔断裁决",
    question: "请选择后续处置",
    options: [{ label: "缩回重发" }],
    isOther: false,
  }],
});
text(JSON.stringify({
  type: typeof raw,
  parsed: JSON.parse(raw),
  contentIsUndefined: raw.content === undefined,
  structuredContentIsUndefined: raw.structuredContent === undefined,
}));
`;
    const responses = [
      sse([
        responseCreated('response-1'),
        {
          type: 'response.output_item.done',
          item: {
            type: 'custom_tool_call',
            call_id: 'exec-call-1',
            name: 'exec',
            input: code,
          },
        },
        responseCompleted('response-1'),
      ]),
      sse([
        responseCreated('response-2'),
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            id: 'message-1',
            content: [{ type: 'output_text', text: 'done' }],
          },
        },
        responseCompleted('response-2'),
      ]),
    ];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end();
        return;
      }
      responseBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      const body = responses.shift();
      if (!body) {
        res.writeHead(500).end('unexpected extra Responses request');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'close',
      });
      res.end(body);
    });
    const baseUrl = await listen(server);
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-codex-ask-contract-'));
    const codexHome = path.join(tempRoot, 'codex-home');
    const workingDir = path.join(tempRoot, 'workdir');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    writeFileSync(path.join(codexHome, 'config.toml'), `
model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"

[features.code_mode]
enabled = true

[model_providers.mock_provider]
name = "Mock provider for Ask contract test"
base_url = "${baseUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
    cleanups.push(() => rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    }));

    const host = new AppServerHost({
      createTransport: () => createStdioTransport({
        binaryPath: codexBinary,
        cwd: workingDir,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: 'test-key',
        },
      }),
      logger,
      clientInfo: { name: 'cindy-ask-contract-test', version: '0.0.0' },
    });
    cleanups.push(() => host.shutdown());

    const thread = await withTimeout(
      host.request<ThreadStartResponse>(Method.ThreadStart, {
        model: 'mock-model',
        modelProvider: 'mock_provider',
        cwd: workingDir,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        dynamicTools: [{
          namespace: 'cindy',
          name: 'ask_user_question',
          description: 'Collect a user choice.',
          inputSchema: {
            type: 'object',
            properties: { questions: { type: 'array' } },
            required: ['questions'],
            additionalProperties: false,
          },
        }],
      }, { timeoutMs: 20_000 }),
      25_000,
      'thread/start',
    );

    let resolveTurnCompleted!: () => void;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    const dynamicCalls: unknown[] = [];
    const subscription = host.subscribeThread(thread.thread.id, {
      turnCompleted: () => resolveTurnCompleted(),
      dynamicToolCall: async (params) => {
        dynamicCalls.push(params);
        return {
          contentItems: [{ type: 'inputText', text: JSON.stringify(answerPayload) }],
          success: true,
        };
      },
    });
    cleanups.push(() => subscription.release());

    await withTimeout(
      host.request(Method.TurnStart, {
        threadId: thread.thread.id,
        input: [{ type: 'text', text: 'Ask for the decision through functions.exec.' }],
      }, { timeoutMs: 20_000 }),
      25_000,
      'turn/start',
    );
    await withTimeout(turnCompleted, 25_000, 'turn/completed');

    expect(dynamicCalls).toEqual([
      expect.objectContaining({
        namespace: 'cindy',
        tool: 'ask_user_question',
      }),
    ]);
    expect(responseBodies).toHaveLength(2);
    const input = responseBodies[1]?.input;
    expect(Array.isArray(input)).toBe(true);
    const execOutput = (input as Array<Record<string, unknown>>).find((item) => (
      item.type === 'custom_tool_call_output' && item.call_id === 'exec-call-1'
    ));
    expect(execOutput).toBeDefined();
    const output = execOutput?.output;
    expect(Array.isArray(output)).toBe(true);
    const emittedTexts = (output as Array<Record<string, unknown>>)
      .filter((item) => item.type === 'input_text' && typeof item.text === 'string')
      .map((item) => item.text as string);
    const directResult = JSON.parse(emittedTexts.at(-1) ?? '') as Record<string, unknown>;
    expect(directResult).toEqual({
      type: 'string',
      parsed: answerPayload,
      contentIsUndefined: true,
      structuredContentIsUndefined: true,
    });
  }, 40_000);
});
