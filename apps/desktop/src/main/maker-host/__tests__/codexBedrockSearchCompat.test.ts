import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy, type ProxyHandle } from '@cindy/anthropic-compat-proxy';
import { createCodexBedrockSearchCompatibilityRule } from '../codex-bedrock-search-compat.js';

const rejection = JSON.stringify({ error: {
  message: `litellm.BadRequestError: BedrockException - {"message":"tool type 'web_search_20250305' is not supported for this model"}`,
  type: null, param: null, code: '400',
} });
const pluginTool = { type: 'function', name: 'connect_account', parameters: { type: 'object' } };
const body = {
  model: 'claude-opus-5',
  instructions: 'Answer with the tools available to you.',
  input: [{ role: 'user', content: 'Search my plugin documents.' }],
  tools: [{ type: 'web_search' }, pluginTool],
  tool_choice: 'auto',
  stream: true,
};
const rule = createCodexBedrockSearchCompatibilityRule();
const strip = (request: unknown) => {
  const result = rule.strip(Buffer.from(JSON.stringify(request)));
  return result ? JSON.parse(result.toString('utf8')) : null;
};

describe('Codex Bedrock hosted search compatibility', () => {
  it('recognizes the actual rejection including a nested escaped envelope', () => {
    expect(rule.matches(rejection)).toBe(true);
    expect(rule.matches(JSON.stringify({ message: rejection }))).toBe(true);
    expect(rule.applyOnUnmatchedRetry).toBe(false);
    expect(rule.allowExtraRules).toBe(false);
  });

  it.each([
    'BedrockException - model is not supported',
    "BedrockException - tool type 'computer_20250124' is not supported for this model",
    "tool type 'web_search_20250305' is not supported for this model",
    "BedrockException - tool type 'web_search_20250305' requires authorization",
  ])('does not classify a different rejection: %s', (message) => {
    expect(rule.matches(message)).toBe(false);
  });

  it.each(['web_search', 'web_search_preview', 'web_search_preview_2025_03_11'])(
    'removes only the rejected optional hosted declaration %s', (type) => {
      const request = { ...body, tools: [{ type }, pluginTool, { type: 'function', name: 'web_search' }] };
      expect(strip(request)).toEqual({ ...request, tools: request.tools.slice(1) });
      expect(request.tools[0]).toEqual({ type });
    },
  );

  it.each(['required', { type: 'web_search' }, { type: 'function', name: 'connect_account' }, {
    type: 'allowed_tools', mode: 'auto', tools: [{ type: 'web_search' }],
  }])('preserves explicit tool choice %j', (tool_choice) => {
    expect(strip({ ...body, tool_choice })).toBeNull();
  });

  it('declines search-only, clean, Messages and malformed requests', () => {
    expect(strip({ ...body, tools: [{ type: 'web_search' }] })).toBeNull();
    expect(strip({ ...body, tools: [pluginTool] })).toBeNull();
    expect(strip({ ...body, messages: [] })).toBeNull();
    expect(strip({ tools: body.tools })).toBeNull();
    expect(rule.strip(Buffer.from('{bad'))).toBeNull();
  });
});

describe('real loopback forwarding with the existing bounded recovery path', () => {
  let proxy: ProxyHandle | undefined;
  let upstream: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    await proxy?.dispose();
    proxy = undefined;
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      upstream = undefined;
    }
  });

  async function run(handler: (index: number, res: ServerResponse) => void) {
    const requests: unknown[] = [];
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      handler(requests.length, res);
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.once('error', reject);
      upstream!.listen(0, '127.0.0.1', resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    const unrelatedStrip = vi.fn(() => Buffer.from('{"input":"must not replace history"}'));
    proxy = await createAnthropicCompatProxy({
      upstream: `http://127.0.0.1:${address.port}`,
      transformRequest: [],
      recoveryRules: [rule, { id: 'unrelated', enabled: () => true, matches: () => false, strip: unrelatedStrip }],
    });
    const response = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, requests, unrelatedStrip };
  }

  it('retries one rejected request with the same model/history and plugin tool', async () => {
    const result = await run((index, res) => {
      res.writeHead(index === 1 ? 400 : 200, {
        'content-type': index === 1 ? 'application/json' : 'text/event-stream',
      });
      res.end(index === 1 ? rejection : 'data: {"type":"response.completed"}\n\n');
    });
    expect(result.status).toBe(200);
    expect(result.requests).toEqual([body, { ...body, tools: [pluginTool] }]);
    expect(result.unrelatedStrip).not.toHaveBeenCalled();
  });

  it('returns the second rejection instead of retrying again', async () => {
    const result = await run((_index, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(rejection);
    });
    expect(result.status).toBe(400);
    expect(result.requests).toHaveLength(2);
    expect(result.text).toBe(rejection);
  });

  it.each([200, 401, 403, 500])('does not replay status %s even if its body mentions the error', async (status) => {
    const result = await run((_index, res) => {
      res.writeHead(status, { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' });
      res.end(status === 200 ? `data: ${rejection}\n\n` : rejection);
    });
    expect(result.status).toBe(status);
    expect(result.requests).toEqual([body]);
  });
});
