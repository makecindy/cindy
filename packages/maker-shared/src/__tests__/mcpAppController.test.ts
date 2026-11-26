import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMcpAppOpenRejectedBeforeAllocation, McpAppController, McpAppViewSlots, McpAppWindowLimitError, type AppRpc } from '../mcpAppController.js';
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
    async (_session: string | null, input: Record<string, unknown>): Promise<unknown> =>
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
  // Unit: a card can scroll away between the grant and its next open. Exercise the controller
  // transport so one real release still reaches the second card without an extra executor call.
  it('passes an unused slot to the next visible card when the granted card leaves before reopening', async () => {
    const slots = new McpAppViewSlots();
    const attempts: { card: string; context: unknown }[] = [];
    let full = true;
    let refuseNext!: (error: Error) => void;
    const create = (card: string) => new McpAppController((_session, input) =>
      slots.control('owner', 'window', 'peer', input, async () => {
        if (input.op !== 'open') return {};
        attempts.push({ card, context: input.context });
        if (full && card === 'next') return new Promise((_resolve, reject) => { refuseNext = reject; });
        if (full) throw new Error('MCP_APP_VIEW_LIMIT');
        return { viewId: card, transport: 'sandbox' };
      }), 'task', card, vi.fn(), vi.fn(), vi.fn());
    const first = create('first');
    const next = create('next');
    const nextOpen = next.open({}, () => true); // Starts first, but receives its refusal second.
    const firstOpen = first.open({}, waiting => waiting);
    await flush();
    await next.context({ theme: 'dark' });
    refuseNext(new Error('MCP_APP_VIEW_LIMIT'));
    await flush();
    full = false;
    slots.released('owner', 'window', 'peer');
    await firstOpen;
    await flush();
    expect(attempts).toEqual([{ card: 'next', context: {} }, { card: 'first', context: {} },
      { card: 'next', context: { theme: 'dark' } }]);
    expect(await nextOpen).toMatchObject({ viewId: 'next' });
    await Promise.all([first.close(), next.close()]);
  });

  // PR #11917, unit: observe real queued open results and executor calls. A grant
  // that did not create a View may serve only cards refused before that release.
  it.each(['MCP_APP_SERVER_CHANGED', 'MCP_APP_TOOL_UNAVAILABLE', 'MCP_APP_RESOURCE_MISSING'])('returns a grant after definitive open failure %s', async reason => {
    const slots = new McpAppViewSlots();
    let full = true;
    const attempts: string[] = [];
    const control = (card: string, op: string) => slots.control('owner', 'window', 'peer', { op, openId: card }, async () => {
      attempts.push(card);
      if (full) throw new Error('MCP_APP_VIEW_LIMIT');
      if (card === 'first') throw new Error(reason);
      return { viewId: card };
    });
    for (const card of ['first', 'second']) await expect(control(card, 'open')).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    const first = control('first', 'wait-for-view-slot');
    const second = control('second', 'wait-for-view-slot').then(() => control('second', 'open'));
    full = false;
    slots.released('owner', 'window', 'peer');
    await first;
    await expect(control('first', 'open')).rejects.toThrow(reason);
    await flush();
    expect(attempts).toEqual(['first', 'second', 'first', 'second']);
    expect(await second).toEqual({ viewId: 'second' });
  });

  it.each(['MCP_APP_OPEN_TIMEOUT', 'MCP_APP_OPEN_CANCELLED'])('keeps the remote slot reserved after an ambiguous open failure %s', async reason => {
    const slots = new McpAppViewSlots();
    let full = true;
    const control = (card: string, op: string, send?: Parameters<McpAppViewSlots['control']>[4]) =>
      slots.control('owner', 'window', 'peer', { op, openId: card }, send ?? (async () => {
        if (full) throw new Error('MCP_APP_VIEW_LIMIT');
        return { viewId: card };
      }));
    await expect(control('first', 'open')).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    await expect(control('second', 'open')).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    const first = control('first', 'wait-for-view-slot', never);
    let secondResumed = false;
    const second = control('second', 'wait-for-view-slot', never).then(() => { secondResumed = true; });
    full = false;
    slots.released('owner', 'window', 'peer');
    await first;
    await expect(control('first', 'open', async () => { throw new Error(reason); })).rejects.toThrow(reason);
    await flush();
    expect(secondResumed).toBe(false);
    slots.cancelCaller('window');
    await second;
  });

  it.each([
    ['MCP_APP_SERVER_CHANGED', true],
    ['MCP_APP_TOOL_UNAVAILABLE', true],
    ['MCP_APP_TOOL_NOT_VISIBLE', true],
    ['MCP_APP_TOOL_LIST_TOO_LARGE', true],
    ['MCP_APP_CARD_UNAVAILABLE', true],
    ['MCP_APP_CARD_TOO_LARGE', true],
    ['MCP_APP_SOURCE_UNAVAILABLE', true],
    ['MCP_APP_VIEW_UNAVAILABLE', true],
    ['MCP_APP_SESSION_UNAVAILABLE', true],
    ['MCP_APP_RESOURCE_MISSING', true],
    ['MCP_APP_RESOURCE_NOT_FOUND', true],
    ['MCP_APP_RESOURCE_TOO_LARGE', true],
    ['MCP_APP_INVALID_RESOURCE', true],
    ['MCP_APP_INVALID_PAGINATION', true],
    ['MCP_APP_FILES_LOCAL_ONLY', true],
    ['MCP_APP_CONNECTION_CLOSED', true],
    ['MCP_APP_CONNECTION_LIMIT', true],
    ['MCP_PLUGIN_UNAVAILABLE', true],
    ['MCP_PLUGIN_CSP_DOMAIN_NOT_DECLARED', true],
    ['MCP_APP_OPEN_TIMEOUT', false],
    ['MCP_APP_OPEN_CANCELLED', false],
    ['DEVICE_LINK_TIMEOUT', false],
  ] as const)('classifies open outcome %s from the host lifecycle', (code, expected) => {
    expect(isMcpAppOpenRejectedBeforeAllocation(new Error(code))).toBe(expected);
  });

  it('preserves executor capacity when an open only gets as far as a local reservation', async () => {
    const slots = new McpAppViewSlots();
    const control = (card: string, op: string, send: Parameters<McpAppViewSlots['control']>[4]) =>
      slots.control('owner', 'window', 'peer', { op, openId: card }, send);
    await expect(control('first', 'open', async () => { throw new McpAppWindowLimitError('pending'); }))
      .rejects.toThrow('MCP_APP_VIEW_LIMIT');
    await expect(control('second', 'open', async () => { throw new Error('MCP_APP_VIEW_LIMIT'); }))
      .rejects.toThrow('MCP_APP_VIEW_LIMIT');
    const first = control('first', 'wait-for-view-slot', never);
    const openSecond = vi.fn(async () => document);
    const second = control('second', 'wait-for-view-slot', never).then(() => control('second', 'open', openSecond));
    slots.released('owner', 'window', 'peer', 'mounted');
    await first;
    await expect(control('first', 'open', async allocated => {
      allocated?.('pending');
      throw new Error('MCP_APP_SERVER_CHANGED');
    })).rejects.toThrow('MCP_APP_SERVER_CHANGED');
    await flush();
    expect(openSecond).toHaveBeenCalledOnce();
    await expect(second).resolves.toBe(document);
  });

  // Unit: window capacity is shared by its peers, and executor capacity by its windows.
  it.each([
    { name: 'executor is full before mounting the document', first: ['window', 'peer1'], second: ['window', 'peer2'],
      firstError: new McpAppWindowLimitError('document'), secondError: new McpAppWindowLimitError('document'),
      retryError: new Error('MCP_APP_VIEW_LIMIT'), releasedWindow: 'document' as const },
    { name: 'a different window is full before reaching the executor', first: ['other', 'peer'], second: ['window', 'peer'],
      firstError: new Error('MCP_APP_VIEW_LIMIT'), secondError: new McpAppWindowLimitError('pending'),
      retryError: new McpAppWindowLimitError('pending'), releasedWindow: 'mounted' as const },
  ])('preserves the unused window capacity when $name', async ({ first, second, firstError, secondError, retryError, releasedWindow }) => {
    const slots = new McpAppViewSlots();
    const control = ([caller, peer]: string[], op: string, send: () => Promise<unknown>) =>
      slots.control('owner', caller, peer, { op, openId: peer }, send);
    await expect(control(first, 'open', async () => { throw firstError; })).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    await expect(control(second, 'open', async () => { throw secondError; })).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    const firstWait = control(first, 'wait-for-view-slot', never);
    const openSecond = vi.fn(async () => document);
    const secondOpen = control(second, 'wait-for-view-slot', never).then(() => control(second, 'open', openSecond));
    slots.released('owner', second[0], second[1], releasedWindow);
    await firstWait;
    await expect(control(first, 'open', async () => { throw retryError; })).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    await flush();
    expect(openSecond).toHaveBeenCalledOnce();
    await expect(secondOpen).resolves.toBe(document);
  });

  it('does not spend stale releases on a card refused after the release', async () => {
    const slots = new McpAppViewSlots();
    const open = (card: string) => slots.control('owner', 'window', 'peer', { op: 'open', openId: card },
      async () => { throw new Error('MCP_APP_VIEW_LIMIT'); });
    const wait = (card: string) => slots.control('owner', 'window', 'peer',
      { op: 'wait-for-view-slot', openId: card }, async () => {});
    await expect(open('old')).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    const grant = wait('old');
    slots.released('owner', 'window', 'peer');
    await grant;
    slots.released('owner', 'window', 'peer');
    await slots.control('owner', 'window', 'peer', { op: 'open', openId: 'old' }, async () => ({ viewId: 'old' }));
    await expect(open('new')).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    const resumed = vi.fn();
    const pending = wait('new').then(resumed);
    await flush();
    expect(resumed).not.toHaveBeenCalled();
    slots.released('owner', 'window', 'peer');
    await pending;
    expect(resumed).toHaveBeenCalledWith(true);
  });

  // Regression: a slot can close after refusal but before the controller registers its wait.
  it('rechecks a slot released during the refusal-to-wait gap', async () => {
    const slots = new McpAppViewSlots();
    let openAttempts = 0;
    const controller = new McpAppController((_session, input) => slots.control(
      'owner', 'window', 'peer', input, async () => {
        if (input.op === 'open') {
          openAttempts++;
          if (openAttempts === 1) throw new Error('MCP_APP_VIEW_LIMIT');
          return { viewId: 'view', transport: 'sandbox' };
        }
        return {};
      }), 'task', 'card', vi.fn(), vi.fn(), vi.fn());
    const opened = controller.open({}, async waiting => {
      if (waiting) {
        slots.released('owner', 'window', 'peer');
        return true;
      }
      return true;
    });
    await expect(opened).resolves.toMatchObject({ viewId: 'view' });
    expect(openAttempts).toBe(2);
  });

  // Unit: a wait can outlive an explicit device close. A subsequent slot release must not reconnect it.
  it.each([false, true])('ends the wait on explicit device close without reconnecting (already granted: %s)', async granted => {
    const slots = new McpAppViewSlots();
    let epoch = 1;
    let closeLink!: () => void;
    const unsubscribe = vi.fn();
    const send = vi.fn(async () => { throw new Error('MCP_APP_VIEW_LIMIT'); });
    const controller = new McpAppController((_session, input) =>
      slots.control('owner', 'window', 'peer', input, send, epoch, closed => {
        closeLink = closed;
        return unsubscribe;
      }), 'task', 'card', vi.fn(), vi.fn(), vi.fn());
    const pending = controller.open({}, () => true);
    await flush();
    if (granted) slots.released('owner', 'window', 'peer');
    epoch++;
    closeLink();
    await expect(pending).rejects.toThrow('MCP_APP_LINK_CLOSED');
    expect(send).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps local Desktop RPC out of the Renderer while retaining UI state and Host-owned teardown', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async (_session, input) => input.op === 'open'
      ? { viewId: 'view', transport: 'sandbox', prefersBorder: true } : {});
    expect(await f.controller.open({})).toEqual({ viewId: 'view', transport: 'sandbox', prefersBorder: true });
    f.controller.sandboxReady('cindy-mcp-app://forged/resource');
    f.controller.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 420 } });
    expect(f.invoke.mock.calls.map(([, input]) => (input as { op: string }).op)).toEqual(['open']);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.state.mock.calls.map(([message]) => message.method)).toEqual([
      'ui/notifications/initialized', 'ui/notifications/size-changed',
    ]);
    f.controller.prepareNativeClose();
    await f.controller.close();
    expect(f.invoke).toHaveBeenLastCalledWith('task', { op: 'teardown', viewId: 'view', alreadyNotified: false });
  });
  // PR-E, unit: only an explicitly suspended Desktop sandbox uses local controls.
  // Observe invoke order and context suppression through the public controller.
  it('serializes local suspension and resume without polling or reopening', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async (_session, input) => input.op === 'open'
      ? { viewId: 'view', transport: 'sandbox', prefersBorder: true } : {});
    await f.controller.open({});
    const suspended = f.controller.suspend();
    await f.controller.context({ theme: 'dark' });
    const resumed = f.controller.resume();
    const suspendedAgain = f.controller.suspend();
    await Promise.all([suspended, resumed, suspendedAgain]);
    await f.controller.suspend();
    expect(f.invoke.mock.calls.map(([, input]) => input.op)).toEqual(['open', 'suspend', 'resume', 'suspend']);
    await f.controller.close();
    await f.controller.resume();
    expect(f.invoke.mock.calls.map(([, input]) => input.op)).toEqual(['open', 'suspend', 'resume', 'suspend', 'teardown']);
  });
  it('does not send local retention operations for native/device-link Views', async () => {
    const f = fixture();
    await f.controller.open({});
    await f.controller.suspend(); await f.controller.resume();
    expect(f.invoke.mock.calls.map(([, input]) => (input as { op: string }).op)).toEqual(['open', 'poll']);
    await f.controller.close();
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

  it('finishes a view-state save during native close before sending teardown', async () => {
    let deliver!: (events: unknown[]) => void;
    const f = fixture(() => new Promise((resolve) => { deliver = resolve; }));
    await f.controller.open({});
    f.controller.sandboxReady();
    f.controller.prepareNativeClose();
    const teardown = f.post.mock.calls.at(-1)![0] as AppRpc;
    const pending = f.controller.close();
    const save: AppRpc = {
      jsonrpc: '2.0', id: 'save', method: 'cindy/view-state/set', params: { state: { version: 1, page: 2 } },
    };
    f.controller.receive(save);
    await flush();
    expect(f.invoke).toHaveBeenCalledWith('task', expect.objectContaining({
      op: 'message', viewId: 'view', message: save,
    }));
    deliver([{ seq: 1, message: { jsonrpc: '2.0', id: save.id, result: {} } }]);
    await flush();
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ id: save.id, result: {} }));
    expect(f.invoke.mock.calls.some(([, input]) => input.op === 'teardown')).toBe(false);
    f.controller.receive({ jsonrpc: '2.0', id: teardown.id, result: {} });
    await pending;
    const operations = f.invoke.mock.calls.map(([, input]) => input.op);
    expect(operations.indexOf('message')).toBeLessThan(operations.indexOf('teardown'));
  });

  it('continues to drop tools and other requests during native close', async () => {
    const f = fixture();
    await f.controller.open({});
    f.controller.sandboxReady();
    f.controller.prepareNativeClose();
    const pending = f.controller.close();
    f.controller.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await flush();
    expect(f.invoke).not.toHaveBeenCalledWith('task', expect.objectContaining({
      op: 'message', message: expect.objectContaining({ method: 'tools/call' }),
    }));
    expect(f.invoke).not.toHaveBeenCalledWith('task', expect.objectContaining({
      op: 'message', message: expect.objectContaining({ method: 'ui/notifications/initialized' }),
    }));
    const teardown = f.post.mock.calls.at(-1)![0] as AppRpc;
    f.controller.receive({ jsonrpc: '2.0', id: teardown.id, result: {} });
    await pending;
  });
  it('closes a View that finishes opening after its card unmounts', async () => {
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn(
      async (_session: string | null, input: Record<string, unknown>) =>
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
    expect(f.state).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-escape' });
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
