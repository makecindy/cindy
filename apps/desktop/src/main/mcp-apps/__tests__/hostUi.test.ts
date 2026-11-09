import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ owner: 'owner', entry: null as unknown,
  send: vi.fn(), contents: { id: 1, isDestroyed: () => false, once: vi.fn(), removeListener: vi.fn() } }));
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => ({ ...boundary.contents, id }) },
  BrowserWindow: { fromWebContents: (contents: { id: number }) => ({ isDestroyed: () => false,
    webContents: { ...boundary.contents, id: contents.id, send: boundary.send } }) } }));
vi.mock('../../deepLink.js', () => ({ getDeepLinkMainWindow: () => ({ isDestroyed: () => false,
  webContents: { ...boundary.contents, send: boundary.send } }) }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => boundary.owner }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ getSafeDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }) }));
vi.mock('../../mcp-integrations/plugin-app-registry.js', () => ({ readPluginHostUi: () => boundary.entry }));
import { bindPluginUiResource, finishPluginUiAction } from '../hostUi';
import { markRsbWindowWebContentsId } from '../../right-sidebar-window/registry';

// 生产入口：Main 的资源来源绑定和真实宿主工具，观察给所属编辑器的命令与拒绝结果。
// 规则：页面不能自选任务/操作、缺能力不开放、任务清空/owner 切换撤权。
// 原标准工具卡测试不覆盖无卡片 Host 操作；最小输入为覆盖 sessionId 或操作前撤销。tier: unit。
beforeEach(() => {
  boundary.owner = 'owner'; boundary.send.mockClear();
  markRsbWindowWebContentsId(2);
  markRsbWindowWebContentsId(3);
  boundary.entry = { host: { views: [{ id: 'task', title: 'Task', resourceUri: 'ui://task', scope: 'task' },
    { id: 'global', title: 'Global', resourceUri: 'ui://global' }], capabilities: ['draft'] },
    config: { id: 'plugin-ui', plugin: { assertCurrent: () => {} } } };
});
afterEach(() => vi.restoreAllMocks());

it('keeps the declared source scope and omits task-only tools from a global view', () => {
  expect(() => bindPluginUiResource('renderer:1', null, 'plugin', 'task', () => 'rev')).toThrow('MCP_APP_SOURCE_UNAVAILABLE');
  expect(() => bindPluginUiResource('renderer:1', 'task-a', 'plugin', 'global', () => 'rev')).toThrow('MCP_APP_INVALID_SCOPE');
  const global = bindPluginUiResource('renderer:1', null, 'plugin', 'global', () => 'rev');
  expect(global.hostTools?.map(tool => tool.name)).toEqual(['cindy.ui.open']);
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
    const first = { revision: 'one', text: { type: 'doc', content: [] } };
    finishPluginUiAction('renderer:1', action.requestId, first);
    stop = await watching;
    expect(binding.projectContext!({ cindy: { draft: { revision: 'popup-stale' } } }).draft).toEqual(first);
    finishPluginUiAction('renderer:1', action.requestId, { ...first, revision: 'two' });
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    expect(boundary.send).toHaveBeenLastCalledWith('plugin-ui:action', expect.objectContaining({ kind: 'draft-unwatch', requestId: action.requestId }));
    expect(() => finishPluginUiAction('renderer:1', action.requestId, first)).toThrow('MCP_APP_ACTION_UNAVAILABLE');
  } finally { stop?.(); abort.abort(); await watching.catch(() => {}); }
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
    const draft = { revision: `editor-${editorId}`, text: { type: 'doc', content: [] } };
    finishPluginUiAction(`renderer:${editorId}`, watch.requestId, draft);
    stop = await watching;
    expect(binding.projectContext!({}).draft).toEqual(draft);
    for (const mode of ['append', 'replace']) {
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
