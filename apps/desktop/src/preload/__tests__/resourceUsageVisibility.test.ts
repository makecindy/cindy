import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  HOST_DAEMONS_CHANGED_EVENT,
  HOST_DAEMONS_DELETE_CHANNEL,
  HOST_DAEMONS_REFRESH_CHANNEL,
  HOST_DAEMONS_RUN_CHANNEL,
  HOST_DAEMONS_STOP_CHANNEL,
  HOST_DAEMONS_SUBSCRIBE_CHANNEL,
  HOST_DAEMONS_UNSUBSCRIBE_CHANNEL,
} from '../../shared/hostDaemons';

const PRELOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type ExposedHostDaemons = Record<
  string,
  ((arg?: unknown) => Promise<unknown>) | (() => () => void)
>;

function exposedHostDaemons(): ExposedHostDaemons {
  return [...mocks.expose.mock.calls]
    .reverse()
    .map(([, api]) => (api as { hostDaemons?: ExposedHostDaemons }).hostDaemons)
    .find(Boolean)!;
}

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
  it('forwards refresh/stop/run/remove/subscribe through the shared channels', async () => {
    await import('../resourceUsagePreload');
    const exposed = exposedHostDaemons();

    mocks.invoke.mockClear();
    await exposed.refresh();
    await exposed.stop({ id: '\\demo' });
    await exposed.run({ id: '\\demo' });
    await exposed.remove({ id: '\\demo' });
    await exposed.subscribe();
    await exposed.unsubscribe();

    expect(mocks.invoke.mock.calls).toEqual([
      [HOST_DAEMONS_REFRESH_CHANNEL],
      [HOST_DAEMONS_STOP_CHANNEL, { id: '\\demo' }],
      [HOST_DAEMONS_RUN_CHANNEL, { id: '\\demo' }],
      [HOST_DAEMONS_DELETE_CHANNEL, { id: '\\demo' }],
      [HOST_DAEMONS_SUBSCRIBE_CHANNEL],
      [HOST_DAEMONS_UNSUBSCRIBE_CHANNEL],
    ]);
  });

  it('hands out host daemons changes only while a listener is subscribed', async () => {
    await import('../resourceUsagePreload');
    const exposed = exposedHostDaemons();

    const listener = vi.fn();
    const off = exposed.onChanged(listener as () => void) as () => void;
    for (const handler of mocks.listeners.get(HOST_DAEMONS_CHANGED_EVENT) ?? []) handler({}, undefined);
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    expect(mocks.listeners.get(HOST_DAEMONS_CHANGED_EVENT)?.size ?? 0).toBe(0);
  });

  /**
   * 同一个页签挂在多个窗口里；主窗口的 preload 体量太大，测试不直接加载，按源码核对它暴露的
   * 方法与资源窗口 preload 实际暴露的完全一致，少一个方法页面就会在运行时报错。
   */
  it('exposes the same host daemons surface in every window preload', async () => {
    await import('../resourceUsagePreload');
    const expected = Object.keys(exposedHostDaemons()).sort();

    const blocks = fs.readdirSync(PRELOAD_DIR)
      .filter(file => file.endsWith('.ts'))
      .flatMap((file) => {
        const source = fs.readFileSync(path.join(PRELOAD_DIR, file), 'utf8');
        const match = /^([ \t]*)hostDaemons: \{$/m.exec(source);
        if (!match) return [];
        const end = source.indexOf(`\n${match[1]}},`, match.index);
        const names = [...source.slice(source.indexOf('\n', match.index), end).matchAll(/^ +(\w+):/gm)].map(m => m[1]).sort();
        return [{ file, names }];
      });

    expect(blocks.map(block => block.file).sort()).toEqual(['preload.ts', 'resourceUsagePreload.ts']);
    for (const { file, names } of blocks) expect(names, file).toEqual(expected);
  });
});
