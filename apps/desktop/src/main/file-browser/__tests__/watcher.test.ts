/**
 * watcher.test.ts — WatcherManager 的 stop 宽限期 / 串行化 / 事件过滤回归。
 *
 * 背景:2026-07-07 Release 崩溃定位到快速切 session 时同一 workdir 的
 * unsubscribe→紧接 re-subscribe(renderer useFileTree refCount 归零瞬间
 * stopWatch,React 先卸载旧面板再挂载新面板)。本测试锁死新语义:
 *   - stop 进入宽限期,期内 start 同 key 直接复活,native 层零操作
 *   - 宽限过后才真正 unsubscribe
 *   - 宽限期定时器已入队的 stop 被复活后作废(状态守卫)
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const h = vi.hoisted(() => ({
  matcherIgnores: vi.fn((_rel: string, _isDir: boolean) => false),
}));

vi.mock('@cindy/file-browser-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/file-browser-core')>();
  return {
    XDT_TMP_SUFFIX: actual.XDT_TMP_SUFFIX,
    // 预过滤名单的真名单(单源),loadIgnoreMatcher 太真(要读盘)才被替换。
    WATCH_ALWAYS_IGNORE: actual.WATCH_ALWAYS_IGNORE,
    loadIgnoreMatcher: vi.fn(async () => ({ ignores: h.matcherIgnores })),
  };
});

import { WatcherManager, type WatcherSubscribeFn } from '../watcher';
import type { WatchedFsEvent } from '../../watcher-host/protocol';

function makeWindow(id = 1): BrowserWindow {
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn(),
  } as unknown as BrowserWindow;
}

function setup() {
  const unsubscribe = vi.fn(async () => undefined);
  const calls: Array<{ dir: string; ignore: string[]; onEvents: (e: WatchedFsEvent[]) => void }> = [];
  const subscribeFn: WatcherSubscribeFn = vi.fn(async (dir, ignore, onEvents) => {
    calls.push({ dir, ignore, onEvents });
    return { unsubscribe };
  });
  const manager = new WatcherManager(subscribeFn);
  return { manager, subscribeFn, unsubscribe, calls };
}

describe('WatcherManager stop 宽限期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.matcherIgnores.mockReset();
    h.matcherIgnores.mockReturnValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start→stop→start 同 key 宽限期内:只 subscribe 一次,从不 unsubscribe(崩溃场景回归)', async () => {
    const { manager, subscribeFn, unsubscribe } = setup();
    const win = makeWindow();
    await manager.start(win, 'D:/repo', {}, vi.fn());
    await manager.stop(win.id, 'D:/repo');
    // 旧日志实测 stop→start 间隔 ~10ms
    await vi.advanceTimersByTimeAsync(10);
    await manager.start(win, 'D:/repo', {}, vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscribeFn).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('stop 宽限过后真正 unsubscribe;再 start 重新 subscribe', async () => {
    const { manager, subscribeFn, unsubscribe } = setup();
    const win = makeWindow();
    await manager.start(win, 'D:/repo', {}, vi.fn());
    await manager.stop(win.id, 'D:/repo');
    await vi.advanceTimersByTimeAsync(2_000); // > STOP_GRACE_MS(1500)
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await manager.start(win, 'D:/repo', {}, vi.fn());
    expect(subscribeFn).toHaveBeenCalledTimes(2);
  });

  it('宽限定时器触发后再 start → 先停旧订阅再重新 subscribe', async () => {
    const { manager, subscribeFn, unsubscribe } = setup();
    const win = makeWindow();
    await manager.start(win, 'D:/repo', {}, vi.fn());
    await manager.stop(win.id, 'D:/repo');
    // 定时器已触发意味着 1.5s 宽限已经结束；后续 start 应排在真实 stop 后重建。
    vi.advanceTimersByTime(1_500);
    await manager.start(win, 'D:/repo', {}, vi.fn());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeFn).toHaveBeenCalledTimes(2);
  });

  it('重复 stop 幂等(不叠加定时器)', async () => {
    const { manager, unsubscribe } = setup();
    const win = makeWindow();
    await manager.start(win, 'D:/repo', {}, vi.fn());
    await manager.stop(win.id, 'D:/repo');
    await manager.stop(win.id, 'D:/repo');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('订阅失败时队列清理 promise 不产生 unhandled rejection', async () => {
    const err = new Error('boom');
    const subscribeFn: WatcherSubscribeFn = vi.fn(async () => {
      throw err;
    });
    const manager = new WatcherManager(subscribeFn);
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    await expect(manager.start(makeWindow(), 'D:/repo', {}, vi.fn())).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(10);

    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('start 未完成前到达的 stop 会排队保留停止意图', async () => {
    const unsubscribe = vi.fn(async () => undefined);
    let resolveSubscribe!: (handle: { unsubscribe: () => Promise<void> }) => void;
    const subscribeFn: WatcherSubscribeFn = vi.fn(
      () => new Promise<{ unsubscribe: () => Promise<void> }>((resolve) => {
        resolveSubscribe = resolve;
      }),
    );
    const manager = new WatcherManager(subscribeFn);
    const win = makeWindow();

    const startPromise = manager.start(win, 'D:/repo', {}, vi.fn());
    const stopPromise = manager.stop(win.id, 'D:/repo');
    await vi.advanceTimersByTimeAsync(10);
    expect(unsubscribe).not.toHaveBeenCalled();

    resolveSubscribe({ unsubscribe });
    await startPromise;
    await stopPromise;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(subscribeFn).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('hideMetaFiles 变化触发完整重建(先拆后建,不吃宽限复用)', async () => {
    const { manager, subscribeFn, unsubscribe } = setup();
    const win = makeWindow();
    await manager.start(win, 'D:/repo', { hideMetaFiles: true }, vi.fn());
    await manager.start(win, 'D:/repo', { hideMetaFiles: false }, vi.fn());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeFn).toHaveBeenCalledTimes(2);
  });

  it('showIgnoredDirs 变化同样触发重建,相同则复用', async () => {
    const { manager, subscribeFn, unsubscribe } = setup();
    const win = makeWindow();
    await manager.start(win, 'D:/repo', { showIgnoredDirs: false }, vi.fn());
    // 同值重复 start:仍在宽限内,直接复用不重建。
    await manager.start(win, 'D:/repo', { showIgnoredDirs: false }, vi.fn());
    expect(subscribeFn).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    await manager.start(win, 'D:/repo', { showIgnoredDirs: true }, vi.fn());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeFn).toHaveBeenCalledTimes(2);
  });

  /**
   * 预过滤名单的「时机」回归:parcel 的 ignore 只在 subscribe 那一刻生效一次。
   * node_modules / Library 经常在会话开始后才出现(npm install / Unity 导入),
   * 当时不存在就漏掉 → 开关打开后这些目录被 matcher 放行,内部每个生成路径都
   * 变成一条事件推过 watcher-host + IPC。ALWAYS 名单必须无条件注册。
   */
  it('ALWAYS 目录当前不存在也进 ignore 名单(开关打开时)', async () => {
    const { manager, calls } = setup();
    const workdir = path.join(path.sep, 'no-such-workdir-reveal');
    await manager.start(makeWindow(), workdir, { showIgnoredDirs: true }, vi.fn());
    expect(calls[0].ignore).toEqual(
      expect.arrayContaining(['**/node_modules/**', '**/Library/**', '**/.git/**']),
    );
    // 开关打开时 REVEALABLE 不预过滤 —— 它们本来就该推事件。
    expect(calls[0].ignore).not.toContain('**/dist/**');
  });

  it('开关关闭时同样无条件带上 ALWAYS(目录稍后才出现也不漏)', async () => {
    const { manager, calls } = setup();
    const workdir = path.join(path.sep, 'no-such-workdir-hidden');
    await manager.start(makeWindow(), workdir, { showIgnoredDirs: false }, vi.fn());
    expect(calls[0].ignore).toEqual(
      expect.arrayContaining([
        '**/node_modules/**',
        '**/Library/**',
        '**/dist/**',
      ]),
    );
  });

  /**
   * 预过滤名单的「层级」回归:名单必须发 glob,不能发根级绝对路径。
   * @parcel/watcher 对非 glob 项走 `ignorePaths` 前缀比较 ——
   * `nested/node_modules/x` 不是 `/workdir/node_modules` 的后代,monorepo
   * (`packages/foo/node_modules`)与嵌套 Unity 工程(`client/Library`)会整目录
   * 漏过去,开关打开时每个生成文件都是一条事件推过 watcher-host + IPC。
   * glob 形态与层级无关,这里锁住这个形态(实测 2.5.6/win32:前缀形态零命中,
   * `**\/<name>/**` 全层级命中)。
   */
  it('预过滤用 glob 覆盖任意层级(不是根级绝对路径)', async () => {
    const { manager, calls } = setup();
    await manager.start(makeWindow(), 'D:/repo', { showIgnoredDirs: false }, vi.fn());
    expect(calls[0].ignore).toContain('**/node_modules/**');
    expect(calls[0].ignore).toContain('**/Library/**');
    expect(calls[0].ignore).not.toContain(path.join('D:/repo', 'node_modules'));
  });

  it('不同 window 同 workdir 互不干扰(key 维度 window×workdir)', async () => {
    const { manager, subscribeFn, unsubscribe } = setup();
    await manager.start(makeWindow(1), 'D:/repo', {}, vi.fn());
    await manager.start(makeWindow(2), 'D:/repo', {}, vi.fn());
    expect(subscribeFn).toHaveBeenCalledTimes(2);
    await manager.stop(1, 'D:/repo');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('WatcherManager 事件映射与过滤', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.matcherIgnores.mockReset();
    h.matcherIgnores.mockReturnValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('create/update/delete → add/change/unlink,相对路径 POSIX 化', async () => {
    const { manager, calls } = setup();
    const onEvent = vi.fn();
    const workdir = path.join(path.sep, 'repo');
    await manager.start(makeWindow(), workdir, {}, onEvent);
    calls[0].onEvents([
      { type: 'create', path: path.join(workdir, 'src', 'a.ts') },
      { type: 'update', path: path.join(workdir, 'b.md') },
      { type: 'delete', path: path.join(workdir, 'c.txt') },
    ]);
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenNthCalledWith(1, { workdir, type: 'add', relPath: 'src/a.ts' });
    expect(onEvent).toHaveBeenNthCalledWith(2, { workdir, type: 'change', relPath: 'b.md' });
    expect(onEvent).toHaveBeenNthCalledWith(3, { workdir, type: 'unlink', relPath: 'c.txt' });
  });

  it('.xdt-tmp 中间产物 / workdir 外路径 / matcher 命中 → 全部拦截', async () => {
    const { manager, calls } = setup();
    const onEvent = vi.fn();
    const workdir = path.join(path.sep, 'repo');
    await manager.start(makeWindow(), workdir, {}, onEvent);
    h.matcherIgnores.mockImplementation((rel: string) => rel === 'debug.log');
    calls[0].onEvents([
      { type: 'create', path: path.join(workdir, `x${'.xdt-tmp'}`) },
      { type: 'create', path: path.join(path.sep, 'elsewhere', 'y.txt') },
      { type: 'create', path: path.join(workdir, 'debug.log') },
    ]);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
