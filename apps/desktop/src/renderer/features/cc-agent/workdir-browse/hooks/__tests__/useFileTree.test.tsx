// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FileTreeEvent = { workdir: string; relPath: string };
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const mocks = vi.hoisted(() => {
  const eventCallbacks: Array<(event: FileTreeEvent) => void> = [];
  return {
    eventCallbacks,
    fileBrowserApiFor: vi.fn(),
    isDeviceTooOldError: vi.fn(() => false),
    listDir: vi.fn(),
    loadExpandedSet: vi.fn(() => new Set<string>()),
    deviceSupportsRevealIgnoredDirs: vi.fn(
      async (): Promise<boolean | null> => true,
    ),
    /** 重连代次:测试里改这个值 + rerender 就能驱动重探。 */
    reconnectEpoch: { current: 0 },
    onFileTreeEventFor: vi.fn(
      (_deviceId: string | null | undefined, cb: (event: FileTreeEvent) => void) => {
        eventCallbacks.push(cb);
        return () => {
          const index = eventCallbacks.indexOf(cb);
          if (index >= 0) eventCallbacks.splice(index, 1);
        };
      },
    ),
    saveExpandedSet: vi.fn(),
    startWatchFor: vi.fn(async () => undefined),
    stopWatchFor: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/fileBrowserTransport', () => ({
  deviceSupportsRevealIgnoredDirs: mocks.deviceSupportsRevealIgnoredDirs,
  fileBrowserApiFor: mocks.fileBrowserApiFor,
  isDeviceTooOldError: mocks.isDeviceTooOldError,
  onFileTreeEventFor: mocks.onFileTreeEventFor,
  startWatchFor: mocks.startWatchFor,
  stopWatchFor: mocks.stopWatchFor,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

// jsdom 里没有 window.electronAPI,真实 hook 会去订阅 presence —— 用可变代次替身。
vi.mock('@/features/device-link/useDeviceLinkReconnectEpoch', () => ({
  useDeviceLinkReconnectEpoch: () => mocks.reconnectEpoch.current,
}));

vi.mock('../../lib/expandedStore', () => ({
  loadExpandedSet: mocks.loadExpandedSet,
  saveExpandedSet: mocks.saveExpandedSet,
}));

import { useFileTree, type DirEntry } from '../useFileTree';

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useFileTree refresh scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventCallbacks.length = 0;
    mocks.fileBrowserApiFor.mockReturnValue({ listDir: mocks.listDir });
  });

  it('limits a directory refresh to one trailing scan during a watcher storm', async () => {
    const entries: readonly DirEntry[] = [
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
    ];
    const pending: Array<Deferred<readonly DirEntry[]>> = [];
    mocks.listDir.mockImplementation(() => {
      if (mocks.listDir.mock.calls.length === 1) return Promise.resolve(entries);
      const request = deferred<readonly DirEntry[]>();
      pending.push(request);
      return request.promise;
    });

    const view = renderHook(() => useFileTree({ workdir: '/workdir' }));
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));
    expect(mocks.listDir).toHaveBeenCalledTimes(1);
    const emitEvent = mocks.eventCallbacks[0];
    expect(emitEvent).toBeDefined();

    await act(async () => {
      emitEvent({ workdir: '/workdir', relPath: 'first.md' });
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    expect(mocks.listDir).toHaveBeenCalledTimes(2);

    await act(async () => {
      emitEvent({ workdir: '/workdir', relPath: 'second.md' });
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    pending[0].resolve(entries);
    await waitFor(() => expect(mocks.listDir).toHaveBeenCalledTimes(3));

    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        emitEvent({ workdir: '/workdir', relPath: `storm-${i}.md` });
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    expect(mocks.listDir).toHaveBeenCalledTimes(3);

    await act(async () => {
      pending[1].resolve(entries);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.loadingPaths.size).toBe(0));
    expect(mocks.listDir).toHaveBeenCalledTimes(3);

    view.unmount();
  });
});

/**
 * 「显示被忽略的目录」开关:作为 store key 的一部分,不同取值必须拿到各自
 * 的 store 与 listDir / watch 参数,不能互相污染。
 */
describe('useFileTree showIgnoredDirs option', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventCallbacks.length = 0;
    mocks.listDir.mockResolvedValue([]);
    mocks.fileBrowserApiFor.mockReturnValue({ listDir: mocks.listDir });
  });

  it('listDir / startWatch 带上开关值', async () => {
    const view = renderHook(() =>
      useFileTree({ workdir: '/workdir-reveal', showIgnoredDirs: true }),
    );
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));
    expect(mocks.listDir).toHaveBeenCalledWith(
      expect.objectContaining({ workdir: '/workdir-reveal', showIgnoredDirs: true }),
    );
    expect(mocks.startWatchFor).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ workdir: '/workdir-reveal', showIgnoredDirs: true }),
    );
    view.unmount();
  });

  it('开关不同 = 两份独立 store(互不共用 entries)', async () => {
    const hidden = renderHook(() => useFileTree({ workdir: '/workdir-split' }));
    const revealed = renderHook(() =>
      useFileTree({ workdir: '/workdir-split', showIgnoredDirs: true }),
    );
    await waitFor(() => expect(hidden.result.current.initialLoading).toBe(false));
    await waitFor(() => expect(revealed.result.current.initialLoading).toBe(false));
    // 两个 store 各自拉了一次根目录。
    expect(mocks.listDir).toHaveBeenCalledTimes(2);
    expect(
      mocks.listDir.mock.calls.map((c) => c[0].showIgnoredDirs),
    ).toEqual([false, true]);
    hidden.unmount();
    revealed.unmount();
  });

  /**
   * 展开态持久化同样按开关分片:否则放行态展开过 node_modules / Library 后切回
   * 隐藏态,init 会把它们当"已展开"并行 listDir(评审 P2)。
   */
  it('expanded 持久化按开关分片读取', async () => {
    const hidden = renderHook(() => useFileTree({ workdir: '/workdir-scope' }));
    await waitFor(() => expect(hidden.result.current.initialLoading).toBe(false));
    expect(mocks.loadExpandedSet).toHaveBeenCalledWith('/workdir-scope', {
      showIgnoredDirs: false,
    });
    hidden.unmount();

    const revealed = renderHook(() =>
      useFileTree({ workdir: '/workdir-scope', showIgnoredDirs: true }),
    );
    await waitFor(() => expect(revealed.result.current.initialLoading).toBe(false));
    expect(mocks.loadExpandedSet).toHaveBeenCalledWith('/workdir-scope', {
      showIgnoredDirs: true,
    });
    revealed.unmount();
  });

  /**
   * 切开关会换一份 store。新 store 若从空快照 + initialLoading 起步，FileTreeView
   * 会把整树替换成空白占位（本地 <300ms 连 spinner 都没有），视觉上闪一下；
   * 「刷新」按钮原地 refetch 所以不闪。新 store 必须继承兄弟 store 的整棵可见树，
   * 等新 matcher 的数据回来再整体替换（不是只借根列表，见下一条）。
   */
  it('切开关继承整棵可见树，不回到 initialLoading 空白', async () => {
    const hiddenEntries: readonly DirEntry[] = [
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
    ];
    const revealedEntries: readonly DirEntry[] = [
      { name: 'node_modules', relPath: 'node_modules', type: 'directory', size: 0, mtimeMs: 1 },
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
    ];
    // 切开关后钩住新 matcher 的 listDir：验证“数据还没回来”的那一帧。
    const pending = deferred<readonly DirEntry[]>();
    mocks.listDir.mockImplementation((args: { showIgnoredDirs?: boolean }) =>
      args.showIgnoredDirs ? pending.promise : Promise.resolve(hiddenEntries),
    );

    const view = renderHook(
      ({ reveal }: { reveal: boolean }) =>
        useFileTree({ workdir: '/workdir-seed', showIgnoredDirs: reveal }),
      { initialProps: { reveal: false } },
    );
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));
    expect(view.result.current.entries.get('')).toEqual(hiddenEntries);

    await act(async () => {
      view.rerender({ reveal: true });
    });
    // 新 matcher 的数据尚未回来：这一帧就该有 seed 的旧树且不在 loading。
    expect(view.result.current.initialLoading).toBe(false);
    expect(view.result.current.entries.get('')).toEqual(hiddenEntries);

    await act(async () => {
      pending.resolve(revealedEntries);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.entries.get('')).toEqual(revealedEntries));

    view.unmount();
  });

  /**
   * 关开关的首帧就要滤掉内置忽略目录:慢通道下不能等新 matcher 的数据回来,
   * 否则「开关关了却还看得见 node_modules」会持续数秒。子树缓存与展开集合不
   * 动(父行不在根列表里 → 整棵子树同帧不可达,与「一次性消失」一致)。
   */
  it('关开关首帧就滤掉被忽略目录,不等新数据', async () => {
    const revealedRoot: readonly DirEntry[] = [
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
      { name: 'node_modules', relPath: 'node_modules', type: 'directory', size: 0, mtimeMs: 1 },
      { name: 'README.md', relPath: 'README.md', type: 'file', size: 10, mtimeMs: 1 },
    ];
    const pendingRoot = deferred<readonly DirEntry[]>();
    mocks.listDir.mockImplementation((args: { showIgnoredDirs?: boolean }) =>
      args.showIgnoredDirs ? Promise.resolve(revealedRoot) : pendingRoot.promise,
    );

    const view = renderHook(
      ({ reveal }: { reveal: boolean }) =>
        useFileTree({ workdir: '/workdir-seed-filter', showIgnoredDirs: reveal }),
      { initialProps: { reveal: true } },
    );
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));

    await act(async () => {
      view.rerender({ reveal: false });
    });

    // 数据还没回来,但被忽略目录已不在根列表;其余行照旧。
    expect(view.result.current.entries.get('')?.map((e) => e.name)).toEqual(['src', 'README.md']);

    view.unmount();
  });

  /**
   * 关开关的消失动作必须是一次性的：过渡期（hidden 数据还没回来）树保持不动
   * —— 展开态与子树缓存都还在 —— 而不是先丢子行再丢父行（那是「从最子级逐级
   * 折叠」）；被忽略的一级目录行由首帧过滤直接拿掉（见上一条），剩下的部分等
   * root 数据回来整体替换，并把借来的 reveal-only 展开位剪掉：hidden 树下
   * node_modules 已不在 root 列表里，留着会随下次操作写进 hidden scope 的
   * localStorage，下次启动白发一批 listDir。
   */
  it('关开关整树保持到数据回来，再一次性替换并剪掉 reveal-only 展开位', async () => {
    const revealedRoot: readonly DirEntry[] = [
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
      { name: 'node_modules', relPath: 'node_modules', type: 'directory', size: 0, mtimeMs: 1 },
    ];
    const revealedChild: readonly DirEntry[] = [
      { name: 'pkg', relPath: 'node_modules/pkg', type: 'directory', size: 0, mtimeMs: 1 },
    ];
    const hiddenRoot: readonly DirEntry[] = [
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
    ];
    mocks.listDir.mockImplementation((args: { relPath?: string; showIgnoredDirs?: boolean }) => {
      if (args.showIgnoredDirs) {
        return Promise.resolve(args.relPath === 'node_modules' ? revealedChild : revealedRoot);
      }
      return Promise.resolve(hiddenRoot);
    });

    const view = renderHook(
      ({ reveal }: { reveal: boolean }) =>
        useFileTree({ workdir: '/workdir-seed-swap', showIgnoredDirs: reveal }),
      { initialProps: { reveal: true } },
    );
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));
    await act(async () => {
      view.result.current.toggleFolder('node_modules');
    });
    expect(view.result.current.expanded.has('node_modules')).toBe(true);

    // 过渡期：挂住 hidden 侧的 root listDir，模拟慢通道。
    const pendingRoot = deferred<readonly DirEntry[]>();
    mocks.listDir.mockImplementation((args: { showIgnoredDirs?: boolean }) => {
      if (args.showIgnoredDirs) return Promise.resolve(revealedRoot);
      return pendingRoot.promise;
    });
    mocks.listDir.mockClear();

    await act(async () => {
      view.rerender({ reveal: false });
    });

    // 数据还没回来：被忽略行已由首帧过滤拿掉，子树缓存与展开态保持不动
    // （树其余部分不重新挂载，不是逐级折叠）。
    expect(view.result.current.initialLoading).toBe(false);
    expect(view.result.current.entries.get('')?.map((e) => e.name)).toEqual(['src']);
    expect(view.result.current.entries.get('node_modules')).toEqual(revealedChild);
    expect(view.result.current.expanded.has('node_modules')).toBe(true);
    // 过渡期不 warm 借来的子树 —— 不给被忽略路径白发 listDir。
    const hiddenCalls = mocks.listDir.mock.calls.filter((c) => c[0].showIgnoredDirs === false);
    expect(hiddenCalls.map((c) => c[0].relPath)).toEqual(['']);

    await act(async () => {
      pendingRoot.resolve(hiddenRoot);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.entries.get('')).toEqual(hiddenRoot));
    // 整体替换完成：借来的 reveal-only 展开位被剪掉。
    expect(view.result.current.expanded.has('node_modules')).toBe(false);

    view.unmount();
  });

  /**
   * 兄弟 store 还在首次 listDir 上（慢通道）时不能冒充「已加载」：没有可显示内容
   * 就保持 initialLoading，否则 FileTreeView 会把空 rows 渲染成「此文件夹为空」
   * 而不是延迟 loading 态。
   */
  it('兄弟 store 还没有首帧数据时保持 initialLoading', async () => {
    const pendingReveal = deferred<readonly DirEntry[]>();
    const pendingHidden = deferred<readonly DirEntry[]>();
    mocks.listDir.mockImplementation((args: { showIgnoredDirs?: boolean }) =>
      args.showIgnoredDirs ? pendingReveal.promise : pendingHidden.promise,
    );

    const view = renderHook(
      ({ reveal }: { reveal: boolean }) =>
        useFileTree({ workdir: '/workdir-seed-pending', showIgnoredDirs: reveal }),
      { initialProps: { reveal: true } },
    );
    expect(view.result.current.initialLoading).toBe(true);

    await act(async () => {
      view.rerender({ reveal: false });
    });
    // 兄弟 store 存在但没有可显示内容 → hidden 侧必须继续 loading。
    expect(view.result.current.initialLoading).toBe(true);

    await act(async () => {
      pendingHidden.resolve([
        { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
      ]);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));

    view.unmount();
  });
});

/**
 * device-link 能力探测:老被控端的 listDir 会静默忽略 showIgnoredDirs ——
 * 开关看起来按下去了、树里什么也不变。探到不支持就按隐藏态建 store,并把结论
 * expose 给标题行(禁用 + 说明原因)。
 */
describe('useFileTree device 的 showIgnoredDirs 能力探测', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventCallbacks.length = 0;
    mocks.listDir.mockResolvedValue([]);
    mocks.fileBrowserApiFor.mockReturnValue({ listDir: mocks.listDir });
    mocks.deviceSupportsRevealIgnoredDirs.mockImplementation(async () => true);
    mocks.reconnectEpoch.current = 0;
  });

  it('老被控端:按隐藏态建 store,并 expose supported=false', async () => {
    mocks.deviceSupportsRevealIgnoredDirs.mockImplementation(async () => false);
    const view = renderHook(() =>
      useFileTree({ workdir: '/workdir-old-device', deviceId: 'device-1', showIgnoredDirs: true }),
    );
    await waitFor(() => expect(view.result.current.showIgnoredDirsSupported).toBe(false));

    expect(mocks.deviceSupportsRevealIgnoredDirs).toHaveBeenCalledWith(
      'device-1',
      '/workdir-old-device',
    );
    await waitFor(() =>
      expect(mocks.listDir).toHaveBeenCalledWith(
        expect.objectContaining({ showIgnoredDirs: false }),
      ),
    );
    // 探测返回前可能已用偏好值乐观拉过一次;落定之后不能再发无效字段。
    const calls = mocks.listDir.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][0].showIgnoredDirs).toBe(false);
    view.unmount();
  });

  it('支持的被控端:开关照常生效,supported=true', async () => {
    const view = renderHook(() =>
      useFileTree({ workdir: '/workdir-new-device', deviceId: 'device-2', showIgnoredDirs: true }),
    );
    await waitFor(() => expect(view.result.current.showIgnoredDirsSupported).toBe(true));
    await waitFor(() =>
      expect(mocks.listDir).toHaveBeenCalledWith(
        expect.objectContaining({ showIgnoredDirs: true }),
      ),
    );
    view.unmount();
  });

  it('本地会话不做探测,supported 恒为 true', async () => {
    const view = renderHook(() => useFileTree({ workdir: '/workdir-local' }));
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));
    expect(view.result.current.showIgnoredDirsSupported).toBe(true);
    expect(mocks.deviceSupportsRevealIgnoredDirs).not.toHaveBeenCalled();
    view.unmount();
  });

  /**
   * 瞬态失败(隧道不可达 / 重连中)不能被当成「对方版本过旧」:那会把开关错误地
   * 禁用并显示升级提示，而连接恢复后也不会自愈。保持「未知」(不禁用) + 由
   * 重连代次驱动重探。
   */
  it('瞬态失败保持未知并在重连后重探', async () => {
    mocks.reconnectEpoch.current = 0;
    mocks.deviceSupportsRevealIgnoredDirs.mockImplementation(async () => null);
    const view = renderHook(() =>
      useFileTree({ workdir: '/workdir-flaky', deviceId: 'device-flaky', showIgnoredDirs: true }),
    );
    await waitFor(() => expect(mocks.deviceSupportsRevealIgnoredDirs).toHaveBeenCalledTimes(1));
    expect(view.result.current.showIgnoredDirsSupported).toBe(null);
    // 未知 = 不禁用：树仍按用户偏好(开)建 store。
    await waitFor(() =>
      expect(mocks.listDir).toHaveBeenCalledWith(
        expect.objectContaining({ showIgnoredDirs: true }),
      ),
    );

    // 连接恢复 → 重连代次自增 → 重新探测并落定。
    mocks.deviceSupportsRevealIgnoredDirs.mockImplementation(async () => true);
    mocks.reconnectEpoch.current = 1;
    view.rerender();
    await waitFor(() => expect(view.result.current.showIgnoredDirsSupported).toBe(true));
    // 重连代次驱动的「重问」;缓存是否命中由 transport 自己按全局 reconnect 流记账
    // (不依赖 hook 生命周期,见 fileBrowserTransport 的进程级重连代次)。
    expect(mocks.deviceSupportsRevealIgnoredDirs).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('已定的「不支持」不会被重连代次重置成未知(开关不闪)', async () => {
    mocks.reconnectEpoch.current = 0;
    mocks.deviceSupportsRevealIgnoredDirs.mockImplementation(async () => false);
    const view = renderHook(() =>
      useFileTree({ workdir: '/workdir-old2', deviceId: 'device-old2', showIgnoredDirs: true }),
    );
    await waitFor(() => expect(view.result.current.showIgnoredDirsSupported).toBe(false));

    mocks.reconnectEpoch.current = 1;
    view.rerender();
    await waitFor(() => expect(mocks.deviceSupportsRevealIgnoredDirs).toHaveBeenCalledTimes(2));
    expect(view.result.current.showIgnoredDirsSupported).toBe(false);

    // 旧端升级后重连 → 结论改成支持。
    mocks.deviceSupportsRevealIgnoredDirs.mockImplementation(async () => true);
    mocks.reconnectEpoch.current = 2;
    view.rerender();
    await waitFor(() => expect(view.result.current.showIgnoredDirsSupported).toBe(true));
    view.unmount();
  });
});
