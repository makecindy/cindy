import { Script } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mcpAppDirectSandboxDocument } from '../sandboxBridge.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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
  new Script(script).runInNewContext({ window, document, fetch, setTimeout, clearTimeout });
  return { handlers, parent, frame, fetch, pending };
}
it('ignores forged App requests and Host responses from the Renderer, relaying only the inner window', () => {
  const f = fixture();
  // G5: only add form events; top-navigation and popups remain sandboxed.
  expect(f.frame.setAttribute).toHaveBeenCalledWith('sandbox', 'allow-scripts allow-same-origin allow-forms');
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
it('still relays App readiness and size notifications to the Renderer and Host', async () => {
  const f = fixture();
  const messages = [
    { jsonrpc: '2.0', method: 'ui/notifications/initialized' },
    { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 420 } },
  ];
  for (const message of messages) {
    f.handlers.get('message')!({ source: f.frame.contentWindow, data: message });
    expect(f.parent.postMessage).toHaveBeenCalledWith(message, '*');
    if (message.method === 'ui/notifications/initialized') {
      f.pending[1]({ ok: true, json: async () => ({}) });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(JSON.parse(f.fetch.mock.calls.at(-1)![1].body)).toEqual({ op: 'message', message });
  }
  expect(f.parent.postMessage).toHaveBeenCalledTimes(2);
});

// Greptile 4427568732: a poll already on the wire can arrive after initialize.
// Real emitted bridge script, deferred network response, reused request ID.
it('drops in-flight old-document replies before posting to the new frame', async () => {
  const f = fixture();
  const receive = (data: unknown) => f.handlers.get('message')!({ source: f.frame.contentWindow, data });
  receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  receive({ jsonrpc: '2.0', id: 70, method: 'ui/initialize', params: {} });
  const old = { jsonrpc: '2.0', id: 70, error: { code: -1, message: 'old document' } };
  const current = { jsonrpc: '2.0', id: 70, result: { protocolVersion: '2026-01-26' } };
  f.pending[0]({ ok: true, json: async () => [
    { seq: 1, generation: 0, message: old }, { seq: 2, generation: 1, message: current },
  ] });
  for (let index = 0; index < 8; index++) await Promise.resolve();
  expect(f.frame.contentWindow.postMessage).not.toHaveBeenCalledWith(old, '*');
  expect(f.frame.contentWindow.postMessage).toHaveBeenCalledWith(current, '*');
});

// Codex 4427968303: Desktop owns RPC in the real proxy, bypassing Controller
// initialize handling. A replacement that never becomes ready must close, while
// same-generation retries cannot keep it alive. Unit tier, fake timers only.
it('bounds replacement initialization without extending the deadline for retries', () => {
  const f = fixture();
  const receive = (method: string) => f.handlers.get('message')!({ source: f.frame.contentWindow,
    data: { jsonrpc: '2.0', method, ...(method === 'ui/initialize' ? { id: 1, params: {} } : {}) } });
  receive('ui/notifications/initialized');
  f.parent.postMessage.mockClear();
  receive('ui/initialize');
  vi.advanceTimersByTime(44_000);
  receive('ui/initialize');
  expect(f.parent.postMessage).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_000);
  expect(f.parent.postMessage).toHaveBeenCalledExactlyOnceWith(
    { jsonrpc: '2.0', method: 'ui/notifications/sandbox-failed' }, '*');
});
it('clears a ready replacement deadline and gives the next document a fresh one', () => {
  const f = fixture();
  const receive = (method: string) => f.handlers.get('message')!({ source: f.frame.contentWindow,
    data: { jsonrpc: '2.0', method, ...(method === 'ui/initialize' ? { id: 1, params: {} } : {}) } });
  receive('ui/notifications/initialized');
  receive('ui/initialize');
  vi.advanceTimersByTime(44_000);
  receive('ui/notifications/initialized');
  receive('ui/initialize');
  f.parent.postMessage.mockClear();
  vi.advanceTimersByTime(1_000);
  expect(f.parent.postMessage).not.toHaveBeenCalled();
  vi.advanceTimersByTime(44_000);
  expect(f.parent.postMessage).toHaveBeenCalledExactlyOnceWith(
    { jsonrpc: '2.0', method: 'ui/notifications/sandbox-failed' }, '*');
});

// Codex 4429338500 also applies to concurrent local protocol fetches.
// Execute the production proxy: defer initialized delivery and let the new
// initialize overtake it if permitted. Unit tier, no real network/waits.
it('orders handshake fetches without blocking on outstanding tools', async () => {
  const f = fixture();
  const receive = (data: unknown) => f.handlers.get('message')!({ source: f.frame.contentWindow, data });
  let initialized = false;
  let acknowledge!: () => void;
  const current = { jsonrpc: '2.0', id: 72, result: { protocolVersion: '2026-01-26' } };
  f.fetch.mockImplementation(async (_url, input) => {
    const { message } = JSON.parse(input.body);
    if (message?.method === 'ui/notifications/initialized')
      return new Promise(resolve => { acknowledge = () => {
        initialized = true; resolve({ ok: true, json: async () => ({}) });
      }; });
    if (message?.method === 'ui/initialize') {
      f.pending[0]({ ok: true, json: async () => [
        { seq: 1, generation: initialized ? 1 : 0, message: current },
      ] });
      return { ok: true, json: async () => ({}) };
    }
    return new Promise(() => {});
  });
  receive({ jsonrpc: '2.0', id: 50, method: 'tools/call' });
  receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  receive({ jsonrpc: '2.0', id: 51, method: 'tools/call' });
  receive({ jsonrpc: '2.0', id: 72, method: 'ui/initialize' });
  acknowledge();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.frame.contentWindow.postMessage).toHaveBeenCalledWith(current, '*');
  expect(f.fetch.mock.calls.some(([, input]) => JSON.parse(input.body).message?.id === 51)).toBe(false);
});
it('reports one sandbox failure and stops messages queued behind a failed handshake', async () => {
  const f = fixture();
  const receive = (data: unknown) => f.handlers.get('message')!({ source: f.frame.contentWindow, data });
  receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  receive({ jsonrpc: '2.0', id: 73, method: 'ui/initialize' });
  receive({ jsonrpc: '2.0', id: 74, method: 'tools/call' });
  f.parent.postMessage.mockClear();
  f.pending[1]({ ok: false, json: async () => ({}) });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.parent.postMessage).toHaveBeenCalledExactlyOnceWith(
    { jsonrpc: '2.0', method: 'ui/notifications/sandbox-failed' }, '*');
  expect(f.fetch).toHaveBeenCalledTimes(2); // One poll and the failed handshake.
});

// 4429355993 / 4429359688: remote Desktop must still render legacy Host replies.
it('delivers replacement replies from a Host without generation fields', async () => {
  const f = fixture();
  const receive = (data: unknown) => f.handlers.get('message')!({ source: f.frame.contentWindow, data });
  receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  receive({ jsonrpc: '2.0', id: 75, method: 'ui/initialize' });
  const current = { jsonrpc: '2.0', id: 75, result: {} };
  f.pending[0]({ ok: true, json: async () => [{ seq: 1, message: current }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.frame.contentWindow.postMessage).toHaveBeenCalledWith(current, '*');
});

// 4429469516: the Main operation may finish after the proxy has changed documents.
it('does not report an old link result after document replacement', async () => {
  const f = fixture();
  f.pending[0]({ ok: true, json: async () => [
    { seq: 1, generation: 0, openLink: { id: 'link', url: 'https://example.org/' } },
  ] });
  await vi.advanceTimersByTimeAsync(0);
  const receive = (data: unknown) => f.handlers.get('message')!({ source: f.frame.contentWindow, data });
  receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  receive({ jsonrpc: '2.0', id: 77, method: 'ui/initialize' });
  f.pending[1]({ ok: true, json: async () => ({}) });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.fetch.mock.calls.some(([, input]) => JSON.parse(input.body).op === 'link-result')).toBe(false);
});
