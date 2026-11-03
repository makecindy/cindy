import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import type { AppConnection } from '../connection.js';
import { McpAppsHost, appServerRevision, type McpAppsHostDeps } from '../host.js';
import { handleMcpAppOperation } from '../operations.js';

const hosts: McpAppsHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const result: CallToolResult = {
  content: [{ type: 'text', text: 'Completed draft' }],
  structuredContent: { completed: true },
  _meta: { viewOnly: 'private result' },
};
const completion = (kind: 'result' | 'cancelled') =>
  kind === 'result' ? { result } : { cancelled: 'Tool execution cancelled' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const owner = {};
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const uri = 'ui://form';
  const tool = {
    name: 'form',
    inputSchema: { type: 'object' as const },
    _meta: { ui: { resourceUri: uri } },
  };
  const card: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: uri,
    tool,
    arguments: { title: 'Draft' },
  };
  const cards = new Map([
    ['card', card],
    ['other', { ...card }],
  ]);
  const readCard = vi.fn<McpAppsHostDeps['readCard']>(async (_sessionId, clientId) => {
    const current = cards.get(clientId);
    if (!current) throw new Error('MCP_APP_CARD_UNAVAILABLE');
    return current;
  });
  const writeCard = vi.fn<McpAppsHostDeps['writeCard']>(async (_sessionId, clientId, record) => {
    if (!cards.has(clientId)) throw new Error('MCP_APP_CARD_UNAVAILABLE');
    cards.set(clientId, record);
  });
  const dispose = vi.fn();
  const callTool = vi.fn(async () => result);
  const connection = {
    getClient: async () => ({ getServerCapabilities: () => ({ tools: {} }), callTool }),
    tools: async () => [tool],
    resource: async () => ({
      result: { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>Form</p>' }] },
    }),
    listen: () => () => {},
    close: vi.fn(async () => {}),
  } as unknown as AppConnection;
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard,
    writeCard,
    authorizeTool: async () => {},
    sendMessage: async () => {},
    disposeDocument: dispose,
    connection: () => connection,
  });
  const connectionId = host.registerConnection(connection);
  for (const record of cards.values()) record.connectionId = connectionId;
  hosts.push(host);
  const sendResult = vi.spyOn(AppBridge.prototype, 'sendToolResult');
  const sendCancelled = vi.spyOn(AppBridge.prototype, 'sendToolCancelled');
  const sendInput = vi.spyOn(AppBridge.prototype, 'sendToolInput');
  return { host, card, cards, readCard, writeCard, dispose, sendResult, sendCancelled, sendInput, callTool };
}

async function open(host: McpAppsHost, caller: string, clientId = 'card') {
  const document = await host.open(caller, 'task', clientId, {});
  const viewId = document.viewId;
  await host.dispatch(caller, 'task', viewId, {
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Result delivery fixture', version: '1' },
      appCapabilities: {},
    },
  });
  const events = await host.poll(caller, 'task', viewId, 0);
  expect(events.some((event) => event.message && 'result' in event.message)).toBe(true);
  return { caller, viewId, after: events.at(-1)!.seq };
}

async function initialize(host: McpAppsHost, view: Awaited<ReturnType<typeof open>>) {
  await host.dispatch(view.caller, 'task', view.viewId, {
    jsonrpc: '2.0',
    method: 'ui/notifications/initialized',
  });
  let input = false;
  while (!input) {
    const events = await host.poll(view.caller, 'task', view.viewId, view.after);
    view.after = events.at(-1)!.seq;
    input = events.some(
      (event) =>
        event.message &&
        'method' in event.message &&
        event.message.method === 'ui/notifications/tool-input',
    );
  }
}

describe('MCP App result delivery authorization', () => {
  it.each(['device:phone', 'device:desktop'])(
    'acknowledges a slow tools/call before completion and polls its result once for %s',
    async (caller) => {
      const f = fixture();
      const view = await open(f.host, caller);
      await initialize(f.host, view);
      const healthy = await open(f.host, 'device:healthy');
      await initialize(f.host, healthy);
      vi.useFakeTimers();
      const upstream = deferred<CallToolResult>();
      f.callTool.mockReturnValueOnce(upstream.promise);
      let acknowledged = false;
      const ack = handleMcpAppOperation(f.host, caller, 'task', {
        op: 'message', viewId: view.viewId,
        message: { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'form', arguments: {} } },
      }).then((value) => { acknowledged = true; return value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(acknowledged).toBe(true);
      await expect(ack).resolves.toEqual({});
      expect(f.callTool).toHaveBeenCalledOnce();
      // Beyond both controllers' ordinary invoke windows, the View and original
      // tool request remain live. No retry, replay, or link reset is needed.
      await vi.advanceTimersByTimeAsync(35_000);
      expect(f.callTool).toHaveBeenCalledOnce();
      await expect(f.host.assertViewAuthorized(caller, 'task', view.viewId)).resolves.toBeUndefined();
      await handleMcpAppOperation(f.host, healthy.caller, 'task', {
        op: 'message', viewId: healthy.viewId,
        message: { jsonrpc: '2.0', id: 101, method: 'ping' },
      });
      await vi.advanceTimersByTimeAsync(0);
      const peerEvents = await f.host.poll(healthy.caller, 'task', healthy.viewId, healthy.after);
      expect(peerEvents.some((event) => event.message && 'id' in event.message && event.message.id === 101 && 'result' in event.message)).toBe(true);
      upstream.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
      const events = await f.host.poll(caller, 'task', view.viewId, view.after);
      const replies = events.filter((event) => event.message && 'id' in event.message && event.message.id === 100);
      expect(replies).toHaveLength(1);
      expect(replies[0].message).toMatchObject({ id: 100, result });
      expect(f.callTool).toHaveBeenCalledOnce();
      vi.useRealTimers();
    },
  );

  it.each(['pending', 'result', 'cancelled'] as const)(
    'restores an orphaned %s card without replaying its original tool',
    async (kind) => {
      const f = fixture();
      const saved = { ...f.card, connectionId: 'previous-host-connection',
        ...(kind === 'pending' ? {} : completion(kind)) };
      f.cards.set('card', saved);
      const local = await open(f.host, 'renderer:restored');
      await initialize(f.host, local);
      if (kind === 'result') {
        await vi.waitFor(() => expect(f.sendResult).toHaveBeenCalledExactlyOnceWith(result));
        expect(f.sendCancelled).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(f.sendCancelled).toHaveBeenCalledOnce());
        expect(f.cards.get('card')?.cancelled).toBe(kind === 'pending'
          ? 'Tool execution interrupted before completion' : saved.cancelled);
      }
      expect(f.writeCard).toHaveBeenCalledTimes(kind === 'pending' ? 1 : 0);
      const phone = await open(f.host, 'device:phone');
      await initialize(f.host, phone);
      await vi.waitFor(() => expect(kind === 'result' ? f.sendResult : f.sendCancelled).toHaveBeenCalledTimes(2));
      expect(f.writeCard).toHaveBeenCalledTimes(kind === 'pending' ? 1 : 0);
    },
  );

  it('does not publish a restored pending View if its terminal state cannot be saved', async () => {
    const f = fixture();
    f.cards.set('card', { ...f.card, connectionId: 'previous-host-connection' });
    f.writeCard.mockRejectedValueOnce(new Error('Persistence unavailable'));
    await expect(open(f.host, 'renderer:restored')).rejects.toThrow('Persistence unavailable');
    expect(f.sendInput).not.toHaveBeenCalled();
    expect(f.sendCancelled).not.toHaveBeenCalled();
  });

  it.each([
    ['result', true], ['result', false], ['cancelled', true], ['cancelled', false],
  ] as const)('preserves %s for an initialized=%s peer when another caller closes during authorization', async (kind, initialized) => {
    const f = fixture();
    const closing = await open(f.host, 'renderer:closing');
    await initialize(f.host, closing);
    const peer = await open(f.host, 'device:phone');
    if (initialized) await initialize(f.host, peer);
    const reading = deferred<void>();
    const pending = deferred<McpAppRecord>();
    f.readCard.mockImplementationOnce(() => { reading.resolve(); return pending.promise; });
    const record = { ...f.card, ...completion(kind) };
    const update = f.host.updateResult('task', 'card', record);
    await reading.promise;
    await f.host.releaseCaller(closing.caller);
    pending.resolve(record);
    await expect(update).resolves.toBeUndefined();
    expect(f.cards.get('card')).toEqual(record);
    if (!initialized) await initialize(f.host, peer);
    await vi.waitFor(() => expect(kind === 'result' ? f.sendResult : f.sendCancelled).toHaveBeenCalledOnce());
    expect(f.dispose).toHaveBeenCalledExactlyOnceWith(closing.viewId);
    await expect(f.host.assertViewAuthorized(peer.caller, 'task', peer.viewId)).resolves.toBeUndefined();
    // Reopened callers also receive the successfully persisted completion.
    const reopened = await open(f.host, 'renderer:reopened');
    await initialize(f.host, reopened);
    await vi.waitFor(() => expect(kind === 'result' ? f.sendResult : f.sendCancelled).toHaveBeenCalledTimes(2));
  });

  it.each(['result', 'cancelled'] as const)('isolates a %s transport failure to the affected View', async (kind) => {
    const f = fixture();
    const broken = await open(f.host, 'renderer:broken');
    await initialize(f.host, broken);
    const peer = await open(f.host, 'device:phone');
    await initialize(f.host, peer);
    const delivery = kind === 'result' ? f.sendResult : f.sendCancelled;
    delivery.mockRejectedValueOnce(new Error('MCP_APP_TRANSPORT_CLOSED'));
    await expect(f.host.updateResult('task', 'card', { ...f.card, ...completion(kind) })).resolves.toBeUndefined();
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledExactlyOnceWith(broken.viewId);
    await expect(f.host.assertViewAuthorized(peer.caller, 'task', peer.viewId)).resolves.toBeUndefined();
  });

  it('rejects a poll immediately if disposal wins between authorization and installing its wake', async () => {
    const f = fixture();
    const view = await open(f.host, 'renderer:local');
    vi.useFakeTimers();
    let rejected = false;
    const poll = expect(f.host.poll(view.caller, 'task', view.viewId, view.after))
      .rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE').then(() => { rejected = true; });
    // assertCurrentView resumes first, then removal wins before transport.poll.
    await Promise.resolve().then(() => f.host.releaseCaller(view.caller));
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toBe(true);
    await poll;
  });
  it.each(['result', 'cancelled'] as const)(
    'disposes initialized and waiting Views without delivering %s when persistence rejects a revoked card',
    async (kind) => {
      const f = fixture();
      const local = await open(f.host, 'renderer:local');
      await initialize(f.host, local);
      const waiting = await open(f.host, 'device:phone');
      const other = await open(f.host, 'renderer:other', 'other');
      await initialize(f.host, other);
      const rejectedPoll = expect(
        f.host.poll(local.caller, 'task', local.viewId, local.after),
      ).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');

      // readCard/writeCard reject cleared, rewound or deleted cards through the same contract.
      f.cards.delete('card');
      await expect(
        f.host.updateResult('task', 'card', { ...f.card, ...completion(kind) }),
      ).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
      await rejectedPoll;
      expect(f.sendResult).not.toHaveBeenCalled();
      expect(f.sendCancelled).not.toHaveBeenCalled();
      expect(f.dispose.mock.calls).toEqual([[local.viewId], [waiting.viewId]]);
      await expect(initialize(f.host, waiting)).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');

      await f.host.updateResult('task', 'other', { ...f.card, result });
      const events = await f.host.poll(other.caller, 'task', other.viewId, other.after);
      expect(events).toContainEqual(
        expect.objectContaining({
          message: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result },
        }),
      );
      expect(f.sendResult).toHaveBeenCalledOnce();
      expect(f.dispose).not.toHaveBeenCalledWith(other.viewId);
    },
  );

  it('preserves a storage failure and fails closed even if the old card can still be read', async () => {
    const f = fixture();
    const view = await open(f.host, 'renderer:local');
    await initialize(f.host, view);
    const failure = new Error('STORAGE_FAILURE');
    f.writeCard.mockRejectedValueOnce(failure);
    await expect(f.host.updateResult('task', 'card', { ...f.card, result })).rejects.toBe(failure);
    expect(f.sendResult).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledWith(view.viewId);
  });

  it.each(['result', 'cancelled'] as const)(
    'revalidates the live card before sending %s after a successful write',
    async (kind) => {
      const f = fixture();
      const view = await open(f.host, 'renderer:local');
      await initialize(f.host, view);
      f.writeCard.mockImplementationOnce(async (_sessionId, clientId, record) => {
        f.cards.set(clientId, record);
        // Revocation can race with the persistence completion.
        f.cards.delete(clientId);
      });
      await expect(
        f.host.updateResult('task', 'card', { ...f.card, ...completion(kind) }),
      ).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
      expect(f.sendResult).not.toHaveBeenCalled();
      expect(f.sendCancelled).not.toHaveBeenCalled();
      expect(f.dispose).toHaveBeenCalledWith(view.viewId);
    },
  );

  it.each(['result', 'cancelled'] as const)(
    'does not deliver saved %s or input when the card is revoked before initialization',
    async (kind) => {
      const f = fixture();
      const view = await open(f.host, 'renderer:local');
      await f.host.updateResult('task', 'card', { ...f.card, ...completion(kind) });
      f.cards.delete('card');
      await f.host.dispatch(view.caller, 'task', view.viewId, {
        jsonrpc: '2.0',
        method: 'ui/notifications/initialized',
      });
      await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledWith(view.viewId));
      expect(f.sendInput).not.toHaveBeenCalled();
      expect(f.sendResult).not.toHaveBeenCalled();
      expect(f.sendCancelled).not.toHaveBeenCalled();
    },
  );

  it.each(['result', 'cancelled'] as const)(
    'delivers %s once to active and later initialized Views while their card remains current',
    async (kind) => {
      const f = fixture();
      const active = await open(f.host, 'renderer:local');
      await initialize(f.host, active);
      const waiting = await open(f.host, 'device:phone');
      const record = { ...f.card, ...completion(kind) };
      await f.host.updateResult('task', 'card', record);
      await initialize(f.host, waiting);
      await f.host.updateResult('task', 'card', record);
      await vi.waitFor(() => {
        expect(kind === 'result' ? f.sendResult : f.sendCancelled).toHaveBeenCalledTimes(2);
      });
      expect(f.dispose).not.toHaveBeenCalled();
    },
  );
});

// 4429338500: Controller sequencing relies on the production operation receipt,
// not a transport send acknowledgment. Await only that receipt before replacing.
it('acknowledges initialized after the Host has recognized its document', async () => {
  const f = fixture();
  const view = await open(f.host, 'device:phone');
  const message = (value: unknown) => handleMcpAppOperation(f.host, view.caller, 'task', {
    op: 'message', viewId: view.viewId, message: value,
  });
  await message({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await message({ jsonrpc: '2.0', id: 72, method: 'ui/initialize', params: {
    protocolVersion: '2026-01-26', appInfo: { name: 'Replacement', version: '1' }, appCapabilities: {},
  } });
  const events = await f.host.poll(view.caller, 'task', view.viewId, view.after);
  expect(events).toContainEqual(expect.objectContaining({
    generation: 1, message: expect.objectContaining({ id: 72, result: expect.any(Object) }),
  }));
  await f.host.teardown(view.caller, 'task', view.viewId, true);
});
