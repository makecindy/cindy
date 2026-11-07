import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAppController, type AppRpc } from '../mcpAppController.js';
const document = {
  viewId: 'view',
  html: '<html></html>',
  csp: "default-src 'none'",
  prefersBorder: true,
};
const never = () => new Promise<unknown>(() => {});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(poll: () => Promise<unknown> = never) {
  const invoke = vi.fn(
    async (_session: string, input: Record<string, unknown>): Promise<unknown> =>
      input.op === 'open' ? document : input.op === 'poll' ? poll()
        : input.op === 'authorize-link' ? { authorized: true, validForMs: 30_000 } : {},
  );
  const post = vi.fn(),
    state = vi.fn(),
    error = vi.fn(),
    link = vi.fn(async () => {});
  const controller = new McpAppController(invoke, 'task', 'card', post, state, error, link);
  return { controller, invoke, post, state, error, link };
}
function linkFixture(authorize: () => Promise<unknown>) {
  const poll = vi.fn()
    .mockResolvedValueOnce([{ seq: 1, openLink: { id: 'link', url: 'https://example.org/' } }])
    .mockImplementation(never);
  const f = fixture(poll);
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (session, input) =>
    input.op === 'authorize-link' ? authorize() : invoke(session, input));
  return f;
}
describe('MCP App transport lifecycle', () => {
  it('keeps local Desktop RPC out of the Renderer while retaining UI state and Host-owned teardown', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async (_session, input) => input.op === 'open'
      ? { viewId: 'view', transport: 'sandbox', prefersBorder: true } : {});
    expect(await f.controller.open({})).toEqual({ viewId: 'view', transport: 'sandbox', prefersBorder: true });
    f.controller.sandboxReady('cindy-mcp-app://forged/resource');
    f.controller.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 420 } });
    expect(f.invoke.mock.calls.map(([, input]) => input.op)).toEqual(['open']);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.state.mock.calls.map(([message]) => message.method)).toEqual([
      'ui/notifications/initialized', 'ui/notifications/size-changed',
    ]);
    f.controller.prepareNativeClose();
    await f.controller.close();
    expect(f.invoke).toHaveBeenLastCalledWith('task', { op: 'teardown', viewId: 'view', alreadyNotified: false });
  });
  it('relays initialization and complete HTML only after sandbox ready', async () => {
    const f = fixture();
    await f.controller.open({});
    f.controller.sandboxReady('cindy-mcp-app://view-view/resource');
    expect(f.post).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: document.html, resourceUrl: 'cindy-mcp-app://view-view/resource' },
      }),
    );
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    expect(f.invoke).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({
        op: 'message',
        message: expect.objectContaining({ method: 'ui/notifications/initialized' }),
      }),
    );
    await f.controller.close();
  });
  it.each([{ result: {} }, { error: { code: -32603, message: 'cleanup failed' } }])(
    'waits for the locally requested teardown response before releasing the View: %j',
    async (response) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.controller.open({});
      f.controller.sandboxReady();
      f.controller.prepareNativeClose();
      f.controller.prepareNativeClose();
      const requests = f.post.mock.calls
        .map(([message]) => message as AppRpc)
        .filter((message) => message.method === 'ui/resource-teardown');
      expect(requests).toHaveLength(1);
      const request = requests[0];
      const closed = vi.fn();
      const pending = f.controller.close().then(closed);
      const repeated = f.controller.close().then(closed);
      await flush();
      expect(closed).not.toHaveBeenCalled();
      expect(f.invoke.mock.calls.some(([, input]) => input.op === 'teardown')).toBe(false);

      f.controller.receive({ jsonrpc: '2.0', id: 'unrelated', result: {} });
      f.controller.receive(request);
      await vi.advanceTimersByTimeAsync(200);
      expect(closed).not.toHaveBeenCalled();
      expect(f.invoke.mock.calls.some(([, input]) => input.op === 'teardown')).toBe(false);

      f.controller.receive({ jsonrpc: '2.0', id: request.id, ...response });
      await Promise.all([pending, repeated]);
      expect(f.invoke).toHaveBeenLastCalledWith('task', {
        op: 'teardown', viewId: 'view', alreadyNotified: true,
      });
      expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'teardown')).toHaveLength(1);
      expect(f.state).not.toHaveBeenCalledWith(expect.objectContaining({ id: request.id }));
      expect(f.invoke).not.toHaveBeenCalledWith('task', expect.objectContaining({
        op: 'message', message: expect.objectContaining({ id: request.id }),
      }));
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('bounds an unresponsive local teardown from notification time and ignores late replies', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.open({});
    f.controller.sandboxReady();
    f.controller.prepareNativeClose();
    const request = f.post.mock.calls.at(-1)![0] as AppRpc;
    await vi.advanceTimersByTimeAsync(400);
    const pending = f.controller.close();
    await vi.advanceTimersByTimeAsync(599);
    expect(f.invoke.mock.calls.some(([, input]) => input.op === 'teardown')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.invoke).toHaveBeenLastCalledWith('task', {
      op: 'teardown', viewId: 'view', alreadyNotified: true,
    });
    const invocations = f.invoke.mock.calls.length;
    f.controller.receive({ jsonrpc: '2.0', id: request.id, result: {} });
    expect(f.invoke).toHaveBeenCalledTimes(invocations);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('continues routing the Host teardown handshake while closing without a local notification', async () => {
    let deliver!: (events: unknown) => void;
    const f = fixture(() => new Promise((resolve) => { deliver = resolve; }));
    await f.controller.open({});
    f.controller.sandboxReady();
    let release!: () => void;
    f.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = f.controller.close();
    await flush();
    const request: AppRpc = { jsonrpc: '2.0', id: 'host-teardown', method: 'ui/resource-teardown' };
    deliver([{ seq: 1, message: request }]);
    await flush();
    expect(f.post).toHaveBeenCalledWith(request);
    const response: AppRpc = { jsonrpc: '2.0', id: request.id, result: {} };
    f.controller.receive(response);
    expect(f.invoke).toHaveBeenCalledWith('task', { op: 'message', viewId: 'view', message: response });
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'teardown', viewId: 'view', alreadyNotified: false,
    });
    release();
    await pending;
  });
  it('closes a View that finishes opening after its card unmounts', async () => {
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn(
      async (_session: string, input: Record<string, unknown>) =>
        input.op === 'open' ? new Promise<unknown>((done) => {
          resolve = done;
        }) : {},
    );
    const controller = new McpAppController(invoke, 'task', 'card', vi.fn(), vi.fn(), vi.fn());
    const pending = controller.open({});
    await controller.close();
    invoke.mockResolvedValueOnce({});
    resolve(document);
    expect(await pending).toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith('task', { op: 'teardown', viewId: 'view' });
  });
  it('gives slow resource loading a separate initialization window', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.invoke.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return document;
    });
    const pending = f.controller.open({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toBe(document);
    expect(f.error).not.toHaveBeenCalled();
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.error).not.toHaveBeenCalled();
    await f.controller.close();
  });
  it('cancels the correlated open after a lost response without replaying it', async () => {
    const f = fixture();
    f.invoke.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
    await expect(f.controller.open({})).rejects.toThrow('INVOKE_TIMEOUT');
    const open = f.invoke.mock.calls[0][1];
    await f.controller.close();
    expect(f.invoke).toHaveBeenLastCalledWith('task', { op: 'cancel-open', openId: open.openId });
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'open')).toHaveLength(1);
  });
  it('handles trusted sandbox Escape through the display-mode operation', async () => {
    const f = fixture();
    await f.controller.open({});
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-escape' });
    expect(f.invoke).toHaveBeenLastCalledWith('task', { op: 'display-mode', viewId: 'view', mode: 'inline' });
    expect(f.state).not.toHaveBeenCalled();
    await f.controller.close();
  });
  it('times out initialization and releases the View without restarting a write', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.open({});
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.error).toHaveBeenCalledOnce();
    expect(String(f.error.mock.calls[0][0])).toContain('MCP_APP_INITIALIZATION_TIMEOUT');
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'open')).toHaveLength(1);
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'teardown')).toHaveLength(1);
  });
  it('retries only transient polling and never replays tools/call', async () => {
    vi.useFakeTimers();
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockImplementation(never);
    const f = fixture(poll);
    await f.controller.open({});
    f.controller.sandboxReady();
    const request: AppRpc = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'submit' },
    };
    f.controller.receive(request);
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'message')).toHaveLength(1);
    expect(f.error).not.toHaveBeenCalled();
    await f.controller.close();
  });
  it('fails closed immediately for a revoked Host and discards its polling loop', async () => {
    const f = fixture(async () => {
      throw new Error('MCP_APP_SERVER_CHANGED');
    });
    await f.controller.open({});
    await flush();
    expect(f.error).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'poll')).toHaveLength(1);
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'teardown')).toHaveLength(1);
  });
  it('consumes controller links without exposing host actions to the App', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce([{ seq: 1, openLink: { id: 'link', url: 'https://example.org/' } }])
      .mockImplementation(never);
    const f = fixture(poll);
    await f.controller.open({});
    f.controller.sandboxReady();
    await flush();
    expect(f.link).toHaveBeenCalledWith('https://example.org/');
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'link-result',
      viewId: 'view',
      linkId: 'link',
      success: true,
    });
    expect(f.post.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ openLink: expect.anything() }),
    );
    await f.controller.close();
  });
  it.each([
    'MCP_APP_CARD_UNAVAILABLE',
    'MCP_APP_VIEW_UNAVAILABLE',
    'MCP_APP_SERVER_CHANGED',
    'MCP_APP_INVALID_REQUEST',
    'INVOKE_TIMEOUT',
  ])('does not open a returned link when final Host authorization fails: %s', async (reason) => {
    const f = linkFixture(async () => { throw new Error(reason); });
    await f.controller.open({});
    await flush();
    expect(f.link).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'authorize-link', viewId: 'view', linkId: 'link',
    });
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'link-result', viewId: 'view', linkId: 'link', success: false,
    });
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'authorize-link')).toHaveLength(1);
    expect(f.error).not.toHaveBeenCalled();
    await f.controller.close();
  });
  it.each([{}, { authorized: false }, { authorized: true },
    { authorized: true, validForMs: 0 }, { authorized: true, validForMs: 30_001 }, null])(
    'requires an explicit Host authorization receipt before opening a link: %j',
    async (authorization) => {
      const f = linkFixture(async () => authorization);
      await f.controller.open({});
      await flush();
      expect(f.link).not.toHaveBeenCalled();
      expect(f.invoke).toHaveBeenCalledWith('task', {
        op: 'link-result', viewId: 'view', linkId: 'link', success: false,
      });
      await f.controller.close();
    },
  );
  it('waits for final execution-Host authorization before opening the link once', async () => {
    let authorize!: (value: unknown) => void;
    const f = linkFixture(() => new Promise((resolve) => { authorize = resolve; }));
    await f.controller.open({});
    await flush();
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'authorize-link', viewId: 'view', linkId: 'link',
    });
    expect(f.link).not.toHaveBeenCalled();
    authorize({ authorized: true, validForMs: 30_000 });
    await flush();
    expect(f.link).toHaveBeenCalledExactlyOnceWith('https://example.org/');
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'link-result', viewId: 'view', linkId: 'link', success: true,
    });
    await f.controller.close();
  });
  it('discards a late link authorization when the controller has closed', async () => {
    let authorize!: (value: unknown) => void;
    const f = linkFixture(() => new Promise((resolve) => { authorize = resolve; }));
    await f.controller.open({});
    await flush();
    await f.controller.close();
    authorize({ authorized: true, validForMs: 30_000 });
    await flush();
    expect(f.link).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.some(([, input]) => input.op === 'link-result')).toBe(false);
  });
  it('rejects an authorization response whose lease elapsed in transit', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    let authorize!: (value: unknown) => void;
    const f = linkFixture(() => new Promise((resolve) => { authorize = resolve; }));
    await f.controller.open({});
    await flush();
    elapsed = 30_000;
    authorize({ authorized: true, validForMs: 30_000 });
    await flush();
    expect(f.link).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'link-result', viewId: 'view', linkId: 'link', success: false,
    });
    await f.controller.close();
    vi.restoreAllMocks();
  });
  it('host display changes never synthesize View request IDs', async () => {
    const f = fixture();
    await f.controller.open({});
    await f.controller.displayMode('inline');
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'display-mode',
      viewId: 'view',
      mode: 'inline',
    });
    expect(f.post).not.toHaveBeenCalled();
    await f.controller.close();
  });
});

// Greptile 4427568732: the phone controller must discard a response already in transit.
it('ignores an old poll reply reusing the new document initialize ID', async () => {
  let reply!: (value: unknown) => void;
  const f = fixture(vi.fn().mockImplementationOnce(() => new Promise(resolve => { reply = resolve; })).mockImplementation(never));
  await f.controller.open({});
  f.controller.sandboxReady();
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  f.controller.receive({ jsonrpc: '2.0', id: 70, method: 'ui/initialize', params: {} });
  const old = { jsonrpc: '2.0', id: 70, error: { code: -1, message: 'old document' } };
  const current = { jsonrpc: '2.0', id: 70, result: { protocolVersion: '2026-01-26' } };
  reply([{ seq: 1, generation: 0, message: old }, { seq: 2, generation: 1, message: current }]);
  await flush();
  expect(f.error).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalledWith(old);
  expect(f.post).toHaveBeenCalledWith(current);
  await f.controller.close();
});
// A new viewer can poll an execution computer released before document generations.
it('delivers a legacy Host reply to a replacement document', async () => {
  let reply!: (value: unknown) => void;
  const f = fixture(vi.fn().mockImplementationOnce(() => new Promise(resolve => { reply = resolve; })).mockImplementation(never));
  await f.controller.open({});
  f.controller.sandboxReady();
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  f.controller.receive({ jsonrpc: '2.0', id: 71, method: 'ui/initialize', params: {} });
  const current = { jsonrpc: '2.0', id: 71, result: { protocolVersion: '2026-01-26' } };
  reply([{ seq: 1, message: current }]);
  await flush();
  expect(f.post).toHaveBeenCalledWith(current);
  await f.controller.close();
});

// Codex 4427748540: replacement initialization needs the same bounded failure as the first page.
it('times out a replacement document without extending its deadline for a retry', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.controller.open({});
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  f.controller.receive({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
  await vi.advanceTimersByTimeAsync(20_000);
  f.controller.receive({ jsonrpc: '2.0', id: 2, method: 'ui/initialize' });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(f.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'MCP_APP_INITIALIZATION_TIMEOUT' }));
  expect(f.invoke).toHaveBeenCalledWith('task', expect.objectContaining({ op: 'teardown' }));
  await f.controller.close();
});
it('ignores a cleared document timer that runs after a new initialization starts', async () => {
  vi.useFakeTimers();
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const f = fixture();
  await f.controller.open({});
  const oldTimeout = timer.mock.calls.at(-1)![0] as () => void;
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  f.controller.receive({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
  oldTimeout();
  expect(f.error).not.toHaveBeenCalled();
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(f.error).not.toHaveBeenCalled();
  await f.controller.close();
});

// Codex 4429338500: a delayed initialized delivery must precede the next initialize.
// Unit: exercise Controller.receive/poll with a reordered transport; prior fixtures
// acknowledged every message immediately and could not catch this lost response.
it('orders replacement handshakes without waiting for a pending tool call', async () => {
  let acknowledge!: () => void;
  let reply!: (value: unknown) => void;
  let hostInitialized = false;
  const f = fixture(vi.fn().mockImplementationOnce(() => new Promise(resolve => { reply = resolve; })).mockImplementation(never));
  const invoke = f.invoke.getMockImplementation()!;
  const current = { jsonrpc: '2.0', id: 72, result: { protocolVersion: '2026-01-26' } };
  f.invoke.mockImplementation(async (session, input) => {
    const message = input.message as AppRpc | undefined;
    if (message?.method === 'tools/call') return never();
    if (message?.method === 'ui/notifications/initialized')
      return new Promise<void>(resolve => { acknowledge = () => { hostInitialized = true; resolve(); }; });
    if (message?.method === 'ui/initialize') {
      reply([{ seq: 1, generation: hostInitialized ? 1 : 0, message: current }]);
      return {};
    }
    return invoke(session, input);
  });
  await f.controller.open({});
  f.controller.sandboxReady();
  f.controller.receive({ jsonrpc: '2.0', id: 50, method: 'tools/call' });
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  f.controller.receive({ jsonrpc: '2.0', id: 51, method: 'tools/call' });
  f.controller.receive({ jsonrpc: '2.0', id: 72, method: 'ui/initialize' });
  acknowledge();
  await flush();
  expect(f.post).toHaveBeenCalledWith(current);
  expect(f.error).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.some(([, input]) => (input.message as AppRpc)?.id === 51)).toBe(false);
  await f.controller.close();
});

// A rejected handshake must stop its queued followers and report/close just once;
// Vitest also rejects any unhandled promise rejection from those followers.
it('closes once when a handshake and its queued deliveries reject', async () => {
  let reject!: (error: Error) => void;
  const f = fixture();
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (session, input) =>
    input.op === 'message' ? new Promise((_resolve, fail) => { reject = fail; }) : invoke(session, input));
  await f.controller.open({});
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  f.controller.receive({ jsonrpc: '2.0', id: 73, method: 'ui/initialize' });
  f.controller.receive({ jsonrpc: '2.0', id: 74, method: 'tools/call' });
  reject(new Error('delivery failed'));
  await flush();
  expect(f.error).toHaveBeenCalledTimes(1);
  expect(f.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'delivery failed' }));
  expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'message')).toHaveLength(1);
  expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'teardown')).toHaveLength(1);
  await f.controller.close();
});

// 4429356002: authorizing a link can straddle replacement in the same View.
// Unit: real Controller entry, deferred Host authorization, observable open/result.
it('discards a link authorization that arrives after document replacement', async () => {
  let authorize!: (value: unknown) => void;
  const poll = vi.fn().mockResolvedValueOnce([{
    seq: 1, generation: 0, openLink: { id: 'old-link', url: 'https://example.org/' },
  }]).mockImplementation(never);
  const f = fixture(poll);
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (session, input) => input.op === 'authorize-link'
    ? new Promise(resolve => { authorize = resolve; }) : invoke(session, input));
  await f.controller.open({});
  await flush();
  f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  f.controller.receive({ jsonrpc: '2.0', id: 76, method: 'ui/initialize' });
  authorize({ authorized: true, validForMs: 30_000 });
  await flush();
  expect(f.link).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.some(([, input]) => input.op === 'link-result')).toBe(false);
  await f.controller.close();
});
