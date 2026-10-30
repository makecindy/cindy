import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';

// Execute the generated extension's actual client and registered gateway. Pi
// loads this standalone source, so importing a parallel client would miss bugs.
const source = CINDY_BRIDGE_EXTENSION_SOURCE;
const hookStart = source.indexOf("  pi.on('tool_call', async");
const hookEnd = source.indexOf('\n  });', hookStart) + '\n  });'.length;
const compiled = ts.transpileModule(
  source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('// Pi 内置 find 依赖 fd'))
    + '\nglobalThis.Client = McpHttpClient; globalThis.Gateway = CindyMcpGateway; globalThis.connect = connectServer;'
    + '\nglobalThis.installApproval = (mcpGateway, pi) => {' + source.slice(hookStart, hookEnd) + '\n};',
  { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
).outputText;

function gatewayWithFetch(fetchImpl: typeof fetch) {
  const context: Record<string, any> = {
    fetch: fetchImpl, URL, Headers, AbortController, TextDecoder, process: { env: {} },
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    setTimeout, clearTimeout, createHash,
    guestToolGate: null, toolsDisabledForTurn: () => false,
    currentPermissionState: () => ({ mode: 'ask' }),
    FILE_WRITE_BUILTINS: new Set(), READONLY_BUILTINS: new Set(),
    CINDY_HOSTED: null, SUBAGENT_RUN_DIR_ENV: 'fixture-run-dir',
    resolveFileWriteTargetPath: () => null, isCindyShellTool: () => false,
    resolvedCredentialEvidenceForHost: () => [],
    PERMISSION_TITLE: 'permission', PERMISSION_ALLOW: 'allow',
  };
  runInNewContext(compiled, context);
  // These unit cases inject fetch to verify response and cancellation semantics
  // on the HTTPS path. Loopback uses a direct socket and is covered by real Pi integration.
  const client = new context.Client({ name: 'cindy', url: 'https://example.test/mcp' }, 'fake-token');
  client.finishStartup();
  const gateway = new context.Gateway();
  gateway.add('cindy', client, [{ name: 'ghost_call', inputSchema: {
    type: 'object', properties: { ghost_id: { type: 'string' } }, required: ['ghost_id'],
  } }]);
  const registered: any[] = [];
  const resultHooks: Array<(event: unknown) => unknown> = [];
  gateway.register({ registerTool: (tool: unknown) => registered.push(tool),
    on: (event: string, handler: (event: unknown) => unknown) => {
      if (event === 'tool_result') resultHooks.push(handler);
    },
  });
  registered.find(t => t.name === 'cindy_mcp_list_tools').execute('list', { server: 'cindy', tool: 'ghost_call' });
  const call = (signal?: AbortSignal) => registered.find(t => t.name === 'cindy_mcp_call_tool')
    .execute('call', { server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'demo' } }, signal);
  let approvalHook: any;
  context.installApproval(gateway, { on: (_event: string, handler: unknown) => { approvalHook = handler; } });
  return { call, gateway, client,
    approve: () => approvalHook({ toolName: 'cindy_mcp_call_tool', toolCallId: 'call',
      input: { server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'demo' } } },
      { ui: { input: async () => 'allow' } }),
    connect: () => context.connect({ name: 'cindy', url: 'https://example.test/mcp' }, 'fake-token'),
    resultHook: (event: unknown) => resultHooks[0]?.(event),
    list: (params: unknown = {}, signal?: AbortSignal) => registered.find(t => t.name === 'cindy_mcp_list_tools').execute('list', params, signal) };
}

afterEach(() => vi.useRealTimers());

describe('Pi MCP request lifecycle', () => {
  // r4411121969: previous recovery tests changed definitions inside execute;
  // this unit drives the real approval hook before a preceding discovery replaces it.
  it('rejects a changed definition discovered after approval and permits a freshly approved call', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ result: { content: [{ type: 'text', text: 'ok' }] } }));
    const h = gatewayWithFetch(fetchImpl);
    await h.approve();
    h.client.needsReconnect = true;
    h.gateway.registerReconnect('cindy', async () => ({ client: h.client,
      tools: [{ name: 'ghost_call', description: 'New operation', inputSchema: { type: 'object' } }],
    }));
    await h.list({ server: 'cindy', tool: 'ghost_call' });
    await expect(h.call()).rejects.toThrow('tool definition changed');
    expect(fetchImpl).not.toHaveBeenCalled();
    h.client.needsReconnect = false;
    await h.approve();
    await expect(h.call()).resolves.toMatchObject({ content: [{ text: 'ok' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // r4411121974: a clean SSE EOF without this request's response must invalidate
  // the connection, unlike a completed matching response on an open stream.
  it('recovers on discovery immediately after an SSE stream ends without its response', async () => {
    const h = gatewayWithFetch(vi.fn(async () => new Response('data: {"method":"notifications/progress"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } })));
    const connect = vi.fn(async () => ({ client: h.client, tools: [{ name: 'ready' }] }));
    h.gateway.registerReconnect('cindy', connect);
    await expect(h.call()).rejects.toThrow('invalid SSE response');
    expect(h.client.needsReconnect).toBe(true);
    expect((await h.list({ server: 'cindy' })).details.tools[0].name).toBe('ready');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  // A transport failure can follow a successful write. Recover the connection
  // for a later explicit request, without replaying that ambiguous operation.
  it('recovers a lost response on the next call with one handshake and no replay', async () => {
    const methods: string[] = [];
    let calls = 0;
    const h = gatewayWithFetch(vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      methods.push(body.method);
      if (body.method === 'tools/call' && ++calls === 1) throw { code: 'ECONNRESET' };
      return Response.json({ result: body.method === 'tools/list' ? { tools: [{ name: 'ghost_call', inputSchema: {
        type: 'object', properties: { ghost_id: { type: 'string' } }, required: ['ghost_id'],
      } }] } : { content: [{ type: 'text', text: 'ok' }] } });
    }));
    const connect = vi.fn(h.connect);
    h.gateway.registerReconnect('cindy', connect);
    await expect(h.call()).rejects.toThrow('not replayed');
    expect(methods).toEqual(['tools/call']);
    await Promise.all([h.call(), h.call()]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(methods).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
  });

  it('recovers an initially unavailable server through targeted discovery and cancels only one waiter', async () => {
    const h = gatewayWithFetch(vi.fn(async () => Response.json({ result: {
      content: [{ type: 'text', text: 'healthy server' }],
    } })));
    let finish!: (value: unknown) => void;
    const connect = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    h.gateway.registerReconnect('catalog', connect);
    h.gateway.markUnavailable('catalog', 'HTTP 503');
    await h.list();
    expect(connect).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancelled = h.list({ server: 'catalog' }, controller.signal);
    const waiting = h.list({ server: 'catalog' });
    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled');
    finish({ client: h.client, tools: [{ name: 'ready' }] });
    expect((await waiting).details.tools[0].name).toBe('ready');
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(h.call()).resolves.toMatchObject({ content: [{ text: 'healthy server' }] });
  });

  it.each(['changed', 'removed'])('does not dispatch an approved call when recovery returns a %s definition', async (mode) => {
    const fetchImpl = vi.fn(async () => { throw { code: 'ECONNRESET' }; });
    const h = gatewayWithFetch(fetchImpl);
    h.gateway.registerReconnect('cindy', async () => ({ client: h.client,
      tools: mode === 'removed' ? [] : [{ name: 'ghost_call', inputSchema: { type: 'object' } }],
    }));
    await expect(h.call()).rejects.toThrow('ECONNRESET');
    await expect(h.call()).rejects.toThrow('tool definition changed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks an expired session for recovery while leaving authentication failures alone', async () => {
    let status = 200;
    const h = gatewayWithFetch(vi.fn(async () => Response.json({ result: {} }, {
      status, headers: status === 200 ? { 'mcp-session-id': 'fixture-session' } : {},
    })));
    await h.client.initialize();
    status = 401;
    await expect(h.call()).rejects.toThrow('HTTP 401');
    expect(h.client.needsReconnect).toBe(false);
    status = 404;
    await expect(h.call()).rejects.toThrow('HTTP 404');
    expect(h.client.needsReconnect).toBe(true);
  });

  it('bounds broad discovery, pages all tools, and inspects the full searchable description', async () => {
    const h = gatewayWithFetch(vi.fn());
    const description = 'Documentation '.repeat(200) + 'needle';
    h.gateway.add('catalog', h.client, Array.from({ length: 117 }, (_, i) => ({
      name: 'tool_' + String(i).padStart(3, '0'), description,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    })));
    const first = (await h.list()).details;
    expect(first.tools).toHaveLength(50);
    expect(first.total).toBe(118);
    expect(JSON.stringify(first).length).toBeLessThan(18000);
    const names = [...first.tools];
    let next = first.nextOffset;
    while (next !== undefined) {
      const page = (await h.list({ offset: next })).details;
      names.push(...page.tools);
      next = page.nextOffset;
    }
    expect(new Set(names.map(tool => tool.server + ':' + tool.name)).size).toBe(118);
    const search = (await h.list({ query: 'NEEDLE', server: 'catalog', offset: 100 })).details;
    expect(search.total).toBe(117);
    expect(search.tools).toHaveLength(17);
    const exact = (await h.list({ server: 'catalog', tool: 'tool_116' })).details;
    expect(exact.tools[0].description).toBe(description);
    expect(exact.tools[0].inputSchema.properties.value.type).toBe('string');
  });

  it.each([false, true])('keeps structured data model-visible (isError=%s) without exposing private metadata', async (isError) => {
    const structuredContent = { answer: 42, nextStep: 'retry-after-refresh' };
    const { call } = gatewayWithFetch(vi.fn(async () => Response.json({ result: {
      content: [], structuredContent, isError, _meta: { secret: 'client-only' },
    } })));
    const result = await call();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(structuredContent) }]);
    expect(result.details).toEqual(structuredContent);
    expect(Boolean(result.isError)).toBe(isError);
    expect(JSON.stringify(result)).not.toContain('client-only');
  });

  it('preserves ordered rich error content and appends missing structured data', async () => {
    const content = [
      { type: 'text', text: 'Failure screenshot follows' },
      { type: 'image', data: 'fixture-image', mimeType: 'image/png' },
      { type: 'text', text: 'The highlighted input needs correction' },
    ];
    const { call } = gatewayWithFetch(vi.fn(async () => Response.json({ result: {
      content, structuredContent: { field: 'email' }, isError: true,
    } })));
    await expect(call()).resolves.toMatchObject({
      isError: true, content: [...content, { type: 'text', text: '{"field":"email"}' }],
    });
  });

  it('marks only the failed call through the pre-0.99 tool_result hook, even after content projection', async () => {
    let calls = 0;
    const { call, resultHook } = gatewayWithFetch(vi.fn(async () => Response.json({ result: {
      content: [{ type: 'text', text: 'same content' }], isError: calls++ === 0,
    } })));
    const [failed, succeeded] = await Promise.all([call(), call()]);
    // Old Pi ignores execute-result isError; earlier result hooks may copy content.
    expect(resultHook({ content: [...failed.content], details: failed.details, isError: false }))
      .toEqual({ isError: true });
    // A native wrapper may handle the inner failure and return those same blocks.
    expect(resultHook({ content: failed.content, details: failed.details, isError: false }))
      .toBeUndefined();
    expect(resultHook({ content: succeeded.content, details: succeeded.details, isError: false }))
      .toBeUndefined();
    expect(resultHook({ content: [], details: {}, isError: true })).toBeUndefined();
  });

  it('does not duplicate structured data already serialized in a text block', async () => {
    const structuredContent = { answer: 42 };
    const content = [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }];
    const { call } = gatewayWithFetch(vi.fn(async () => Response.json({ result: { content, structuredContent } })));
    await expect(call()).resolves.toEqual({ content, details: structuredContent });
  });

  it.each([
    { content: [], expected: [{ type: 'text', text: '(empty result)' }] },
    { content: [{ type: 'text', text: 'unchanged' }], expected: [{ type: 'text', text: 'unchanged' }] },
    { content: [{ type: 'resource_link', uri: 'fixture://report', name: 'report' }],
      expected: [{ type: 'text', text: '{"type":"resource_link","uri":"fixture://report","name":"report"}' }] },
  ])('keeps the existing unstructured conversion for $content', async ({ content, expected }) => {
    const { call } = gatewayWithFetch(vi.fn(async () => Response.json({ result: { content } })));
    await expect(call()).resolves.toEqual({ content: expected, details: {} });
  });

  it('waits for card interaction beyond five minutes with one explicit deadline', async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const fetchImpl = vi.fn((_url, options) => {
      expect(options.timeout).toBe(false);
      return new Promise<Response>(resolve => { complete = resolve; });
    });
    const { call } = gatewayWithFetch(fetchImpl);
    const result = call();
    await vi.advanceTimersByTimeAsync(301_000);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
    complete(Response.json({ result: { content: [{ type: 'text', text: 'clicked' }] } }));
    await expect(result).resolves.toMatchObject({ content: [{ text: 'clicked' }] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'timeout'] as const)('aborts an in-flight response on %s without blaming its arguments', async (action) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const bodyReady = new Promise<void>(resolve => { bodyStarted = resolve; });
    const { call } = gatewayWithFetch(vi.fn(async (_url, options) => {
      // Response headers arrived; body is still waiting for the tool.
      return { headers: new Headers(), ok: true, json: () => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('secret URL')), { once: true });
        bodyStarted();
      }) } as Response;
    }));
    const result = call(controller.signal);
    const assertion = expect(result).rejects.toThrow(action === 'cancel' ? 'request cancelled' : 'request timed out');
    await bodyReady;
    if (action === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(600_000);
    await assertion;
    await result.catch((error: Error) => {
      expect(error.message).not.toContain('schema');
      expect(error.message).not.toContain('secret');
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains only allowlisted transport codes, not messages or arbitrary causes', async () => {
    const { call } = gatewayWithFetch(vi.fn(async () => {
      throw Object.assign(new Error('https://secret-token@example.test'), {
        cause: { code: 'ECONNRESET', message: 'Authorization: secret' },
      });
    }));
    await expect(call()).rejects.toThrow('request failed (ECONNRESET)');
    await call().catch((error: Error) => {
      expect(error.message).not.toMatch(/secret|schema|example/);
    });
  });

  it('adds schema help only for the MCP invalid-parameters error code', async () => {
    const { call } = gatewayWithFetch(vi.fn(async () => Response.json({
      error: { code: -32602, message: 'untrusted upstream text' },
    })));
    await expect(call()).rejects.toThrow('Expected args schema:');
    const business = gatewayWithFetch(vi.fn(async () => Response.json({ result: {
      isError: true, content: [{ type: 'text', text: 'Plugin unavailable' }],
    } })));
    await expect(business.call()).resolves.toMatchObject({
      isError: true, content: [{ type: 'text', text: 'Plugin unavailable' }],
    });
  });
});
