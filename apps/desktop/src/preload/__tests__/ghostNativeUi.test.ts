import { beforeEach, expect, it, vi } from 'vitest';
import type { PluginUiInterest, PluginUiControlState, PluginUiTarget } from '../../shared/pluginUi';

// 生产入口：真实 ghostPreload 的 cindy.ui；观察管子调用和作者数据构造。
// 规则依据：无人消费不引入通信；原 preload 测试没有覆盖这项新桥。
// 最小输入：无消费者发布、同一轮连续更新、ping 回包晚于新需求。tier: unit，无真实 Electron。
type Sdk = {
  ping(): Promise<unknown>;
  ui: {
    hasConsumers(id: string, target?: PluginUiTarget): boolean;
    updateContribution(id: string, build: () => PluginUiControlState, target?: PluginUiTarget): Promise<{ observed: boolean }>;
  };
};
const boundary = vi.hoisted(() => ({
  sdk: null as Sdk | null,
  receive: null as ((event: unknown, input: unknown) => void) | null,
  invoke: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, sdk: Sdk) => { boundary.sdk = sdk; } },
  ipcRenderer: { invoke: boundary.invoke, on: (_name: string, receive: typeof boundary.receive) => { boundary.receive = receive; } },
}));
import '../ghostPreload';

const demand = (consumers: PluginUiInterest[]) => boundary.receive?.({}, { type: 'ui-consumers', consumers });
const interest = { instanceId: 'plugin', id: 'progress', sessionId: 'task-a' };
beforeEach(() => { demand([]); boundary.invoke.mockReset().mockResolvedValue({ ok: true, observed: [true] }); });

it('does not construct or transmit an update without a consumer', async () => {
  const build = vi.fn(() => ({ title: 'Unused' }));
  expect(boundary.sdk!.ui.hasConsumers('progress')).toBe(false);
  await boundary.sdk!.ui.updateContribution('progress', build);
  expect(build).not.toHaveBeenCalled();
  expect(boundary.invoke).not.toHaveBeenCalled();
});

it('coalesces a burst before constructing and sending the latest demanded state', async () => {
  demand([interest]);
  const build = vi.fn(() => ({ title: 'Latest' }));
  const results = await Promise.all(Array.from({ length: 100 }, () => boundary.sdk!.ui.updateContribution('progress', build, { sessionId: 'task-a' })));
  expect(results.every(result => result.observed)).toBe(true);
  expect(build).toHaveBeenCalledTimes(1);
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith('ghost-pipe:send', {
    type: 'ui-state-update', updates: [{ id: 'progress', target: { sessionId: 'task-a' }, state: { title: 'Latest' } }],
  });
  demand([]);
  await boundary.sdk!.ui.updateContribution('progress', build);
  expect(build).toHaveBeenCalledTimes(1);
});

it('keeps only the latest pending state while a send is in flight', async () => {
  demand([interest]);
  let finish!: (result: unknown) => void;
  boundary.invoke.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  const first = boundary.sdk!.ui.updateContribution('progress', () => ({ title: 'First' }));
  await Promise.resolve();
  const superseded = vi.fn(() => ({ title: 'Superseded' }));
  const pending = boundary.sdk!.ui.updateContribution('progress', superseded);
  const latest = boundary.sdk!.ui.updateContribution('progress', () => ({ title: 'Last' }));
  expect(pending).toBe(latest);
  expect(boundary.invoke).toHaveBeenCalledTimes(1);
  finish({ ok: true, observed: [true] });
  await Promise.all([first, pending, latest]);
  expect(superseded).not.toHaveBeenCalled();
  expect(boundary.invoke).toHaveBeenCalledTimes(2);
  expect(boundary.invoke.mock.calls[1][1].updates[0].state).toEqual({ title: 'Last' });
});

it('does not let an old ping response overwrite a newer consumer removal', async () => {
  let resolve!: (result: unknown) => void;
  boundary.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const ping = boundary.sdk!.ping();
  demand([]);
  resolve({ ok: true, id: 'plugin', nativeUiConsumers: [interest] });
  await ping;
  expect(boundary.sdk!.ui.hasConsumers('progress')).toBe(false);
});
