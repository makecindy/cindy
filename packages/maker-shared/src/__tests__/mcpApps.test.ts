import { describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { mcpAppSandboxDocument, mcpAppFrameUrlAllowed, mcpAppHistoryText, parseMcpAppRecord, parseMcpAppHistory, projectMcpAppContent } from '../mcpApps.js';
describe('MCP Apps cross-platform document contract', () => {
  function proxy(resourceUrl?: string, requestedUrl = resourceUrl) {
    const attributes: Record<string, string> = {};
    const frame = {
      setAttribute: (name: string, value: string) => { attributes[name] = value; },
      style: {}, src: '', srcdoc: '', contentWindow: { postMessage: vi.fn() },
    };
    let receive!: (event: unknown) => void;
    let mounted = false;
    const window = {
      location: { href: 'http://127.0.0.1:5002/proxy.html' },
      parent: { postMessage: vi.fn() },
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === 'message') receive = listener;
      },
    };
    const document = { createElement: () => frame, body: { appendChild: () => { mounted = true; } } };
    const html = mcpAppSandboxDocument('', resourceUrl);
    const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    new Script(script).runInNewContext({ window, document, URL });
    receive({ source: window.parent, data: { jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { resourceUrl: requestedUrl, html: '<script>untrusted</script>' } } });
    window.parent.postMessage.mockClear();
    return { frame, mounted, attributes, window, receive };
  }
  it('pins the proxy resource URL to its Host-generated cross-origin document', () => {
    const result = proxy('http://127.0.0.1:5001/resource.html', 'http://127.0.0.1:5002/attack.html');
    expect(result.mounted).toBe(true);
    expect(result.frame.src).toBe('http://127.0.0.1:5001/resource.html');
    expect(result.frame.srcdoc).toBe('');
  });
  it.each(['http://127.0.0.1:5002/app.html', 'javascript:alert(1)', 'file:///private'])(
    'refuses a same-origin or privileged resource URL: %s', (url) => {
      expect(proxy(url).mounted).toBe(false);
    },
  );
  it('keeps an inline srcdoc App opaque rather than granting access to the proxy origin', () => {
    const result = proxy();
    expect(result.mounted).toBe(true);
    expect(result.frame.srcdoc).toBe('<script>untrusted</script>');
    expect(result.attributes.sandbox).toBe('allow-scripts');
  });
  it.each([
    ['http://127.0.0.1:5001/resource.html', 'http://127.0.0.1:5001'],
    ['cindy-mcp-app://example-view/resource', 'cindy-mcp-app://example-view'],
  ])('binds both RPC directions to the original resource origin: %s', (resourceUrl, origin) => {
    const result = proxy(resourceUrl);
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool' } };
    result.receive({ source: result.frame.contentWindow, origin, data: message });
    expect(result.window.parent.postMessage).toHaveBeenCalledExactlyOnceWith(message, '*');
    result.receive({ source: result.window.parent, data: { jsonrpc: '2.0', id: 1, result: { private: 'result' } } });
    expect(result.frame.contentWindow.postMessage).toHaveBeenCalledExactlyOnceWith(
      { jsonrpc: '2.0', id: 1, result: { private: 'result' } }, origin,
    );
  });
  it.each(['https://frame.example.org', 'http://127.0.0.1:5002', 'null', undefined])(
    'rejects the original WindowProxy after navigation to another origin: %s', (origin) => {
      const result = proxy('http://127.0.0.1:5001/resource.html');
      result.receive({ source: result.frame.contentWindow, origin,
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool' } } });
      expect(result.window.parent.postMessage).not.toHaveBeenCalled();
    },
  );
  it('does not mistake a descendant or sibling for the App even when its origin matches', () => {
    const result = proxy('http://127.0.0.1:5001/resource.html');
    result.receive({ source: {}, origin: 'http://127.0.0.1:5001',
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool' } } });
    expect(result.window.parent.postMessage).not.toHaveBeenCalled();
    expect(result.frame.contentWindow.postMessage).not.toHaveBeenCalled();
  });
  it('escapes native bridge keys without changing their JavaScript value', () => {
    const key = '</script><script>attack</script>';
    const html = mcpAppSandboxDocument(key);
    expect(html).not.toContain(key);
    expect(html.match(/<script>/gi)).toHaveLength(1);
    const encoded = html.match(/const bridgeKey=(.*?);/s)![1];
    expect(JSON.parse(encoded)).toBe(key);
  });
  it('denies undeclared native navigation and matches exact or wildcard domains', () => {
    expect(mcpAppFrameUrlAllowed('https://example.org')).toBe(false);
    expect(mcpAppFrameUrlAllowed('https://a.example.org', ['https://*.example.org'])).toBe(true);
    expect(mcpAppFrameUrlAllowed('https://example.org', ['https://*.example.org'])).toBe(false);
    expect(mcpAppFrameUrlAllowed('https://badexample.org', ['https://*.example.org'])).toBe(false);
    expect(mcpAppFrameUrlAllowed('https://a.example.org:9443', ['https://*.example.org:*'])).toBe(
      true,
    );
    expect(mcpAppFrameUrlAllowed('file:///private', ['https://example.org'])).toBe(false);
  });
  it('rejects malformed persisted cards while accepting additive fields', () => {
    const record = {
      version: 1,
      serverId: 'example',
      serverRevision: 'revision',
      resourceUri: 'ui://example/app',
      tool: { name: 'draft', inputSchema: { type: 'object' } },
      arguments: {},
      future: true,
    };
    expect(parseMcpAppRecord({ mcpApp: record })).toBe(record);
    expect(parseMcpAppRecord({ mcpApp: { ...record, arguments: [] } })).toBeUndefined();
    expect(
      parseMcpAppRecord({ mcpApp: { ...record, result: { content: 'invalid' } } }),
    ).toBeUndefined();
  });
  it('projects only saved public text blocks for read-only history', () => {
    const record = parseMcpAppRecord({ mcpApp: {
      version: 1, serverId: 'example', serverRevision: 'revision', resourceUri: 'ui://example/app',
      tool: { name: 'draft', inputSchema: { type: 'object' } }, arguments: { private: 'input' },
    } })!;
    expect(mcpAppHistoryText(record)).toBe('');
    record.result = {
      content: [
        { type: 'text', text: 'Saved result' },
        { type: 'image', data: 'private image' },
        { type: 'resource', resource: { text: 'embedded HTML' } },
        null, 'invalid', { type: 'text', text: 123 },
        { type: 'text', text: '<script>plain text</script>' },
      ],
      structuredContent: { private: 'structured' },
      _meta: { private: 'view-only' },
    };
    expect(mcpAppHistoryText(record)).toBe('Saved result\n\n<script>plain text</script>');
  });
  it('accepts public guest history for display without granting access to an App View', () => {
    const content = {
      mcpAppHistory: { version: 1, title: 'Draft form', text: 'Saved result' },
    };
    expect(parseMcpAppHistory(content)).toEqual({
      title: 'Draft form',
      text: 'Saved result',
    });
    expect(parseMcpAppRecord(content)).toBeUndefined();
    expect(
      parseMcpAppHistory({
        mcpAppHistory: { version: 1, title: 'Draft form', text: '' },
      }),
    ).toEqual({ title: 'Draft form', text: '' });
  });
  it.each([
    null,
    [],
    { version: 2, title: 'Draft', text: 'result' },
    { version: 1, title: {}, text: 'result' },
    { version: 1, title: 'Draft', text: {} },
  ])('rejects malformed public history %j', (mcpAppHistory) => {
    expect(parseMcpAppHistory({ mcpAppHistory })).toBeUndefined();
  });
  it('rebuilds public history without unknown private fields at any level', () => {
    const content = {
      mcpAppHistory: { version: 1, title: 'Draft', text: 'Saved', private: 'view-only' },
      private: { arguments: 'input' },
    };
    const expected = { mcpAppHistory: { version: 1, title: 'Draft', text: 'Saved' } };
    expect(projectMcpAppContent(content, true)).toEqual(expected);
    expect(projectMcpAppContent(JSON.stringify(content), true)).toEqual(expected);
    expect(content.mcpAppHistory.private).toBe('view-only');
  });
  it.each([
    { content: { mcpApp: { version: 2, private: 'view-only' } }, marked: true },
    { content: { mcpAppHistory: { version: 2, private: 'view-only' } }, marked: true },
    { content: { private: 'view-only' }, marked: true },
    { content: '{malformed private record', marked: true },
  ])('fails closed for malformed or unknown marked cards: %j', ({ content, marked }) => {
    expect(projectMcpAppContent(content, marked)).toEqual({ mcpAppHistory: { version: 1, title: '', text: '' } });
  });
  it('leaves ordinary message content untouched', () => {
    const content = { text: 'A user message', images: [{ url: 'example.png' }] };
    expect(projectMcpAppContent(content)).toBe(content);
    expect(projectMcpAppContent('ordinary text')).toBe('ordinary text');
  });
  it.each([
    { text: 'Ordinary structured result', mcpApp: null },
    { mcpApp: { version: 2, data: 'ordinary data' }, extra: 'preserve me' },
    { mcpAppHistory: { version: 1, title: 'User data', text: 'Saved', extra: 'preserve me' } },
    { mcpApp: {
      version: 1, serverId: 'example', serverRevision: 'revision', resourceUri: 'ui://example/app',
      tool: { name: 'draft', inputSchema: { type: 'object' } }, arguments: { ordinary: 'data' },
    } },
  ])('preserves App-shaped ordinary content without the Main-written marker: %j', (content) => {
    expect(projectMcpAppContent(content)).toBe(content);
    expect(projectMcpAppContent(content, false)).toBe(content);
    expect(projectMcpAppContent(JSON.stringify(content), false)).toBe(JSON.stringify(content));
  });
});
