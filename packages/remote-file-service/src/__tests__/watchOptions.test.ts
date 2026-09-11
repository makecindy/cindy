/**
 * watchOptions.test.ts — daemon 侧 WorkdirWatchManager 的过滤开关语义。
 *
 * 背景:文件树新增「显示被忽略的目录」开关(showIgnoredDirs)。远端 daemon 的
 * watcher 在 watchStart 时就把 matcher 固定下来,所以:
 *   - 重复 watchStart 且开关未变 → 幂等,不重建原生 watcher;
 *   - 开关变了 → 必须重建 matcher(否则控制端改了开关、watch 仍按旧规则过滤,
 *     目录能列出来但内部改动永远没有事件)。
 *
 * 这里用假 `watch` + 假 loadIgnoreMatcher 锁定这两个语义,不依赖真实 fs 事件
 * (真机 Windows / Node 24 的 recursive fs.watch 本身有原生断言崩溃,见
 * rpc.test.ts 的 watchStart 用例)。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

interface FakeWatcher {
  on: (event: string, cb: (err: Error | null, filename: string | null) => void) => void;
  close: () => void;
}

const h = vi.hoisted(() => {
  const created: Array<{ dir: string; watcher: FakeWatcher; closed: boolean }> = [];
  return {
    created,
    /** loadIgnoreMatcher 收到的选项(按调用顺序)。 */
    matcherOpts: [] as Array<Record<string, unknown>>,
    watchSpy: vi.fn((dir: string) => {
      const watcher: FakeWatcher = { on: vi.fn(), close: vi.fn() };
      const record = { dir, watcher, closed: false };
      (watcher.close as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        record.closed = true;
      });
      created.push(record);
      return watcher;
    }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: h.watchSpy };
});

vi.mock('@cindy/file-browser-core', () => ({
  XDT_TMP_SUFFIX: '.xdt-tmp',
  scopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  loadIgnoreMatcher: vi.fn(async (_workdir: string, opts: Record<string, unknown>) => {
    h.matcherOpts.push(opts);
    return { ignores: () => false };
  }),
}));

import { WorkdirWatchManager } from '../watch';

describe('WorkdirWatchManager 过滤开关', () => {
  beforeEach(() => {
    h.created.length = 0;
    h.matcherOpts.length = 0;
    h.watchSpy.mockClear();
  });

  it('同 workdir 同选项重复 start 幂等,不重建原生 watcher', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', { hideMetaFiles: true, showIgnoredDirs: false });
    await manager.start('/repo', { hideMetaFiles: true, showIgnoredDirs: false });
    expect(h.watchSpy).toHaveBeenCalledTimes(1);
    expect(h.matcherOpts).toHaveLength(1);
    expect(h.created[0].closed).toBe(false);
    manager.stopAll();
  });

  it('showIgnoredDirs 变化触发重建:旧 watcher 关闭 + matcher 用新开关重建', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', { showIgnoredDirs: false });
    await manager.start('/repo', { showIgnoredDirs: true });

    expect(h.created[0].closed).toBe(true);
    expect(h.watchSpy).toHaveBeenCalledTimes(2);
    expect(h.matcherOpts[0].showIgnoredDirs).toBe(false);
    expect(h.matcherOpts[1].showIgnoredDirs).toBe(true);
    manager.stopAll();
  });

  it('start 的过滤开关原样落到 matcher(hideMetaFiles 默认 true)', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', {});
    expect(h.matcherOpts[0]).toMatchObject({ hideMetaFiles: true, showIgnoredDirs: false });
    manager.stopAll();
  });
});
