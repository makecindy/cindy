import { createViewStateStorage, reconcileDeletedTaskViewState } from '../viewStateStore.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { afterEach, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { AppConnection } from '../connection.js';
import { McpAppsHost, appServerRevision } from '../host.js';
import { viewStateSnapshot, viewStateError, type ViewStateSnapshot } from '../viewState.js';

// Unit: real Host dispatch/initialize/poll, with a controllable storage port.
// Existing model-context tests do not cover private persistence or commit acknowledgements.
// Minimal failures: one remount, a failed read, or A in flight followed by B/C.
const hosts: McpAppsHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.reset()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(resourceSessionId?: string | null) {
  const sessionId = resourceSessionId === undefined ? 'task' : resourceSessionId;
  vi.useFakeTimers();
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  const owner = {};
  const config = { id: 'fixture', url: 'https://example.invalid', transport: 'http' as const };
  const tool = { name: 'form', inputSchema: { type: 'object' as const }, _meta: { ui: { resourceUri: 'ui://form' } } };
  const record = { version: 1 as const, serverId: config.id, serverRevision: appServerRevision(config),
    resourceUri: 'ui://form', tool, arguments: {}, result: { content: [] } };
  const connection = { getClient: async () => ({ getServerCapabilities: () => ({}) }), tools: async () => [tool],
    resource: async () => ({ result: { contents: [{ uri: 'ui://form', mimeType: 'text/html;profile=mcp-app', text: '' }] } }),
    listen: () => () => {}, close: async () => {},
  } as unknown as AppConnection;
  let state: unknown = { version: 1, draft: 'private-draft' };
  const read = vi.fn(async () => state);
  const save = vi.fn(async (value: ViewStateSnapshot) => { state = value.json === null ? null : JSON.parse(value.json); });
  const viewState = vi.fn(() => ({ read, save }));
  const host = new McpAppsHost({ owner: () => owner, config: () => config, connection: () => connection,
    readCard: async () => record, writeCard: async () => {}, authorizeTool: vi.fn(), sendMessage: vi.fn(),
    viewState,
  });
  hosts.push(host);
  const context = { 'cindy/view-state': { forged: true }, viewState: 'forged' };
  const open = () => resourceSessionId === undefined
    ? host.open('device:test', 'task', 'card', context)
    : host.openResource('device:test', sessionId, { id: 'resource', title: 'Resource', serverId: config.id,
      serverRevision: record.serverRevision, resourceUri: record.resourceUri, assertCurrent() {} }, context);
  const doc = await open();
  const dispatch = (viewId: string, id: number, method: string, params?: unknown) => host.dispatch('device:test', sessionId, viewId,
    { jsonrpc: '2.0', id, method, params });
  const reply = async (viewId: string, id: number) => {
    await vi.advanceTimersByTimeAsync(0);
    const events = await host.poll('device:test', sessionId, viewId, 0);
    return events.map(e => e.message).find(m => m && 'id' in m && m.id === id) as
      { result?: Record<string, any>; error?: { code: number; data?: { code: string } } };
  };
  const initialize = async (viewId = doc.viewId, id = 1) => {
    await dispatch(viewId, id, 'ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'fixture', version: '1' }, appCapabilities: {} });
    const result = await reply(viewId, id);
    await host.dispatch('device:test', sessionId, viewId, { jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await vi.advanceTimersByTimeAsync(0);
    return result;
  };
  const set = (id: number, value: unknown) => dispatch(doc.viewId, id, 'cindy/view-state/set', { state: value });
  return { host, doc, open, initialize, dispatch, reply, set, read, save, viewState };
}
// Unit regression for the merged resource-view entry: no persisted card means no
// persistence authority, even with a task ID. Existing card tests never open resources.
// The minimum input is openResource -> initialize -> set; no DB or real wait needed.
it.each([null, 'task'])('does not offer card state to an independent resource (session %s)', async sessionId => {
  const f = await fixture(sessionId);
  const init = await f.initialize();
  expect(init.result?.protocolVersion).toBe('2026-01-26');
  expect(init.result?.hostCapabilities.experimental?.['cindy/view-state']).toBeUndefined();
  expect(init.result?.hostContext['cindy/view-state']).toBeUndefined();
  expect(init.result?.hostContext.viewState).toBeUndefined();
  await f.set(2, { draft: 'not a card' });
  expect((await f.reply(f.doc.viewId, 2)).error?.code).toBe(-32601);
  expect(f.viewState).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});
it('restores only at initialize, persists only after set, and clears with null', async () => {
  const f = await fixture();
  const init = await f.initialize();
  expect(init.result?.hostCapabilities.experimental['cindy/view-state']).toMatchObject({ maxBytes: 65536 });
  expect(init.result?.hostContext['cindy/view-state']).toEqual({ version: 1, draft: 'private-draft' });
  expect(init.result?.hostContext.viewState).toBeUndefined();
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.save).not.toHaveBeenCalled();
  await f.set(2, { version: 1, page: 3 });
  expect((await f.reply(f.doc.viewId, 2)).result).toEqual({});
  f.host.context('device:test', 'task', f.doc.viewId, { theme: 'dark', 'cindy/view-state': { forged: true } });
  const notifications = (await f.host.poll('device:test', 'task', f.doc.viewId, 0)).filter(e => e.message && 'method' in e.message);
  expect(JSON.stringify(notifications)).not.toContain('private-draft');
  expect(JSON.stringify(notifications)).not.toContain('cindy/view-state');
  await f.host.teardown('device:test', 'task', f.doc.viewId);
  const next = await f.open();
  expect((await f.initialize(next.viewId, 3)).result?.hostContext['cindy/view-state']).toEqual({ version: 1, page: 3 });
  await f.dispatch(next.viewId, 4, 'cindy/view-state/set', { state: null });
  expect((await f.reply(next.viewId, 4)).result).toEqual({});
  const again = await f.open();
  expect((await f.initialize(again.viewId, 5)).result?.hostContext['cindy/view-state']).toBeNull();
});
it.each(['failure', 'timeout'])('omits capability and forged data on read %s', async mode => {
  const f = await fixture();
  if (mode === 'failure') f.read.mockRejectedValue(new Error('storage failed'));
  else f.read.mockImplementation(() => new Promise(() => {}));
  const pending = f.initialize();
  if (mode === 'timeout') await vi.advanceTimersByTimeAsync(2000);
  const init = await pending;
  expect(init.result?.hostCapabilities.experimental?.['cindy/view-state']).toBeUndefined();
  expect(init.result?.hostContext['cindy/view-state']).toBeUndefined();
  expect(init.result?.hostContext.viewState).toBeUndefined();
  await f.set(2, { draft: 'do not overwrite' });
  expect((await f.reply(f.doc.viewId, 2)).error?.code).toBe(-32603);
  expect(f.save).not.toHaveBeenCalled();
});
it('merges B/C only behind A and reports the same failed commit to both callers', async () => {
  const f = await fixture(); await f.initialize();
  const a = deferred(), c = deferred();
  f.save.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => c.promise);
  await f.set(2, { page: 1 }); await f.set(3, { page: 2 }); await f.set(4, { page: 3 });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(await f.reply(f.doc.viewId, 2)).toBeUndefined();
  a.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect((await f.reply(f.doc.viewId, 2)).result).toEqual({});
  expect(await f.reply(f.doc.viewId, 3)).toBeUndefined();
  expect(f.save.mock.calls[1][0].json).toBe('{"page":3}');
  c.reject(viewStateError('CINDY_VIEW_STATE_STORAGE_UNAVAILABLE'));
  expect((await f.reply(f.doc.viewId, 3)).error?.code).toBe(-32603);
  expect((await f.reply(f.doc.viewId, 4)).error?.code).toBe(-32603);
});
// Unit regression: a failed old write must not short-circuit waiting for a pending
// successful write or suppress the replacement page's independent storage read.
it('restores the successful pending batch after the old in-flight batch fails', async () => {
  const f = await fixture(); await f.initialize();
  const a = deferred(), b = deferred();
  const persist = f.save.getMockImplementation()!;
  f.save.mockImplementationOnce(() => a.promise).mockImplementationOnce(async value => {
    await b.promise; await persist(value);
  });
  await f.set(2, { page: 2 }); await f.set(3, { version: 1, page: 3 });
  await vi.advanceTimersByTimeAsync(0);
  await f.host.teardown('device:test', 'task', f.doc.viewId);
  const next = await f.open();
  const initializing = f.initialize(next.viewId, 4);
  await vi.advanceTimersByTimeAsync(0);
  a.reject(viewStateError('CINDY_VIEW_STATE_STORAGE_UNAVAILABLE'));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.save).toHaveBeenCalledTimes(2);
  b.resolve();
  const init = await initializing;
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(init.result?.hostContext['cindy/view-state']).toEqual({ version: 1, page: 3 });
  expect(init.result?.hostCapabilities.experimental['cindy/view-state']).toMatchObject({ maxBytes: 65536 });
});
it('bounds unacknowledged requests and does not replace the latest valid pending value on rejection', async () => {
  const f = await fixture(); await f.initialize(); const gate = deferred();
  f.save.mockImplementationOnce(() => gate.promise);
  for (let i = 0; i < 33; i++) await f.set(i + 2, { page: i });
  expect((await f.reply(f.doc.viewId, 34)).error?.data?.code).toBe('CINDY_VIEW_STATE_BUSY');
  gate.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.save.mock.calls[1][0].json).toBe('{"page":31}');
  for (let id = 2; id < 34; id++) expect((await f.reply(f.doc.viewId, id)).result).toEqual({});
});
it('rejects invalid JSON and local references without persisting, including UTF-8 overflow', async () => {
  const f = await fixture(); await f.initialize();
  let id = 2;
  for (const value of [[], 1, { draft: '汉'.repeat(22000) }, { type: 'resource_link', uri: 'LiBrArY:test' }]) {
    await f.set(id, value);
    expect((await f.reply(f.doc.viewId, id++)).error?.code).toBe(-32602);
  }
  expect(f.save).not.toHaveBeenCalled();
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [undefined, { x: undefined }, { x: NaN }, { x: 1n }, cyclic, { x: new Date() },
    { x: Array.from({ length: 8200 }, () => 1) }]) expect(() => viewStateSnapshot(value)).toThrow();
  let deep: object = {}; for (let i = 0; i < 16; i++) deep = { deep };
  expect(() => viewStateSnapshot(deep)).toThrow();
});
it('a replacement waits only for already accepted writes without issuing a flush', async () => {
  const f = await fixture(); await f.initialize(); const gate = deferred();
  f.save.mockImplementationOnce(() => gate.promise);
  await f.set(2, { page: 2 }); await vi.advanceTimersByTimeAsync(0);
  await f.host.teardown('device:test', 'task', f.doc.viewId);
  const next = await f.open(); const initializing = f.initialize(next.viewId, 3);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.read).toHaveBeenCalledTimes(1);
  gate.resolve(); await initializing;
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.save).toHaveBeenCalledTimes(1);
});

it('isolates captured account clients and runs deleted-task cleanup once per client lifecycle', async () => {
  const binding = { sessionId: 'same-task', clientId: 'same-card', serverId: 'fixture', serverRevision: 'revision',
    resourceUri: 'ui://form', toolName: 'form', pluginInstance: null };
  const content = JSON.stringify({ mcpApp: { version: 1, serverId: 'fixture', serverRevision: 'revision', resourceUri: 'ui://form',
    tool: { name: 'form', inputSchema: { type: 'object' } }, arguments: {} } });
  const clients = ['first-owner', 'second-owner'].map(draft => ({
    queryOne: vi.fn(async () => ({ id: 'same-message', content, meta: JSON.stringify({ mcpApp: true }), remoteHostId: null,
      stateJson: JSON.stringify({ draft }), serverId: 'fixture', serverRevision: 'revision', pluginInstance: null })),
    tx: vi.fn(async () => {}), exec: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
  }));
  let owner = 0;
  const stores = clients.map((client, index) => createViewStateStorage(client as unknown as DbClient, binding, () => {
    if (owner !== index) throw Object.assign(new Error('MCP_APP_CARD_UNAVAILABLE'), { code: 'MCP_APP_CARD_UNAVAILABLE' });
  }));
  expect(await stores[0].read()).toEqual({ draft: 'first-owner' });
  owner = 1;
  expect(await stores[1].read()).toEqual({ draft: 'second-owner' });
  await expect(stores[0].save(viewStateSnapshot({ draft: 'late' }))).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
  expect(clients[0].tx).not.toHaveBeenCalled(); expect(clients[1].tx).not.toHaveBeenCalled();
  await reconcileDeletedTaskViewState(clients[0] as unknown as DbClient, () => owner === 0);
  expect(clients[0].exec).not.toHaveBeenCalled();
  await reconcileDeletedTaskViewState(clients[1] as unknown as DbClient, () => owner === 1);
  await reconcileDeletedTaskViewState(clients[1] as unknown as DbClient, () => owner === 1);
  expect(clients[1].exec).toHaveBeenCalledTimes(1);
});
