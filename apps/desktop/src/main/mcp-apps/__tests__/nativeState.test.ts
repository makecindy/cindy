import { expect, it, vi } from 'vitest';
import { NativePluginUiState } from '../nativeState.js';

// 生产入口：NativePluginUiState 的订阅/发布/释放，观察真实投递与数据构造次数。
// 规则：无消费者不通信、按对象投递、旧 owner/批准不复用；原 App frame 测试不覆盖原生控件。
// 最小失败输入：最后一个窗口替换同一订阅，或切换 owner 后新窗口请求相同键。
// tier: unit，边界仅替换 renderer/pipe send；单文件实测 233ms（含先红用例）。
function fixture() {
  let owner = 'owner';
  let authority: object | undefined = {};
  const send = vi.fn();
  const demand = vi.fn();
  const state = new NativePluginUiState({ owner: () => owner, authority: () => authority, send, demand });
  return { state, send, demand, revoke: () => { authority = undefined; }, changeOwner: () => { owner = 'next'; } };
}
const interest = { instanceId: 'plugin', id: 'progress', sessionId: 'task-a' };

it('does no projection or delivery with no consumers, including after the last release', async () => {
  const f = fixture(), build = vi.fn(() => ({ title: 'Ready' }));
  for (let i = 0; i < 1000; i++) f.state.publish('plugin', 'progress', undefined, build);
  expect(build).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  f.state.subscribe('window-a', 'one', [interest]);
  f.state.release('window-a');
  for (let i = 0; i < 1000; i++) f.state.publish('plugin', 'progress', undefined, build);
  await Promise.resolve();
  expect(build).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  expect(f.state.consumers('plugin')).toBeUndefined();
});

it('shares source demand, sends one latest snapshot per window, and targets updates precisely', async () => {
  const f = fixture();
  f.state.subscribe('window-a', 'one', [interest]);
  f.state.subscribe('window-b', 'two', [interest]);
  expect(f.demand).toHaveBeenCalledTimes(1);
  f.state.subscribe('window-c', 'three', [{ ...interest, sessionId: 'task-b' }]);
  const build = vi.fn(() => ({ title: 'Working' }));
  for (let i = 0; i < 100; i++) f.state.publish('plugin', 'progress', { sessionId: 'task-a' }, build);
  await Promise.resolve();
  expect(build).toHaveBeenCalledTimes(100);
  expect(f.send.mock.calls.map(call => call[0])).toEqual(['window-a', 'window-b']);
  expect(f.send.mock.calls[0][2]).toHaveLength(1);
  const snapshot = f.state.subscribe('window-d', 'four', [interest]);
  expect(snapshot[0].state).toEqual({ title: 'Working' });
});

it('drops queued updates from revoked authority, replaced subscriptions, and old owners', async () => {
  for (const boundary of ['authority', 'subscription', 'owner'] as const) {
    const f = fixture(); f.state.subscribe('window-a', 'one', [interest]);
    f.state.publish('plugin', 'progress', undefined, () => ({ title: 'Old' }));
    if (boundary === 'authority') f.revoke();
    if (boundary === 'subscription') { f.state.release('window-a'); f.state.subscribe('window-a', 'two', [interest]); }
    if (boundary === 'owner') f.changeOwner();
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
  }
});

it('keeps an unchanged consumer snapshot across atomic replacement and discards old-owner state', async () => {
  const f = fixture();
  f.state.subscribe('window-a', 'one', [interest]);
  f.state.publish('plugin', 'progress', undefined, () => ({ title: 'Current' }));
  await Promise.resolve();
  expect(f.state.subscribe('window-a', 'two', [interest])[0]?.state).toEqual({ title: 'Current' });
  expect(f.demand).toHaveBeenCalledTimes(1);
  f.changeOwner();
  expect(f.state.subscribe('window-b', 'three', [interest])).toEqual([]);
  f.revoke();
  expect(f.state.consumers('plugin')).toBeUndefined();
});
