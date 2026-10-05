import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  expose: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    sendSync: vi.fn(() => null),
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
