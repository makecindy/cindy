import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ owner: 'owner', entry: null as unknown,
  send: vi.fn(), setAppearance: vi.fn(async (patch: unknown) => patch),
  contents: { id: 1, isDestroyed: () => false, once: vi.fn(), removeListener: vi.fn() } }));
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => ({ ...boundary.contents, id }) },
  BrowserWindow: { fromWebContents: (contents: { id: number }) => ({ isDestroyed: () => false,
    isVisible: () => true,
    webContents: { ...boundary.contents, id: contents.id, send: boundary.send } }) } }));
vi.mock('../../deepLink.js', () => ({ getDeepLinkMainWindow: () => ({ isDestroyed: () => false,
  webContents: { ...boundary.contents, send: boundary.send } }) }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => boundary.owner,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: boundary.owner, ownerGeneration: 1 }) }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ getSafeDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }) }));
vi.mock('../../mcp-integrations/plugin-app-registry.js', () => ({ readPluginHostUi: () => boundary.entry }));
vi.mock('../../appearance-settings-store.js', () => ({ readAppearanceSettings: () => ({}) }));
vi.mock('../../appearance-settings-ipc.js', () => ({ updateAppearanceFromSettings: boundary.setAppearance }));
import { bindPluginUiResource, finishPluginUiAction } from '../hostUi';
import { releasePluginUiRegions } from '../visibility';
import { markRsbWindowWebContentsId } from '../../right-sidebar-window/registry';
import { pagePermissionSessionChanged } from '../pagePermissions';
import { McpAppsHost } from '../host';
import type { AppConnection, AppServerConfig } from '../connection';
import { configurePluginSettings } from '../../app-settings/plugins';

// 生产入口：Main 的资源来源绑定和真实宿主工具，观察给所属编辑器的命令与拒绝结果。
// 规则：页面不能自选任务/操作、缺能力不开放、任务清空/owner 切换撤权。
// 原标准工具卡测试不覆盖无卡片 Host 操作；最小输入为覆盖 sessionId 或操作前撤销。tier: unit。
beforeEach(() => {
  boundary.owner = 'owner'; boundary.send.mockClear();
  boundary.setAppearance.mockClear();
  markRsbWindowWebContentsId(2);
  markRsbWindowWebContentsId(3);
  boundary.entry = { host: { views: [{ id: 'task', title: 'Task', resourceUri: 'ui://task', scope: 'task' },
    { id: 'global', title: 'Global', resourceUri: 'ui://global' }], capabilities: ['draft'] },
    config: { id: 'plugin-ui', plugin: { assertCurrent: () => {} } } };
});

it('keeps legacy appearance writes within the newly approved field list', async () => {
  const entry = boundary.entry as { host: { capabilities: string[]; appearance?: { fields: string[] } } };
  entry.host.capabilities = ['appearance', 'app-icon']; entry.host.appearance = { fields: ['uiFont'] };
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev');
  const signal = new AbortController().signal;
  await expect(binding.callHostTool!('cindy.ui.appearance', { patch: { codeSize: 18 } }, signal)).rejects.toThrow('FIELD_NOT_DECLARED');
  expect(binding.hostTools?.some(tool => tool.name === 'cindy.ui.app-icon')).toBe(false);
  await expect(binding.callHostTool!('cindy.ui.app-icon', { icon: 'cat' }, signal)).rejects.toThrow('MCP_APP_TOOL_NOT_VISIBLE');
  await expect(binding.callHostTool!('cindy.ui.appearance', { patch: { appIcon: 'cat' } }, signal)).rejects.toThrow('MCP_APP_INVALID_REQUEST');
  expect(boundary.setAppearance).not.toHaveBeenCalled();
  await binding.callHostTool!('cindy.ui.appearance', { patch: { uiSize: 18 } }, signal);
  expect(boundary.setAppearance).toHaveBeenCalledExactlyOnceWith({ uiSize: 18 }, {
    ifRevision: undefined, assertCurrent: expect.any(Function),
  });
});
afterEach(() => { releasePluginUiRegions('plugin'); vi.restoreAllMocks(); });

// 旧版支持单独隐藏界面区域，整窗 hide 不能替代；仅显式调用走一次所属布局桥。tier: unit。
it('changes individual layout regions without hiding the whole application window', async () => {
  (boundary.entry as {host: {capabilities: string[]}}).host.capabilities = ['visibility'];
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev');
  const pending = binding.callHostTool!('cindy.ui.visibility', { regions: { composer: false, header: false } }, new AbortController().signal);
  await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledWith('plugin-ui:action', expect.objectContaining({
    kind: 'regions', values: expect.objectContaining({ composer: false, header: false, messages: true }),
  })));
  const action = boundary.send.mock.calls.at(-1)![1];
  finishPluginUiAction('renderer:1', action.requestId, { applied: true });
  await expect(pending).resolves.toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"composer":false') }] });
  releasePluginUiRegions('plugin');
  expect(boundary.send).toHaveBeenLastCalledWith('plugin-ui:action', expect.objectContaining({ kind: 'regions-sync',
    values: expect.objectContaining({ composer: true, header: true }) }));
});

it('reads regional visibility without a renderer request and rejects unknown region writes', async () => {
  (boundary.entry as {host: {capabilities: string[]}}).host.capabilities = ['visibility'];
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev');
  await binding.callHostTool!('cindy.ui.visibility', {}, new AbortController().signal);
  expect(boundary.send).not.toHaveBeenCalled();
  await expect(binding.callHostTool!('cindy.ui.visibility', { regions: { privateDOM: false } }, new AbortController().signal))
    .rejects.toThrow('MCP_APP_INVALID_REQUEST');
  expect(boundary.send).not.toHaveBeenCalled();
});

it('keeps the declared source scope and omits task-only tools from a global view', () => {
  expect(() => bindPluginUiResource('renderer:1', null, 'plugin', 'task', () => 'rev')).toThrow('MCP_APP_SOURCE_UNAVAILABLE');
  expect(() => bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'global', () => 'rev')).toThrow('MCP_APP_INVALID_SCOPE');
  const global = bindPluginUiResource('renderer:1', null, 'plugin', 'global', () => 'rev');
  expect(global.hostTools?.map(tool => tool.name)).toEqual(['cindy.ui.open']);
});

// New host settings tool: a page cannot choose a different instance namespace.
// Existing draft/appearance tests do not cross the unified settings service (unit).
it('exposes only approved registered settings and ignores a forged namespace', async () => {
  const entry = boundary.entry as { host: { settings?: { id: string; title: string; type: 'boolean'; default: boolean }[] }; config: AppServerConfig };
  const settings = [{ id: 'enabled', title: 'Enabled', type: 'boolean' as const, default: true }];
  entry.host.settings = settings;
  entry.config.plugin!.instance = 'local__example';
  let stored: Record<string, unknown> = { private: 'keep' };
  configurePluginSettings({ entries: () => [{ instance: 'local__example', title: 'Example', settings, assertCurrent() {} }],
    read: () => stored, write: (_instance, value) => { stored = value; } });
  const binding = bindPluginUiResource('renderer:1', null, 'local__example', 'global', () => 'rev');
  expect(binding.hostTools?.some(tool => tool.name === 'cindy.ui.settings')).toBe(true);
  const signal = new AbortController().signal;
  const result = await binding.callHostTool!('cindy.ui.settings', {
    operation: 'update', section: 'plugins.other', patch: { enabled: false },
  }, signal);
  expect(result).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('plugins.local__example') }] });
  expect(stored).toEqual({ private: 'keep', enabled: false });
});

it('does not let a page override the bound task or the operation through tool arguments', async () => {
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev');
  const pending = binding.callHostTool!('cindy.ui.draft', { mode: 'append', text: 'Hello', sessionId: 'other-task', kind: 'open' }, new AbortController().signal);
  await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
  const action = boundary.send.mock.calls[0][1];
  finishPluginUiAction('renderer:1', action.requestId, { saved: true });
  await pending;
  expect(action).toMatchObject({ kind: 'draft', sessionId: 'task-a', mode: 'append', text: 'Hello' });
});

// Opus F1：草稿正文按需沿现有工具读取，仍绑定原编辑器且每页必须有一致版本。tier: unit。
it('routes an explicit draft read to the owning editor and validates continuation arguments', async () => {
  const binding = bindPluginUiResource('renderer:2', 'task-a', 'plugin', 'task', () => 'rev');
  for (const args of [{ mode: 'read', offset: -1 }, { mode: 'read', offset: 128000 }])
    await expect(binding.callHostTool!('cindy.ui.draft', args, new AbortController().signal)).rejects.toThrow('MCP_APP_INVALID_REQUEST');
  expect(boundary.send).not.toHaveBeenCalled();
  const pending = binding.callHostTool!('cindy.ui.draft', { mode: 'read', offset: 128000, revision: 'current' }, new AbortController().signal);
  await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
  const action = boundary.send.mock.calls[0][1];
  expect(action).toMatchObject({ kind: 'draft-read', sessionId: 'task-a', offset: 128000, revision: 'current' });
  const response = { revision: 'current', chunk: 'document tail', nextOffset: null };
  finishPluginUiAction('renderer:1', action.requestId, response);
  expect(await pending).toEqual({ content: [{ type: 'text', text: JSON.stringify(response) }] });
});

it('checks the task lifetime before a write and rejects acknowledgements from another window', async () => {
  let active = true;
  const scope = vi.fn(async () => { if (!active) throw new Error('MCP_APP_SESSION_UNAVAILABLE'); });
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev', scope);
  active = false;
  await expect(binding.callHostTool!('cindy.ui.draft', { mode: 'append', text: 'Hello' }, new AbortController().signal)).rejects.toThrow('MCP_APP_SESSION_UNAVAILABLE');
  expect(boundary.send).not.toHaveBeenCalled();
  active = true;
  const pending = binding.callHostTool!('cindy.ui.draft', { mode: 'append', text: 'Hello' }, new AbortController().signal);
  await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
  const action = boundary.send.mock.calls[0][1];
  expect(() => finishPluginUiAction('renderer:2', action.requestId, {})).toThrow('MCP_APP_ACTION_UNAVAILABLE');
  finishPluginUiAction('renderer:1', action.requestId, {});
  await pending;
});

it('rejects an old-owner operation and capabilities the source never received', async () => {
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev');
  await expect(binding.callHostTool!('cindy.ui.visibility', {}, new AbortController().signal)).rejects.toThrow('MCP_APP_TOOL_NOT_VISIBLE');
  boundary.owner = 'next';
  await expect(binding.callHostTool!('cindy.ui.draft', { mode: 'append', text: 'Hello' }, new AbortController().signal)).rejects.toThrow('MCP_APP_SOURCE_UNAVAILABLE');
  expect(boundary.send).not.toHaveBeenCalled();
});

it('projects only approved context under the real scope without querying the task for state pushes', () => {
  (boundary.entry as { host: { capabilities: string[] } }).host.capabilities.push('context');
  const scope = vi.fn(async () => {});
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev', scope, { title: 'Task A' });
  const supplied = { cindy: { input: { filter: 'open' }, context: { sessionId: 'forged' }, selection: 'Selected' } };
  expect(binding.projectContext!(supplied)).toMatchObject({ input: { filter: 'open' },
    context: { sessionId: 'task-a', task: { title: 'Task A' } }, selection: 'Selected' });
  expect(scope).not.toHaveBeenCalled();
  const global = bindPluginUiResource('renderer:1', null, 'plugin', 'global', () => 'rev');
  expect(global.projectContext!(supplied)).not.toHaveProperty('context');
  expect(global.projectContext!(supplied)).not.toHaveProperty('selection');
});

it('routes detached-view draft operations to the original composer window and binds its acknowledgement', async () => {
  const binding = bindPluginUiResource('renderer:2', 'task-a', 'plugin', 'task', () => 'rev');
  const abort = new AbortController();
  const pending = binding.callHostTool!('cindy.ui.draft', { mode: 'append', text: 'Popup' }, abort.signal);
  try {
    await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    const action = boundary.send.mock.calls[0][1];
    expect(() => finishPluginUiAction('renderer:2', action.requestId, {})).toThrow('MCP_APP_ACTION_UNAVAILABLE');
    finishPluginUiAction('renderer:1', action.requestId, { saved: true });
    await pending;
  } finally { abort.abort(); await pending.catch(() => {}); }
});

it('takes draft context from the original composer stream and releases it with the View', async () => {
  const binding = bindPluginUiResource('renderer:2', 'task-a', 'plugin', 'task', () => 'rev');
  const changed = vi.fn(), abort = new AbortController();
  const watching = binding.observeContext!(changed, abort.signal);
  let stop: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    const action = boundary.send.mock.calls[0][1];
    expect(action).toMatchObject({ kind: 'draft-watch', sessionId: 'task-a' });
    const first = { revision: 'one', selection: null };
    finishPluginUiAction('renderer:1', action.requestId, { ...first, text: { type: 'doc', content: [] } });
    stop = await watching;
    expect(binding.projectContext!({ cindy: { draft: { revision: 'popup-stale' } } }).draft).toEqual(first);
    const selection = { from: 1, to: 3, text: 'xx' };
    finishPluginUiAction('renderer:1', action.requestId, { revision: 'two', selection });
    expect(binding.projectContext!({}).draft).toEqual({ ...first, revision: 'two', selection });
    expect(changed).toHaveBeenCalledTimes(2);
    finishPluginUiAction('renderer:1', action.requestId, { revision: 'three', text: null, selection: null });
    expect(binding.projectContext!({}).draft).toEqual({ revision: 'three', selection: null });
    stop();
    expect(boundary.send).toHaveBeenLastCalledWith('plugin-ui:action', expect.objectContaining({ kind: 'draft-unwatch', requestId: action.requestId }));
    expect(() => finishPluginUiAction('renderer:1', action.requestId, first)).toThrow('MCP_APP_ACTION_UNAVAILABLE');
  } finally { stop?.(); abort.abort(); await watching.catch(() => {}); }
});

// PR #9496 / discussion_r4536628104: View teardown coverage alone misses a
// cleared task whose page remains open. Real committed-session notification;
// no database checks on editor pushes. Minimum: one active draft observer. tier: unit.
it.each([
  ['clear', { clearedAt: 1 }], ['archive', { status: 'archived' }],
] as const)('releases the old draft observer when its task is %s', async (_kind, patch) => {
  const assertScope = vi.fn(async () => {});
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev', assertScope);
  const changed = vi.fn(), abort = new AbortController();
  const watching = binding.observeContext!(changed, abort.signal);
  let stop: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    const action = boundary.send.mock.calls[0][1];
    finishPluginUiAction('renderer:1', action.requestId, { revision: 'before', selection: null });
    stop = await watching;
    pagePermissionSessionChanged('other-task', patch);
    pagePermissionSessionChanged('task-a', { title: 'Renamed', status: 'active' });
    expect(boundary.send).toHaveBeenCalledTimes(1);

    const changes = changed.mock.calls.length;
    pagePermissionSessionChanged('task-a', patch);
    expect(boundary.send).toHaveBeenLastCalledWith('plugin-ui:action', expect.objectContaining({ kind: 'draft-unwatch', requestId: action.requestId }));
    expect(() => binding.projectContext!({})).toThrow('MCP_APP_SESSION_UNAVAILABLE');
    expect(() => binding.assertCurrent()).toThrow('MCP_APP_SESSION_UNAVAILABLE');
    expect(() => finishPluginUiAction('renderer:1', action.requestId,
      { revision: 'after', selection: { from: 1, to: 4, text: 'new' } })).toThrow('MCP_APP_ACTION_UNAVAILABLE');
    pagePermissionSessionChanged('task-a', patch);
    expect(changed).toHaveBeenCalledTimes(changes);
    expect(assertScope).not.toHaveBeenCalled();
  } finally { stop?.(); abort.abort(); await watching.catch(() => {}); }
});

it('cancels a draft observer when the task clears before its initial snapshot arrives', async () => {
  const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', () => 'rev');
  const changed = vi.fn(), abort = new AbortController();
  const watching = binding.observeContext!(changed, abort.signal);
  const settled = watching.catch(() => {});
  try {
    await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    const action = boundary.send.mock.calls[0][1];
    pagePermissionSessionChanged('task-a', { clearedAt: 1 });
    expect(boundary.send).toHaveBeenLastCalledWith('plugin-ui:action', expect.objectContaining({ kind: 'draft-unwatch', requestId: action.requestId }));
    await expect(watching).rejects.toThrow('MCP_APP_ACTION_CANCELLED');
    expect(changed).not.toHaveBeenCalled();
    expect(() => finishPluginUiAction('renderer:1', action.requestId, { revision: 'late', selection: null }))
      .toThrow('MCP_APP_ACTION_UNAVAILABLE');
  } finally { abort.abort(); await settled; }
});

// The same task boundary protects renderer selectionchange -> host.context,
// including pages with context but no draft capability. Exercise the real Host
// entry, with only resource I/O mocked; no card read or per-push scope query.
it.each([
  ['clear', { clearedAt: 1 }], ['archive', { status: 'archived' }],
] as const)('rejects new selection pushes to a context-only page after task %s', async (_kind, patch) => {
  const entry = boundary.entry as { host: { capabilities: string[] }; config: AppServerConfig };
  entry.host.capabilities = ['context'];
  const config = { ...entry.config, url: 'https://mcp.example.invalid', transport: 'http' as const };
  entry.config = config;
  const owner = {}, readCard = vi.fn(), assertScope = vi.fn(async () => {});
  const connection = { getClient: async () => ({ getServerCapabilities: () => ({}) }),
    resource: async () => ({ result: { contents: [{ uri: 'ui://task', mimeType: 'text/html;profile=mcp-app', text: '<html>task</html>' }] } }),
    listen: () => () => {}, close: async () => {},
  } as unknown as AppConnection;
  const host = new McpAppsHost({ owner: () => owner, config: () => config, readCard,
    writeCard: vi.fn(), authorizeTool: async () => {}, sendMessage: async () => {}, connection: () => connection });
  try {
    const binding = bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'task', item => host.serverRevision(item), assertScope);
    const document = await host.openResource('renderer:1', 'task-a', binding, {});
    const scopeQueries = assertScope.mock.calls.length;
    host.context('renderer:1', 'task-a', document.viewId, { cindy: { selection: 'before' } });
    pagePermissionSessionChanged('other-task', patch);
    pagePermissionSessionChanged('task-a', { title: 'Renamed' });
    host.context('renderer:1', 'task-a', document.viewId, { cindy: { selection: 'still current' } });
    pagePermissionSessionChanged('task-a', patch);
    expect(() => host.context('renderer:1', 'task-a', document.viewId, { cindy: { selection: 'new task text' } }))
      .toThrow('MCP_APP_SESSION_UNAVAILABLE');
    await expect(host.assertViewAuthorized('renderer:1', 'task-a', document.viewId)).rejects.toThrow('MCP_APP_SESSION_UNAVAILABLE');
    expect(assertScope).toHaveBeenCalledTimes(scopeQueries);
    expect(readCard).not.toHaveBeenCalled();
    expect(boundary.send).not.toHaveBeenCalled();
  } finally { await host.reset(); }
});

// Complete application windows own their composer; both sidebar factories use
// the existing RSB registry and own no composer. Check reads and both writes.
it.each([
  ['main', 1, 1], ['detached sidebar', 2, 1], ['popped tab', 3, 1], ['secondary application', 4, 4],
] as const)('keeps draft snapshots and writes on the editor owner for %s', async (_kind, sourceId, editorId) => {
  const binding = bindPluginUiResource(`renderer:${sourceId}`, 'task-a', 'plugin', 'task', () => 'rev');
  const abort = new AbortController();
  const watching = binding.observeContext!(vi.fn(), abort.signal);
  let stop: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    const watch = boundary.send.mock.calls[0][1];
    const draft = { revision: `editor-${editorId}`, selection: null };
    finishPluginUiAction(`renderer:${editorId}`, watch.requestId, draft);
    stop = await watching;
    expect(binding.projectContext!({}).draft).toEqual(draft);
    for (const mode of ['append', 'replace', 'replace-selection']) {
      const pending = binding.callHostTool!('cindy.ui.draft', { mode, text: 'Edited', revision: draft.revision }, abort.signal);
      const settled = pending.catch(() => {});
      try {
        await vi.waitFor(() => expect(boundary.send).toHaveBeenLastCalledWith('plugin-ui:action', expect.objectContaining({ kind: 'draft', mode })));
        const action = boundary.send.mock.calls.at(-1)![1];
        if (editorId !== 1) expect(() => finishPluginUiAction('renderer:1', action.requestId, {})).toThrow('MCP_APP_ACTION_UNAVAILABLE');
        finishPluginUiAction(`renderer:${editorId}`, action.requestId, draft);
        await expect(pending).resolves.toMatchObject({ content: [{ type: 'text', text: JSON.stringify(draft) }] });
      } catch (failure) { abort.abort(); throw failure; }
      finally { await settled; }
    }
  } finally { stop?.(); abort.abort(); await watching.catch(() => {}); }
});

it('keeps open-view actions on the existing main-window layout owner from a secondary window', async () => {
  const binding = bindPluginUiResource('renderer:4', 'task-a', 'plugin', 'task', () => 'rev');
  const abort = new AbortController();
  const pending = binding.callHostTool!('cindy.ui.open', { viewId: 'global' }, abort.signal);
  try {
    await vi.waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    const action = boundary.send.mock.calls[0][1];
    expect(action).toMatchObject({ kind: 'open', sessionId: null });
    expect(() => finishPluginUiAction('renderer:4', action.requestId, {})).toThrow('MCP_APP_ACTION_UNAVAILABLE');
    finishPluginUiAction('renderer:1', action.requestId, { opened: true });
    await expect(pending).resolves.toMatchObject({ content: [{ type: 'text', text: '{"opened":true}' }] });
  } finally { abort.abort(); await pending.catch(() => {}); }
});
