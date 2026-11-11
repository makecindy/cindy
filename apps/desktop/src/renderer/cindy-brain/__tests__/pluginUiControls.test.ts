import { expect, it, vi } from 'vitest';
import { PluginUiControls } from '../pluginUiControls';
import { NativePluginUiState } from '../../../main/mcp-apps/nativeState';
import { pluginUiInterestKey, type PluginUiInterest, type PluginUiStateChange } from '../../../shared/pluginUi';

// 生产入口：Renderer 控件订阅与真实 Main 订阅适配器连通，边界只替换 IPC。
// 规则：同一窗口共享需求、首包与实时更新有序、最后消费者释放、owner 隔离。
// 原 App frame 回归不覆盖原生控件；最小输入为两个控件共享键或实时包先于首包。tier: unit。
const interest = { instanceId: 'plugin', id: 'progress', sessionId: 'task-a' };
it('collapses repeated consumers into one window interest and releases the original source', async () => {
  const authority = {}, owner = {};
  let receive: ((input: { epoch: string; updates: PluginUiStateChange[] }) => void) | undefined;
  const stop = vi.fn(), demand = vi.fn();
  const host = new NativePluginUiState({ owner: () => 'owner', authority: () => authority,
    demand, send: (_caller, epoch, updates) => receive?.({ epoch, updates }) });
  const replace = vi.fn(async (epoch: string, entries: PluginUiInterest[]) => ({ updates: host.subscribe('renderer:1', epoch, entries) }));
  const controls = new PluginUiControls({ owner: () => owner, replace, listen: listener => { receive = listener; return stop; } });
  const changed = vi.fn();
  const releases = Array.from({ length: 100 }, () => controls.subscribe(interest, () => changed()));
  await Promise.resolve(); await Promise.resolve();
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace.mock.calls[0][1]).toEqual([interest]);
  releases.shift()!();
  expect(host.consumers('plugin')).toHaveLength(1);
  host.publish('plugin', 'progress', undefined, () => ({ title: 'Delivered' }));
  await Promise.resolve();
  expect(controls.snapshot(interest)).toEqual({ title: 'Delivered' });
  releases.forEach(release => release());
  await Promise.resolve(); await Promise.resolve();
  expect(host.consumers('plugin')).toBeUndefined(); expect(stop).toHaveBeenCalledTimes(1);
});

// PR #9496 / discussion_r4537052994: one caller has a 512-target budget.
// Exercise the existing Renderer/Main adapter with 513 distinct mounted targets;
// the extra control keeps its declared state and takes a released slot. Unit.
it('keeps the first 512 active targets subscribed and admits overflow after a release', async () => {
  const authority = {}, owner = {};
  let receive: ((input: { epoch: string; updates: PluginUiStateChange[] }) => void) | undefined;
  const stop = vi.fn();
  const host = new NativePluginUiState({ owner: () => 'owner', authority: () => authority,
    demand: () => {}, send: (_caller, epoch, updates) => receive?.({ epoch, updates }) });
  const replace = vi.fn(async (epoch: string, entries: PluginUiInterest[]) => {
    // The existing IPC request contract rejects the whole replacement above 512.
    if (entries.length > 512) throw new Error('MCP_APP_INVALID_REQUEST');
    return { updates: host.subscribe('renderer:1', epoch, entries) };
  });
  const controls = new PluginUiControls({ owner: () => owner, replace,
    listen: listener => { receive = listener; return stop; } });
  const targets = Array.from({ length: 513 }, (_, index) => ({ ...interest, clientId: `row-${index}` }));
  const overflowChanged = vi.fn();
  const releases = targets.map((target, index) => controls.subscribe(target, index === 512 ? overflowChanged : () => {}));
  await Promise.resolve(); await Promise.resolve();
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace.mock.calls[0][1]).toEqual(targets.slice(0, 512));
  expect(host.consumers('plugin')).toHaveLength(512);
  host.publish('plugin', 'progress', undefined, () => ({ title: 'Delivered' }));
  await Promise.resolve();
  for (const target of targets.slice(0, 512)) expect(controls.snapshot(target)).toEqual({ title: 'Delivered' });
  expect(controls.snapshot(targets[512])).toBeUndefined();
  expect(overflowChanged).not.toHaveBeenCalled();

  releases.shift()!();
  await Promise.resolve(); await Promise.resolve();
  expect(replace.mock.calls[1][1]).toEqual(targets.slice(1));
  host.publish('plugin', 'progress', { sessionId: 'task-a', clientId: 'row-512' }, () => ({ title: 'Admitted' }));
  await Promise.resolve();
  expect(controls.snapshot(targets[512])).toEqual({ title: 'Admitted' });
  expect(overflowChanged).toHaveBeenCalledTimes(1);
  releases.forEach(release => release());
  await Promise.resolve(); await Promise.resolve();
  expect(host.consumers('plugin')).toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(1);
});

it('keeps a newer live update when the initial snapshot arrives later', async () => {
  const owner = {};
  let receive!: (input: { epoch: string; updates: PluginUiStateChange[] }) => void;
  let finish!: (input: { updates: PluginUiStateChange[] }) => void;
  let epoch = '';
  const controls = new PluginUiControls({ owner: () => owner,
    listen: listener => { receive = listener; return () => {}; },
    replace: (next) => { epoch = next; return new Promise(done => { finish = done; }); } });
  controls.subscribe(interest, () => {}); await Promise.resolve();
  const key = pluginUiInterestKey(interest);
  receive({ epoch, updates: [{ key, revision: 2, state: { title: 'New' } }] });
  finish({ updates: [{ key, revision: 1, state: { title: 'Old' } }] });
  await Promise.resolve();
  expect(controls.snapshot(interest)).toEqual({ title: 'New' });
});

it('ignores other targets and old-owner updates without notifying a control', async () => {
  let owner = {};
  let receive!: (input: { epoch: string; updates: PluginUiStateChange[] }) => void;
  let epoch = '';
  const controls = new PluginUiControls({ owner: () => owner, listen: listener => { receive = listener; return () => {}; },
    replace: async next => { epoch = next; return { updates: [] }; } });
  const changed = vi.fn(); controls.subscribe(interest, changed); await Promise.resolve(); await Promise.resolve();
  receive({ epoch, updates: [{ key: pluginUiInterestKey({ ...interest, sessionId: 'other' }), revision: 1, state: { title: 'Other' } }] });
  owner = {};
  receive({ epoch, updates: [{ key: pluginUiInterestKey(interest), revision: 2, state: { title: 'Old owner' } }] });
  expect(changed).not.toHaveBeenCalled(); expect(controls.snapshot(interest)).toBeUndefined();
});
