/**
 * remote-watch.test.ts — SSH 会话 watch 注册表的失败清理回归。
 *
 * 锁的不变量:切「显示被忽略的目录」会在同一个 key 上 stop→start,而两个
 * watchStart 请求都是异步的。旧请求迟到 reject 时只能回收**它自己装上的**
 * 注册,不能顺手删掉同 key 上的替换注册 —— 否则新注册变成孤儿:后续 stop()
 * 提前返回、事件 / 重连 listener 泄漏,daemon 侧 watch 也不会停,反复切换
 * 会累积重复订阅。
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

import type { RemoteFileBrowserManager } from '../remote.js';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { RemoteWatchRegistry } from '../remote-watch';

function makeWindow(id = 1): BrowserWindow {
  return { id, isDestroyed: () => false, once: vi.fn() } as unknown as BrowserWindow;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const request = vi.fn(async (): Promise<unknown> => undefined);
  // 每次订阅返回独立的退订 spy:断言必须分清「哪次 start 装上的 listener 被拆了」。
  const eventOffs: Array<ReturnType<typeof vi.fn>> = [];
  const reconnectOffs: Array<ReturnType<typeof vi.fn>> = [];
  const mgr = {
    request,
    onHostEvent: vi.fn(() => {
      const off = vi.fn();
      eventOffs.push(off);
      return off;
    }),
    onHostConnected: vi.fn(() => {
      const off = vi.fn();
      reconnectOffs.push(off);
      return off;
    }),
  } as unknown as RemoteFileBrowserManager;
  return { registry: new RemoteWatchRegistry(mgr), request, eventOffs, reconnectOffs };
}

describe('RemoteWatchRegistry 失败清理', () => {
  it('旧 watchStart 迟到失败不回收同 key 上的替换注册', async () => {
    const { registry, request, eventOffs, reconnectOffs } = setup();
    const win = makeWindow();
    const first = deferred();
    request.mockImplementationOnce(() => first.promise);

    const oldStart = registry.start(win, 'host-1', '/repo', { showIgnoredDirs: false }, vi.fn());
    // 开关切换:先停旧注册,再用新选项装一份替换注册(同一 key)。
    await registry.stop(win.id, 'host-1', '/repo');
    await registry.start(win, 'host-1', '/repo', { showIgnoredDirs: true }, vi.fn());
    expect(eventOffs).toHaveLength(2);

    first.reject(new Error('host unreachable'));
    await expect(oldStart).rejects.toThrow('host unreachable');

    // 替换注册仍在册:stop 能拆掉它,并给 daemon 发 watchStop。
    await registry.stop(win.id, 'host-1', '/repo');
    expect(request).toHaveBeenCalledWith('host-1', 'watchStop', {
      workdir: '/repo',
      consumerId: 'desktop-tree',
    });
    // 旧注册自己装的那对 listener:stop 拆一次 + 迟到失败清理一次。
    expect(eventOffs[0]).toHaveBeenCalledTimes(2);
    expect(reconnectOffs[0]).toHaveBeenCalledTimes(2);
    // 替换注册的那对:由最后的 stop 拆掉(旧 catch 不能替它做主)。
    expect(eventOffs[1]).toHaveBeenCalledTimes(1);
    expect(reconnectOffs[1]).toHaveBeenCalledTimes(1);
  });

  it('启动失败且没有替换注册:注册被回收,后续 stop 是 no-op', async () => {
    const { registry, request, eventOffs, reconnectOffs } = setup();
    const win = makeWindow();
    request.mockRejectedValueOnce(new Error('boom'));

    await expect(registry.start(win, 'host-1', '/repo', {}, vi.fn())).rejects.toThrow('boom');
    expect(eventOffs[0]).toHaveBeenCalledTimes(1);
    expect(reconnectOffs[0]).toHaveBeenCalledTimes(1);

    request.mockClear();
    await registry.stop(win.id, 'host-1', '/repo');
    expect(request).not.toHaveBeenCalled();
  });
});
