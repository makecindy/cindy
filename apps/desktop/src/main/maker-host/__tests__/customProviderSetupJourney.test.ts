/**
 * 自定义供应商最短配置旅程：Base URL + 假 API key → 获取模型 → 基础连接测试。
 *
 * 使用系统分配端口的 loopback server 覆盖常见 OpenAI/Anthropic Base URL 形态，
 * 不访问外网，也不读取开发者凭证或 userData。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchProviderModels } from '../provider-model-fetch.js';
import { runProviderProbe } from '../provider-diagnostics.js';

const FAKE_KEY = 'not-a-real-provider-key';

let origin = '';
let server: ReturnType<typeof createServer>;

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requireBearer(req: IncomingMessage): void {
  expect(req.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      requireBearer(req);
      if (url.pathname === '/apps/anthropic/v1/models') {
        expect(req.headers['x-api-key']).toBe(FAKE_KEY);
        expect(req.headers['anthropic-version']).toBe('2023-06-01');
      }
      json(res, { data: [{ id: `model:${url.pathname}`, name: 'Local test model' }] });
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      requireBearer(req);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/apps/anthropic/v1/messages') {
      requireBearer(req);
      expect(req.headers['x-api-key']).toBe(FAKE_KEY);
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      json(res, { content: [{ type: 'text', text: 'pong' }] });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `unexpected route: ${url.pathname}` } }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('loopback server did not expose a TCP address'));
        return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('custom provider minimal setup journey', () => {
  it.each([
    {
      label: 'OpenAI /v1',
      agent: 'codex' as const,
      baseUrl: () => `${origin}/v1`,
      wireProtocol: 'openai-chat' as const,
      expectedModelsPath: '/v1/models',
    },
    {
      label: 'Coding Plan compatible-mode/v1 with trailing slash',
      agent: 'codex' as const,
      baseUrl: () => `${origin}/compatible-mode/v1/`,
      wireProtocol: 'openai-chat' as const,
      expectedModelsPath: '/compatible-mode/v1/models',
    },
    {
      label: 'Anthropic apps endpoint',
      agent: 'claude-code' as const,
      baseUrl: () => `${origin}/apps/anthropic`,
      wireProtocol: 'anthropic-messages' as const,
      expectedModelsPath: '/apps/anthropic/v1/models',
    },
  ])(
    '$label gets a model and passes the first connection test',
    async ({ agent, baseUrl, wireProtocol, expectedModelsPath }) => {
      const models = await fetchProviderModels({
        agent,
        baseUrl: baseUrl(),
        authMethod: 'apiKey',
        apiKey: FAKE_KEY,
      });

      expect(models).toEqual({
        ok: true,
        models: [
          {
            id: `model:${expectedModelsPath}`,
            name: 'Local test model',
          },
        ],
      });

      const probe = await runProviderProbe({
        agent,
        baseUrl: baseUrl(),
        modelId: models.models![0]!.id,
        authMethod: 'apiKey',
        apiKey: FAKE_KEY,
        wireProtocol,
      });

      expect(probe.ok).toBe(true);
    },
  );
});
