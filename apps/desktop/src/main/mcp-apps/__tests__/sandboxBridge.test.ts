import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { mcpAppDirectSandboxDocument } from '../sandboxBridge.js';

function fixture() {
  const handlers = new Map<string, (event: unknown) => void>();
  const frame = {
    setAttribute: vi.fn(), style: {}, src: '',
    contentWindow: { postMessage: vi.fn() },
  };
  const parent = { postMessage: vi.fn() };
  const pending: Array<(response: { ok: boolean; json(): Promise<unknown> }) => void> = [];
  const fetch = vi.fn<(url: string, input: { body: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>>(() => new Promise((resolve) => pending.push(resolve)));
  const window = { parent, addEventListener: (name: string, callback: (event: unknown) => void) =>
    handlers.set(name, callback) };
  const document = { createElement: () => frame, body: { appendChild: vi.fn() } };
  const html = mcpAppDirectSandboxDocument('cindy-mcp-app://view-view/resource', 'cindy-mcp-app://view/bridge');
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  new Script(script).runInNewContext({ window, document, fetch });
  return { handlers, parent, frame, fetch, pending };
}
it('ignores forged App requests and Host responses from the Renderer, relaying only the inner window', () => {
  const f = fixture();
  const receive = f.handlers.get('message')!;
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'credentialed-tool' } };
  receive({ source: f.parent, data: call });
  receive({ source: f.parent, data: { jsonrpc: '2.0', id: 2, result: { forged: true } } });
  expect(f.fetch).toHaveBeenCalledOnce(); // The proxy's own Host poll only.
  expect(f.frame.contentWindow.postMessage).not.toHaveBeenCalled();
  receive({ source: f.frame.contentWindow, data: call });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.fetch.mock.calls[1][0]).toBe('cindy-mcp-app://view/bridge');
  expect(JSON.parse(f.fetch.mock.calls[1][1].body))
    .toEqual({ op: 'message', message: call });
  expect(f.parent.postMessage).not.toHaveBeenCalled();
  receive({ source: f.frame.contentWindow, data: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-escape' } });
  expect(f.parent.postMessage).not.toHaveBeenCalled();
});
it('gives the UI only display state while keeping Host results on the direct App transport', async () => {
  const f = fixture();
  const result = { jsonrpc: '2.0', id: 1, result: { private: 'tool-result' } };
  const size = { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 420 } };
  f.pending[0]({ ok: true, json: async () => [{ seq: 1, message: result }, { seq: 2, message: size }] });
  for (let index = 0; index < 8; index++) await Promise.resolve();
  expect(f.frame.contentWindow.postMessage).toHaveBeenCalledWith(result, '*');
  expect(f.frame.contentWindow.postMessage).toHaveBeenCalledWith(size, '*');
  expect(f.parent.postMessage).toHaveBeenCalledWith(size, '*');
  expect(f.parent.postMessage).toHaveBeenCalledOnce();
});
it('changes Renderer display state only from the Host poll, never from the App', async () => {
  const f = fixture();
  const context = { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { displayMode: 'fullscreen', theme: 'dark' } };
  f.handlers.get('message')!({ source: f.frame.contentWindow, data: context });
  expect(f.parent.postMessage).not.toHaveBeenCalled();
  f.pending[0]({ ok: true, json: async () => [{ seq: 1, message: context }] });
  for (let index = 0; index < 8; index++) await Promise.resolve();
  expect(f.parent.postMessage).toHaveBeenCalledExactlyOnceWith(context, '*');
  expect(f.frame.contentWindow.postMessage).toHaveBeenCalledExactlyOnceWith(context, '*');
});
it('still relays App readiness and size notifications to the Renderer and Host', () => {
  const f = fixture();
  const messages = [
    { jsonrpc: '2.0', method: 'ui/notifications/initialized' },
    { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 420 } },
  ];
  for (const message of messages) {
    f.handlers.get('message')!({ source: f.frame.contentWindow, data: message });
    expect(f.parent.postMessage).toHaveBeenCalledWith(message, '*');
    expect(JSON.parse(f.fetch.mock.calls.at(-1)![1].body)).toEqual({ op: 'message', message });
  }
  expect(f.parent.postMessage).toHaveBeenCalledTimes(2);
});
