import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  HOST_DAEMONS_DELETE_CHANNEL,
  HOST_DAEMONS_LIST_CHANNEL,
  HOST_DAEMONS_STOP_CHANNEL,
} from '../../shared/hostDaemons';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  expose: vi.fn(),
  invoke: vi.fn(async () => undefined),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    sendSync: vi.fn(() => null),
    invoke: mocks.invoke,
    on: (channel: string, callback: (event: unknown, payload: unknown) => void) => {
      if (!mocks.listeners.has(channel)) mocks.listeners.set(channel, new Set());
      mocks.listeners.get(channel)!.add(callback);
    },
    removeListener: (channel: string, callback: (event: unknown, payload: unknown) => void) =>
      mocks.listeners.get(channel)?.delete(callback),
  },
}));

function emit(hidden: boolean) {
  for (const listener of mocks.listeners.get('window-hidden-change') ?? []) listener({}, hidden);
}
describe.each(['resource', 'sidebar'])('prewarmed %s window visibility', (kind) => {
  let subscribe: (callback: (hidden: boolean) => void) => () => void;
  beforeAll(async () => {
    mocks.listeners.clear();
    if (kind === 'resource') await import('../resourceUsagePreload');
    else await import('../sidebarWindowPreload');
    subscribe = mocks.expose.mock.calls.at(-1)![1].onWindowHiddenChange;
  });
  it('starts hidden before the lazy renderer or first broadcast', () => {
    const listener = vi.fn();
    const off = subscribe(listener);
    expect(listener).toHaveBeenCalledWith(true);
    off();
  });
  it('replays a broadcast that arrived before subscription and unsubscribes cleanly', () => {
    emit(false);
    const listener = vi.fn();
    const off = subscribe(listener);
    expect(listener).toHaveBeenLastCalledWith(false);
    emit(true);
    expect(listener).toHaveBeenLastCalledWith(true);
    off();
    emit(false);
    expect(listener).toHaveBeenCalledTimes(2);
    const remount = vi.fn();
    subscribe(remount)();
    expect(remount).toHaveBeenCalledWith(false);
  });
});

/**
 * 资源监视器是独立窗口，用它自己的 preload：主窗口的 `electronAPI` 在这里不可见。
 * 漏在这里挂桥，renderer 拿到的 `hostDaemons` 是 undefined，页签永远显示“读取失败”。
 */
describe('resource usage window host daemons bridge', () => {
  it('forwards list/stop/remove through the shared channels', async () => {
    await import('../resourceUsagePreload');
    const exposed = [...mocks.expose.mock.calls]
      .reverse()
      .map(([, api]) => (api as { hostDaemons?: Record<string, (arg?: unknown) => Promise<unknown>> })
        .hostDaemons)
      .find(Boolean);
    expect(exposed).toBeDefined();

    mocks.invoke.mockClear();
    await exposed!.list();
    await exposed!.stop({ id: '\\demo' });
    await exposed!.remove({ id: '\\demo' });

    expect(mocks.invoke.mock.calls).toEqual([
      [HOST_DAEMONS_LIST_CHANNEL],
      [HOST_DAEMONS_STOP_CHANNEL, { id: '\\demo' }],
      [HOST_DAEMONS_DELETE_CHANNEL, { id: '\\demo' }],
    ]);
  });
});
