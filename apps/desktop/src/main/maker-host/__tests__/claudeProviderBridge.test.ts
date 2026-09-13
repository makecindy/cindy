import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createClaudeProviderBridge } from '../claude-provider-bridge.js';

async function runBridge(protocol: 'openai-chat' | 'openai-responses', stream: boolean, upstream: string, onRequest: (url: string, init?: RequestInit) => void) {
  const handler = createClaudeProviderBridge({
    url: `https://supplier.example/v1/${protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`,
    protocol, headers: { authorization: 'Bearer fixture-supplier-key', 'x-api-key': 'fixture-supplier-key' },
    efforts: ['low', 'medium', 'high'], capabilities: { imageInput: 'image_url', reasoningField: 'reasoning_effort' },
    fetchImpl: async (url, init) => {
      onRequest(String(url), init);
      return new Response(upstream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      void handler.handle({ parsedBody: JSON.parse(Buffer.concat(chunks).toString()),
        ctx: { reqId: 1, method: 'POST', url: req.url!, headers: {} }, res,
        prefs: { reasoningEffort: 'high' },
      }).catch(() => { res.statusCode = 500; res.end(); });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-claude-subscription' },
      body: JSON.stringify({ model: 'test-model', stream, max_tokens: 8192,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
      }),
    });
    return { status: response.status, body: await response.text() };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const chatStream = [
  { id: 'chat-fixture', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
  { id: 'chat-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
].map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';

describe('Claude Code custom provider translation', () => {
  it.each([true, false])('translates chat requests and replies with streaming=%s', async stream => {
    const result = await runBridge('openai-chat', stream, chatStream, (url, init) => {
      expect(url).toBe('https://supplier.example/v1/chat/completions');
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ model: 'test-model', reasoning_effort: 'high', stream: true });
      expect(JSON.stringify(request.messages)).toContain('data:image/png;base64,AAAA');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-supplier-key' });
      expect(JSON.stringify(init?.headers)).not.toContain('fixture-claude-subscription');
      expect(JSON.stringify(init?.headers)).not.toContain('x-api-key');
    });
    expect(result.status).toBe(200);
    if (stream) { expect(result.body).toContain('message_stop'); expect(result.body).toContain('Hello'); }
    else expect(JSON.parse(result.body)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Hello' }] });
  });
});
