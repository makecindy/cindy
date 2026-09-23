import { sanitizeXaiTools } from '@cindy/model-compat';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnthropicCompatProxy, type ProxyHandle } from '@cindy/anthropic-compat-proxy';
import { clearCodexTextOnlyPolicies, codexTextOnlyRequestGuard, codexTextOnlyWebSocketTransforms, createCodexTextOnlyResponseGuard, isCodexTextOnly, registerCodexTextOnlyPolicy, validateCodexTextOnlyResponse } from '../codex-text-only-policy';

const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); clearCodexTextOnlyPolicies(); });
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  closers.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function proxy(options: Parameters<typeof createAnthropicCompatProxy>[0]): Promise<ProxyHandle> {
  const handle = await createAnthropicCompatProxy(options); closers.push(() => handle.dispose()); return handle;
}
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { id: 'r', output } });
const text = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] };
const tool = { type: 'function_call', name: 'exec_command', call_id: 'bad', arguments: '{}' };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

describe('Codex text-only request policy', () => {
  it.each([false, true, undefined])('keeps Lite welcome requests serial and restores ordinary tools (parallel=%s)', async parallel => {
    let disabled = true;
    const dispose = registerCodexTextOnlyPolicy('t', () => disabled); closers.push(dispose);
    const received: unknown[] = [];
    const upstream = await listen(createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      received.push(request);
      if (request.tools.length === 0 && request.parallel_tool_calls !== false) {
        res.writeHead(400); res.end('Responses Lite requires parallel_tool_calls=false'); return;
      }
      res.setHeader('content-type', 'text/event-stream'); res.end(frame(completed([text])));
    }));
    const handle = await proxy({ upstream: 'https://unused-gateway.invalid/v1',
      routingTransform: () => ({ upstreamOverride: upstream }),
      // Existing Gateway/xAI adapters can add hosted search after ingress.
      transformRequest: [body => Array.isArray((body as { tools?: unknown[] }).tools) && (body as { tools: unknown[] }).tools.length === 0
        ? { ...body as Record<string, unknown>, tools: [{ type: 'web_search' }], tool_choice: 'auto' } : null],
      requestGuard: ctx => codexTextOnlyRequestGuard(isCodexTextOnly('t'), ctx, base => base === upstream),
    });
    const body = { ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }), model: 'test', tools: [{ type: 'web_search' }, { type: 'function', name: 'exec_command' }], tool_choice: 'auto', input: [{ role: 'user', content: 'Hi' }] };
    await expect((await fetch(`${handle.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).text()).resolves.toContain('Hello');
    disabled = false;
    await (await fetch(`${handle.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).text();
    expect(received).toEqual([{ ...body, tools: [], tool_choice: 'none', parallel_tool_calls: false }, body]);
  });

  it.each([false, true, undefined])('preserves non-Lite empty-tool compatibility after xAI transforms (parallel=%s)', async parallel => {
    for (const hostedSearch of [false, true]) {
      const received: Record<string, unknown>[] = [];
      const upstream = await listen(createServer(async (req, res) => {
        let bytes = ''; for await (const chunk of req) bytes += chunk;
        const body = JSON.parse(bytes); received.push(body);
        if (body.tool_choice !== undefined || body.parallel_tool_calls !== undefined) {
          res.writeHead(400); res.end('Empty tools cannot have control fields'); return;
        }
        res.setHeader('content-type', 'text/event-stream'); res.end(frame(completed([text])));
      }));
      const handle = await proxy({ upstream: 'https://chatgpt.com/backend-api/codex',
        routingTransform: () => ({ upstreamOverride: upstream }),
        transformRequest: [body => {
          const sanitized = sanitizeXaiTools(body as Record<string, unknown>, {
            preserveNoneToolChoice: hostedSearch, preserveSerialToolCalls: hostedSearch,
          }) ?? body as Record<string, unknown>;
          return hostedSearch ? { ...sanitized, tools: [{ type: 'x_search' }] } : sanitized;
        }],
        requestGuard: ctx => codexTextOnlyRequestGuard(true, ctx, base => base === 'https://chatgpt.com/backend-api/codex'),
      });
      const body = { model: 'grok', tools: [{ type: 'web_search' }], tool_choice: 'auto',
        ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }) };
      const response = await fetch(`${handle.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Hello');
      expect(received).toEqual([{ model: 'grok', tools: [] }]);
    }
  });

  it.each([false, true])('blocks a tool returned against tool_choice even through a local adapter (%s)', async local => {
    let calls = 0;
    const upstream = await listen(createServer((_req, res) => {
      calls++; res.setHeader('content-type', 'text/event-stream'); res.end(frame(completed([tool])));
    }));
    const handle = await proxy({ upstream, transformRequest: [], bypassRequestTransforms: () => true,
      requestGuard: ctx => codexTextOnlyRequestGuard(true, ctx),
      ...(local ? { routingTransform: () => ({ localHandler: async ({ parsedBody, res }) => {
        expect(parsedBody).toMatchObject({ tools: [], tool_choice: 'none' });
        res.setHeader('content-type', 'text/event-stream'); res.end(frame(completed([tool])));
      } }) } : {}),
    });
    await expect((async () => {
      const res = await fetch(`${handle.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: [{ type: 'web_search' }] }) });
      return res.text();
    })()).rejects.toThrow();
    expect(calls).toBe(local ? 0 : 1);
  });

  it('streams complete text frames before the response ends and rejects a later tool before delivery', async () => {
    const stream = createCodexTextOnlyResponseGuard('text/event-stream');
    const output: string[] = []; stream.on('data', chunk => output.push(chunk.toString()));
    const first = frame({ type: 'response.output_text.delta', delta: '你好' });
    const bytes = Buffer.from(first);
    for (const byte of bytes) stream.write(Buffer.from([byte]));
    expect(output.join('')).toBe(first);
    const error = once(stream, 'error');
    stream.write(frame({ type: 'response.output_item.added', item: tool }));
    await error;
    expect(output.join('')).not.toContain('exec_command');
  });

  it.each(['function_call', 'custom_tool_call', 'web_search_call', 'image_generation_call', 'mcp_call', 'computer_call', 'local_shell_call'])('rejects %s in both incremental and completed output', type => {
    expect(() => validateCodexTextOnlyResponse({ type: 'response.output_item.added', item: { type } })).toThrow();
    expect(() => validateCodexTextOnlyResponse(completed([{ type }]))).toThrow();
  });

  it('does not release an in-flight guard when local state changes, and protects a replacement registration', async () => {
    let disabled = true;
    const old = registerCodexTextOnlyPolicy('frozen', () => disabled);
    const guard = codexTextOnlyRequestGuard(isCodexTextOnly('frozen'), { method: 'POST', url: '/responses', headers: {} })!;
    disabled = false;
    expect(JSON.parse(guard.transformBody(Buffer.from('{"tools":[{}]}')).toString()).tools).toEqual([]);
    const replacement = registerCodexTextOnlyPolicy('frozen', () => true); closers.push(replacement);
    old(); expect(isCodexTextOnly('frozen')).toBe(true);
  });
});


it.each([false, true, undefined])('enforces Lite welcome and normal requests on the same fragmented WebSocket (parallel=%s)', async parallel => {
  let disabled = true;
  const received: Array<Record<string, unknown>> = [];
  const http = createServer();
  const upstream = await listen(http);
  const sockets = new WebSocketServer({ server: http, perMessageDeflate: true });
  closers.push(() => { for (const client of sockets.clients) client.terminate(); sockets.close(); });
  sockets.on('connection', socket => socket.on('message', data => {
    const body = JSON.parse(data.toString()); received.push(body);
    if (body.tools.length === 0 && body.parallel_tool_calls !== false) {
      socket.send(JSON.stringify({ type: 'error', error: { message: 'Responses Lite requires parallel_tool_calls=false' } })); return;
    }
    socket.send(JSON.stringify(completed([body.tools.length === 0 ? text : tool])));
  }));
  const handle = await proxy({ upstream, resolveWebSocketUpstream: () => upstream,
    webSocketTransforms: () => codexTextOnlyWebSocketTransforms(() => disabled, true),
  });
  const client = new WebSocket(`${handle.url.replace('http:', 'ws:')}/responses`, { perMessageDeflate: true });
  closers.push(() => client.terminate());
  await once(client, 'open');
  expect(client.extensions).toBe('');
  const body = JSON.stringify({ ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }), type: 'response.create', model: 'test', tools: [{ type: 'web_search' }] });
  let response = once(client, 'message');
  client.send(body.slice(0, 30), { fin: false }); client.ping('alive'); client.send(body.slice(30), { fin: true });
  expect(JSON.parse(String((await response)[0]))).toEqual(completed([text]));
  disabled = false;
  response = once(client, 'message'); client.send(body);
  expect(JSON.parse(String((await response)[0]))).toEqual(completed([tool]));
  expect(received[0]).toMatchObject({ tools: [], tool_choice: 'none', parallel_tool_calls: false });
  expect(received[1]).toEqual(JSON.parse(body));
});

it('closes a WebSocket without forwarding a forbidden response, even after the local flag changes', async () => {
  let disabled = true;
  const http = createServer(); const upstream = await listen(http);
  const sockets = new WebSocketServer({ server: http });
  closers.push(() => { for (const client of sockets.clients) client.terminate(); sockets.close(); });
  sockets.on('connection', socket => socket.on('message', () => {
    disabled = false;
    socket.send(JSON.stringify({ type: 'response.output_item.added', item: tool }));
  }));
  const handle = await proxy({ upstream, resolveWebSocketUpstream: () => upstream,
    webSocketTransforms: () => codexTextOnlyWebSocketTransforms(() => disabled, true),
  });
  const client = new WebSocket(`${handle.url.replace('http:', 'ws:')}/responses`);
  closers.push(() => client.terminate()); await once(client, 'open');
  const messages: unknown[] = []; client.on('message', data => messages.push(data));
  const closed = once(client, 'close');
  client.send(JSON.stringify({ type: 'response.create', tools: [] }));
  await closed; expect(messages).toEqual([]);
});


it('retains denial for late native retries after closing a welcome, until the thread is reopened', () => {
  registerCodexTextOnlyPolicy('closing', () => true)();
  expect(isCodexTextOnly('closing')).toBe(true);
  const reopened = registerCodexTextOnlyPolicy('closing', () => false);
  expect(isCodexTextOnly('closing')).toBe(false);
  reopened(); expect(isCodexTextOnly('closing')).toBe(false);
});

it('keeps valid local-adapter text output and JSON responses intact', async () => {
  for (const stream of [true, false]) {
    const handle = await proxy({ upstream: null, transformRequest: [],
      requestGuard: ctx => codexTextOnlyRequestGuard(true, ctx),
      routingTransform: () => ({ localHandler: async ({ res }) => {
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
        res.end(stream ? frame(completed([text])) : JSON.stringify({ object: 'response', output: [text] }));
      } }),
    });
    const response = await fetch(`${handle.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(await response.text()).toContain('Hello');
  }
});


it('preserves upstream error details on restricted requests', async () => {
  const upstream = await listen(createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/problem+json' }); res.end('{"error":"quota exhausted"}');
  }));
  const handle = await proxy({ upstream, requestGuard: ctx => codexTextOnlyRequestGuard(true, ctx) });
  const response = await fetch(`${handle.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: 'quota exhausted' });
});
