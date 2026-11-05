import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CindyPluginUi, PluginUiContent } from '@cindy/maker-shared/plugin-ui';
const host = vi.hoisted(() => ({ bridge: {} as Record<string, unknown>, invoke: vi.fn(),
  listener: null as null | ((_event: unknown, payload: unknown) => void) }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { host.bridge[name] = api; } },
  ipcRenderer: { on: (_name: string, listener: typeof host.listener) => { host.listener = listener; }, invoke: host.invoke } }));
import '../../../preload/ghostPreload.js';

/* C8 uses the actual preload entry and its exposed bridge. No helper package.
 * Existing preloads have no contribution callbacks or paired native UI replies.
 * Minimal failure: a callback throws or finishes after disposal. Tier: unit. */
const api = () => (host.bridge.cindy as { ui: CindyPluginUi }).ui;
const content: PluginUiContent = { controls: [], blocks: [], actions: [], fallbackMarkdown: 'Preview' };
const context = { scope: { kind: 'session', sessionId: 'task' }, capabilities: { version: 1, points: ['composer.tools'], primitives: [], effects: [], pages: [] } };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { api()?.dispose(); host.invoke.mockReset(); host.invoke.mockResolvedValue({ ok: true }); });
host.invoke.mockResolvedValue({ ok: true });
describe('built-in cindy.ui API', () => {
  // Unit: actual preload callback delivery lost page data before reaching main.js.
  // One nested request/reply protects the author path, unlike status-only cases.
  it('passes page business data to its contribution callback and returns the plugin result', async () => {
    const data = { items: [{ id: 'plugin-item', available: true }] };
    const onAction = vi.fn(() => ({ status: 'completed' as const, data }));
    api().contribute('format', { render: () => content, onAction });
    const input = { actionId: 'load', values: {}, data: { query: { ids: ['plugin-item'] } }, context };
    host.listener!(undefined, { type: 'event', name: 'ui-action', contributionId: 'format',
      invocationId: 'page-request', viewId: 'host-view', ...input });
    await flush();
    expect(onAction).toHaveBeenCalledExactlyOnceWith(input);
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-action-result',
      invocationId: 'page-request', viewId: 'host-view', result: { status: 'completed', data } });
  });
  it('routes a command to its own handler even when a contribution has the same id', async () => {
    const run = vi.fn(() => ({ status: 'completed' as const }));
    api().contribute('format', { render: () => content });
    const dispose = api().registerCommand('format', run);
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-command-register', commandId: 'format' });
    host.listener!(undefined, { type: 'event', name: 'ui-command', commandId: 'format',
      invocationId: 'click', viewId: 'host-view', context });
    await flush();
    expect(run).toHaveBeenCalledWith(context);
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-action-result',
      invocationId: 'click', viewId: 'host-view', result: { status: 'completed' } });
    dispose();
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-command-unregister', commandId: 'format' });
    host.listener!(undefined, { type: 'ui-view-request', requestId: 'request', viewId: 'view', contributionId: 'format', context });
    await flush();
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-view-result', requestId: 'request', viewId: 'view', content });
  });
  it('registers callbacks and pairs Host reads without an author constructing wire messages', async () => {
    const render = vi.fn(() => content);
    const dispose = api().contribute('format', { render });
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-register', contributionId: 'format' });
    host.listener!(undefined, { type: 'ui-view-request', requestId: 'request', viewId: 'host-view', contributionId: 'format', context });
    await flush(); expect(render).toHaveBeenCalledWith(context);
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-view-result', requestId: 'request', viewId: 'host-view', content });
    dispose(); expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-unregister', contributionId: 'format' });
  });
  it('returns one unknown outcome for an unclassified action exception without effects or exception text', async () => {
    api().contribute('format', { render: () => content, onAction: () => { throw new Error('private business content'); } });
    host.listener!(undefined, { type: 'event', name: 'ui-action', contributionId: 'format',
      invocationId: 'click', viewId: 'host-view', actionId: 'save', values: { format: 'plain' }, context });
    await flush();
    const replies = host.invoke.mock.calls.filter(args => args[1]?.type === 'ui-action-result');
    expect(replies.map(args => args[1])).toEqual([{ type: 'ui-action-result', invocationId: 'click', viewId: 'host-view', result: { status: 'outcome-unknown' } }]);
  });
  it('drops canceled and disposed render results', async () => {
    let resolve!: (value: PluginUiContent) => void;
    api().contribute('format', { render: () => new Promise(r => { resolve = r; }) });
    host.listener!(undefined, { type: 'ui-view-request', requestId: 'cancel', viewId: 'host-view', contributionId: 'format', context });
    await flush(); host.listener!(undefined, { type: 'ui-view-cancel', requestId: 'cancel' });
    resolve(content); await flush();
    expect(host.invoke.mock.calls.filter(args => args[1]?.type === 'ui-view-result')).toEqual([]);
    api().dispose(); host.listener!(undefined, { type: 'ui-view-request', requestId: 'old', viewId: 'host-view', contributionId: 'format', context });
    await flush(); expect(host.invoke.mock.calls.filter(args => args[1]?.type === 'ui-view-result')).toEqual([]);
  });
  it('pairs the actual capability reply and invalidates only an explicit author scope', async () => {
    host.invoke.mockImplementation(async (_channel, msg) => ({ requestId: msg.requestId, capabilities: context.capabilities }));
    expect(await api().capabilities()).toEqual(context.capabilities);
    api().invalidate({ contributionId: 'format', scope: { kind: 'session', sessionId: 'task' } });
    expect(host.invoke).toHaveBeenCalledWith('ghost-pipe:send', { type: 'ui-update', contributionId: 'format', scope: { kind: 'session', sessionId: 'task' } });
  });
});
