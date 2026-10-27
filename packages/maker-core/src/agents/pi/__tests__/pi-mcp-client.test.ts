import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';

// Execute the generated extension's actual client and registered gateway. Pi
// loads this standalone source, so importing a parallel client would miss bugs.
const source = CINDY_BRIDGE_EXTENSION_SOURCE;
const compiled = ts.transpileModule(
  source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
    + '\nglobalThis.Client = McpHttpClient; globalThis.Gateway = CindyMcpGateway;',
  { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
).outputText;

function gatewayWithFetch(fetchImpl: typeof fetch) {
  const context: Record<string, any> = {
    fetch: fetchImpl, URL, Headers, AbortController, TextDecoder, process: { env: {} },
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    setTimeout, clearTimeout, createHash,
  };
  runInNewContext(compiled, context);
  const client = new context.Client({ name: 'cindy', url: 'http://127.0.0.1/mcp' }, 'fake-token');
  client.finishStartup();
  const gateway = new context.Gateway();
  gateway.add('cindy', client, [{ name: 'ghost_call', inputSchema: {
    type: 'object', properties: { ghost_id: { type: 'string' } }, required: ['ghost_id'],
  } }]);
  const registered: any[] = [];
  gateway.register({ registerTool: (tool: unknown) => registered.push(tool) });
  registered.find(t => t.name === 'cindy_mcp_list_tools').execute('list', { server: 'cindy', tool: 'ghost_call' });
  const call = (signal?: AbortSignal) => registered.find(t => t.name === 'cindy_mcp_call_tool')
    .execute('call', { server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'demo' } }, signal);
  return { call, gateway, client, list: (params: unknown = {}) => registered.find(t => t.name === 'cindy_mcp_list_tools').execute('list', params) };
}

afterEach(() => vi.useRealTimers());

describe('Pi MCP request lifecycle', () => {
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
    await expect(business.call()).rejects.toThrow(/^Plugin unavailable$/);
  });
});
