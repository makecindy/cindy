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

function gatewayWithFetch(fetchImpl: typeof fetch, permissionMode = 'ask') {
  const context: Record<string, any> = {
    fetch: fetchImpl, URL, Headers, AbortController, TextDecoder, process: { env: {} },
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    setTimeout, clearTimeout, createHash,
    guestToolGate: null, toolsDisabledForTurn: () => false,
    currentPermissionState: () => ({ mode: permissionMode }),
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
  const approvals: unknown[] = [];
  const approveInput = (input: unknown, toolCallId = 'call') => approvalHook(
    { toolName: 'cindy_mcp_call_tool', toolCallId, input },
    { ui: { input: async (_title: string, body: string) => { approvals.push(JSON.parse(body)); return 'allow'; } } },
  );
  return { call, gateway, client,
    approvals, approveInput,
    invoke: (input: unknown, toolCallId = 'call') => registered.find(t => t.name === 'cindy_mcp_call_tool').execute(toolCallId, input),
    approve: () => approvalHook({ toolName: 'cindy_mcp_call_tool', toolCallId: 'call',
      input: { server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'demo' } } },
      { ui: { input: async () => 'allow' } }),
    connect: (server: { name: string; displayName?: string; url: string } = {
      name: 'cindy', url: 'https://example.test/mcp',
    }) => context.connect(server, 'fake-token'),
    resultHook: (event: unknown) => resultHooks[0]?.(event),
    list: (params: unknown = {}, signal?: AbortSignal) => registered.find(t => t.name === 'cindy_mcp_list_tools').execute('list', params, signal) };
}

afterEach(() => vi.useRealTimers());

// Native registration boundary: an unselected/isolated task installs no plugin
// listeners and cannot serialize tool data or send an extension UI request.
describe('Pi native plugin hook opt-in', () => {
  it.each([
    { points: '', guest: false, review: false, events: [] },
    { points: 'call', guest: false, review: false, events: ['tool_call'] },
    { points: 'result', guest: false, review: false, events: ['tool_result'] },
    { points: 'call,result', guest: true, review: false, events: [] },
    { points: 'call,result', guest: false, review: true, events: [] },
    { points: 'call,result', guest: false, review: false, events: ['tool_call', 'tool_result'] },
  ])('registers only the selected native points: $points/$guest/$review', async ({ points, guest, review, events }) => {
    const start = source.indexOf('  // Native plugin hooks run before');
    const end = source.indexOf('  // ── 权限门', start);
    const on = vi.fn();
    const stringify = vi.fn(JSON.stringify);
    const input = vi.fn(async () => '{}');
    const permission = vi.fn(() => ({ reviewOnly: review }));
    runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      process: { env: { CINDY_PI_TOOL_LIFECYCLE: points } },
      pi: { on }, guestToolGate: guest, currentPermissionState: permission,
      JSON: { stringify, parse: JSON.parse },
    });
    expect(on.mock.calls.map(([event]) => event)).toEqual(events);
    expect(stringify).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    if (!points) expect(permission).not.toHaveBeenCalled();
    if (events.includes('tool_call')) {
      const callback = on.mock.calls.find(([event]) => event === 'tool_call')![1];
      await callback({ toolName: 'read', toolCallId: 'call', input: { path: 'fixture.txt' } }, { ui: { input } });
      expect(input).toHaveBeenCalledOnce();
    }
  });
});

// Security regression: JSON __proto__ must remain an enumerable own property,
// rather than introducing an inherited path that later scanners cannot see.
it('keeps transformed Pi input as own JSON data without invoking prototype setters', async () => {
  const start = source.indexOf('  // Native plugin hooks run before');
  const end = source.indexOf('  // ── 权限门', start);
  let callback: ((event: { toolName: string; toolCallId: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>) | undefined;
  runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    process: { env: { CINDY_PI_TOOL_LIFECYCLE: 'call' } }, guestToolGate: null,
    currentPermissionState: () => ({ reviewOnly: false }),
    pi: { on: (_event: string, handler: typeof callback) => { callback = handler; } },
  });
  const input: Record<string, unknown> = { path: '/fixture/safe.txt' };
  const prototype = Object.getPrototypeOf(input);
  await callback!({ toolName: 'read', toolCallId: 'call', input }, { ui: {
    input: async () => '{"input":{"__proto__":{"path":"/fixture/.ssh/id_rsa"}}}',
  } });
  expect(Object.getPrototypeOf(input)).toBe(prototype);
  expect(input.path).toBeUndefined();
  expect(Object.entries(input)).toEqual([['__proto__', { path: '/fixture/.ssh/id_rsa' }]]);
});

describe('Pi MCP request lifecycle', () => {
  // #10691: the registered gateway and real approval hook must reject missing
  // ghost_id, including an extra args wrapper, before approval/HTTP. Previously
  // only generic call_tool envelopes were checked. Unit tier, injected fetch.
  it.each([
    { server: 'cindy', tool: 'ghost_info' },
    { server: 'cindy', tool: 'ghost_info', args: {} },
    { server: 'cindy', tool: 'ghost_info', args: { args: { ghost_id: 'calendar' } } },
  ])('explains invalid plugin parameters before approval or dispatch: %j', async input => {
    const fetchImpl = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ result: { content: [] } }));
    const h = gatewayWithFetch(fetchImpl);
    h.gateway.add('cindy', h.client, [{ name: 'ghost_info', inputSchema: {
      type: 'object', properties: { ghost_id: { type: 'string' } }, required: ['ghost_id'],
    } }]);
    await h.list({ server: 'cindy', tool: 'ghost_info' });
    await h.approveInput(input);
    await expect(h.invoke(input)).rejects.toThrow(/args\.ghost_id.*Expected args schema/);
    expect(h.approvals).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    const corrected = { server: 'cindy', tool: 'ghost_info', args: { ghost_id: 'calendar' } };
    await h.approveInput(corrected, 'corrected');
    await h.invoke(corrected, 'corrected');
    expect(h.approvals).toMatchObject([{ toolName: 'mcp__cindy__ghost_info', input: corrected.args }]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body)).params).toEqual({
      name: 'ghost_info', arguments: corrected.args,
    });
  });

  it.each(['ask', 'auto'])('does not authorize a skipped invalid invocation after schema recovery (%s)', async mode => {
    const fetchImpl = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ result: { content: [] } }));
    const h = gatewayWithFetch(fetchImpl, mode);
    const input = { server: 'cindy', tool: 'ghost_call', args: {} };
    await h.approveInput(input);
    h.gateway.add('cindy', h.client, [{ name: 'ghost_call', inputSchema: { type: 'object' } }]);
    await h.list({ server: 'cindy', tool: 'ghost_call' });
    await expect(h.invoke(input)).rejects.toThrow(/cindy_mcp_list_tools/);
    expect(h.approvals).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    await h.approveInput(input, 'fresh');
    await h.invoke(input, 'fresh');
    expect(h.approvals).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves legitimate nested plugin arguments and schema-declared args fields', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ result: { content: [] } }));
    const h = gatewayWithFetch(fetchImpl);
    h.gateway.add('cindy', h.client, [{ name: 'ghost_call', inputSchema: {
      type: 'object', properties: { ghost_id: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' } },
      required: ['ghost_id', 'tool'],
    } }]);
    await h.list({ server: 'cindy', tool: 'ghost_call' });
    const args = { ghost_id: 'calendar', tool: 'call_tool', args: { name: 'list_calendars', args: { include_hidden: false } } };
    await h.invoke({ server: 'cindy', tool: 'ghost_call', args });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body)).params.arguments).toEqual(args);
    h.gateway.add('custom', h.client, [{ name: 'nested', inputSchema: {
      type: 'object', properties: { args: { type: 'object' } }, required: ['args'],
    } }]);
    await h.list({ server: 'custom', tool: 'nested' });
    await h.invoke({ server: 'custom', tool: 'nested', args: { args: { value: 0 } } });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]!.body)).params.arguments).toEqual({ args: { value: 0 } });
  });

  it('discovers and resolves a custom MCP by display name without changing its id', async () => {
    const h = gatewayWithFetch(vi.fn(async () => Response.json({ result: { content: [{ type: 'text', text: 'ok' }] } })));
    h.gateway.add('4de87c18-f95d-4460-aeef-47aed2160c77', h.client, [{ name: 'probe' }], 'nowledge-mem');

    const listed = await h.list({ query: 'nowledge' });
    expect(listed.details.tools).toEqual([
      expect.objectContaining({
        server: 'nowledge-mem',
        serverId: '4de87c18-f95d-4460-aeef-47aed2160c77',
        name: 'probe',
      }),
    ]);
    const resolved = h.gateway.resolveCall({
      server: 'nowledge-mem', tool: 'probe', args: {},
    }) as { tool: { serverName: string } };
    expect(resolved.tool.serverName).toBe('4de87c18-f95d-4460-aeef-47aed2160c77');
  });

  // #10529: named aliases were covered, but an unnamed UUID still leaked into
  // discovery. Unit tier: real initialization, gateway tools and approval hook;
  // only HTTP is injected. Missing and whitespace-only metadata are both valid.
  it.each([undefined, '   '])('discovers and calls an unnamed UUID MCP with %j names', async emptyName => {
    const id = '4de87c18-f95d-4460-aeef-47aed2160c77';
    const displayName = '未命名 MCP (4de87c18)';
    const inputSchema = { type: 'object', properties: { value: { type: 'string' } } };
    const calls: unknown[] = [];
    const h = gatewayWithFetch(vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      if (body.method === 'initialize') return Response.json({ result: { serverInfo: { name: emptyName } } });
      if (body.method === 'tools/list') return Response.json({ result: { tools: [{ name: 'probe', inputSchema }] } });
      if (body.method === 'tools/call') calls.push(body.params);
      return Response.json({ result: { content: [{ type: 'text', text: 'ok' }] } });
    }));
    const connect = () => h.connect({ name: id, displayName: emptyName, url: 'https://example.test/mcp' });
    const connected = await connect();
    h.gateway.add(id, connected.client, connected.tools, connected.displayName);
    h.gateway.registerReconnect(id, connect);

    expect((await h.list({ query: '未命名 MCP' })).details.tools).toEqual([
      expect.objectContaining({ server: displayName, serverId: id, name: 'probe' }),
    ]);
    const input = { server: displayName, tool: 'probe', args: { value: 'example' } };
    await expect(h.invoke(input)).rejects.toThrow(/cindy_mcp_list_tools/);
    expect((await h.list({ server: displayName, tool: 'probe' })).details.tools[0].inputSchema).toEqual(inputSchema);
    await h.approveInput(input, 'alias');
    await expect(h.invoke(input, 'alias')).resolves.toMatchObject({ content: [{ text: 'ok' }] });
    // The alias and original ID share disclosure and the canonical approval identity.
    const byId = { ...input, server: id };
    await h.approveInput(byId, 'id');
    await h.invoke(byId, 'id');
    expect(h.approvals).toEqual([
      expect.objectContaining({ toolName: 'mcp__' + id + '__probe', input: input.args }),
      expect.objectContaining({ toolName: 'mcp__' + id + '__probe', input: input.args }),
    ]);
    expect(calls).toEqual(Array(2).fill({ name: 'probe', arguments: input.args }));

    h.gateway.markUnavailable(id, 'HTTP 503');
    expect((await h.list({ server: displayName })).details.tools).toEqual([
      expect.objectContaining({ server: displayName, serverId: id, name: 'probe' }),
    ]);
    expect(calls).toHaveLength(2); // Reconnecting must not replay a tool call.
  });

  it.each([
    { configured: ' configured ', protocol: 'protocol', expected: 'configured' },
    { configured: ' ', protocol: ' protocol ', expected: 'protocol' },
  ])('preserves name precedence during initialization: $expected', async ({ configured, protocol, expected }) => {
    const h = gatewayWithFetch(vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      return Response.json({ result: body.method === 'initialize'
        ? { serverInfo: { name: protocol } } : { tools: [{ name: 'probe' }] } });
    }));
    const id = '4de87c18-f95d-4460-aeef-47aed2160c77';
    const connected = await h.connect({ name: id, displayName: configured, url: 'https://example.test/mcp' });
    h.gateway.add(id, connected.client, connected.tools, connected.displayName);
    expect((await h.list({ server: expected })).details.tools).toEqual([
      expect.objectContaining({ server: expected, serverId: id, name: 'probe' }),
    ]);
  });

  it.each([
    { ids: ['mcp_one', 'mcp_two'], displayName: 'shared-name', alias: 'shared-name' },
    { ids: ['4de87c18-f95d-4460-aeef-47aed2160c77', '4de87c18-f95d-4460-aeef-47aed2160c78'],
      displayName: undefined, alias: '未命名 MCP (4de87c18)' },
  ])('rejects an ambiguous display name with the matching stable ids: $alias', async ({ ids, displayName, alias }) => {
    const h = gatewayWithFetch(vi.fn(async () => Response.json({ result: { content: [] } })));
    for (const id of ids) h.gateway.add(id, h.client, [{ name: 'probe' }], displayName);

    const result = await h.list({ server: alias });
    expect(result.details).toMatchObject({
      ok: false,
      errorCode: 'AMBIGUOUS_SERVER',
      matchingServerIds: ids,
    });
    for (const id of ids) {
      expect(h.gateway.resolveCall({ server: id, tool: 'probe', args: {} }).tool.serverName).toBe(id);
    }
  });

  it('reconnects an unavailable MCP when discovery uses its display name', async () => {
    const h = gatewayWithFetch(vi.fn(async () => Response.json({ result: { content: [] } })));
    h.gateway.add('mcp_uuid', h.client, [{ name: 'probe' }], 'readable-name');
    const reconnect = vi.fn(async () => ({
      client: h.client,
      tools: [{ name: 'probe' }],
      displayName: 'readable-name',
    }));
    h.gateway.registerReconnect('mcp_uuid', reconnect);
    h.gateway.markUnavailable('mcp_uuid', 'HTTP 503');

    const result = await h.list({ server: 'readable-name' });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(result.details.tools).toEqual([
      expect.objectContaining({ server: 'readable-name', serverId: 'mcp_uuid', name: 'probe' }),
    ]);
  });

  it('keeps stable ids authoritative when they collide with another display name', async () => {
    const h = gatewayWithFetch(vi.fn(async () => Response.json({ result: { content: [] } })));
    h.gateway.add('alpha', h.client, [{ name: 'first' }], 'First');
    h.gateway.add('beta', h.client, [{ name: 'second' }], 'alpha');

    const stable = h.gateway.resolveCall({ server: 'alpha', tool: 'first', args: {} }) as { tool: { serverName: string } };
    expect(stable.tool.serverName).toBe('alpha');
    expect(h.gateway.resolveCall({ server: 'alpha', tool: 'second', args: {} })).toBeNull();
    const beta = h.gateway.resolveCall({ server: 'beta', tool: 'second', args: {} }) as { tool: { serverName: string } };
    expect(beta.tool.serverName).toBe('beta');
  });

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
    const sent: any[] = [];
    const { call } = gatewayWithFetch(vi.fn(async (_url, options) => {
      const message = JSON.parse(options!.body as string);
      sent.push(message);
      if (message.method === 'notifications/cancelled') return new Response(null, { status: 202 });
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
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ method: 'notifications/cancelled', params: { requestId: sent[0].id } });
    await vi.advanceTimersByTimeAsync(0);
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
