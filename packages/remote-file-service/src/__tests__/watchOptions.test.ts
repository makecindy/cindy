/**
 * watchOptions.test.ts — daemon 侧 WorkdirWatchManager 的过滤开关语义。
 *
 * 背景:文件树新增「显示被忽略的目录」开关(showIgnoredDirs)。远端 daemon 的
 * watcher 在 watchStart 时就把 matcher 固定下来,所以:
 *   - 重复 watchStart 且开关未变 → 幂等,不重建原生 watcher;
 *   - 开关变了 → 必须重建 matcher(否则控制端改了开关、watch 仍按旧规则过滤,
 *     目录能列出来但内部改动永远没有事件);
 *   - 启动窗口内到达的 stop + 带新选项的 start → 必须收敛到新选项,且不能
 *     留下「没有 watcher」的空档(两个 RPC 都报 success 的静默失效);
 *   - node_modules / Library 内部改动永远不推事件(事件侧恒真层):fs.watch
 *     recursive 会把它们照单全推,daemon 侧没有 desktop 的 parcel 预过滤兜底。
 *
 * 这里用假 `watch` + 假 loadIgnoreMatcher 锁定这些语义,不依赖真实 fs 事件
 * (真机 Windows / Node 24 的 recursive fs.watch 本身有原生断言崩溃,见
 * rpc.test.ts 的 watchStart 用例)。事件侧恒真层用**真实现**(纯函数、不读盘),
 * 只有真正要读盘的 loadIgnoreMatcher 被替换掉。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

type FsWatchCallback = (eventType: string, filename: string | null) => void;

interface FakeWatcher {
  on: (event: string, cb: (err: Error | null, filename: string | null) => void) => void;
  close: () => void;
}

const h = vi.hoisted(() => {
  const created: Array<{
    dir: string;
    watcher: FakeWatcher;
    closed: boolean;
    cb: FsWatchCallback | null;
  }> = [];
  return {
    created,
    /** loadIgnoreMatcher 收到的选项(按调用顺序)。 */
    matcherOpts: [] as Array<Record<string, unknown>>,
    /** 非零时接下来 N 次 loadIgnoreMatcher 直接 reject(模拟挂载不可用)。 */
    failNext: 0,
    /** 门闩:非空时下一次 loadIgnoreMatcher 等它放行(模拟读盘未完成)。 */
    gate: null as Promise<void> | null,
    watchSpy: vi.fn((dir: string, _opts: unknown, cb: FsWatchCallback) => {
      const watcher: FakeWatcher = { on: vi.fn(), close: vi.fn() };
      const record = { dir, watcher, closed: false, cb };
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

vi.mock('@cindy/file-browser-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/file-browser-core')>();
  return {
    // 恒真层 / 后缀常量用真实现:前者的匹配语义(目录模式含后代)正是被测目标。
    createEventIgnoreMatcher: actual.createEventIgnoreMatcher,
    WATCH_ALWAYS_IGNORE: actual.WATCH_ALWAYS_IGNORE,
    XDT_TMP_SUFFIX: actual.XDT_TMP_SUFFIX,
    scopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    loadIgnoreMatcher: vi.fn(async (_workdir: string, opts: Record<string, unknown>) => {
      h.matcherOpts.push(opts);
      if (h.failNext > 0) {
        h.failNext -= 1;
        throw new Error('matcher load failed');
      }
      const gate = h.gate;
      if (gate) {
        h.gate = null;
        await gate;
      }
      // 工作区 matcher 由测试单独控制(真实现要读盘)。
      return { ignores: (rel: string) => rel.startsWith('hidden/') };
    }),
  };
});

import { WorkdirWatchManager } from '../watch';
import type { RemoteFileTreeEvent } from '../watch';

/** 触发一次原生事件,并等 coalesce 窗口(50ms)把批次吐出来。 */
async function fireEvent(
  record: (typeof h.created)[number],
  eventType: string,
  filename: string,
): Promise<RemoteFileTreeEvent[]> {
  record.cb?.(eventType, filename);
  await new Promise((resolve) => setTimeout(resolve, 120));
  return emitted;
}

let emitted: RemoteFileTreeEvent[] = [];

describe('WorkdirWatchManager 过滤开关', () => {
  beforeEach(() => {
    h.created.length = 0;
    h.matcherOpts.length = 0;
    h.failNext = 0;
    h.gate = null;
    h.watchSpy.mockClear();
    emitted = [];
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

  /**
   * 竞态回归(评审 P1):控制端切开关时 renderer 是「先 stop 再带新选项 start」。
   * 若首个 watchStart 的 matcher 还在加载中,旧实现会复用那个 promise —— 新选项
   * 被丢掉,而 stop 打的 stopDuringStart 标记又让那个 watcher 自拆,最终两边都
   * 报 success 却**没有 watcher**。现在必须收敛到新选项。
   */
  it('启动窗口内 stop + 带新选项 start:收敛到新选项且留下活着的 watcher', async () => {
    const manager = new WorkdirWatchManager((event) => emitted.push(event));
    let release = (): void => {};
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = manager.start('/repo', { showIgnoredDirs: false });
    // 启动未落地:此刻 stop(renderer 的 effect cleanup)再 start(新选项)。
    const stopped = Promise.resolve(manager.stop('/repo'));
    const second = manager.start('/repo', { showIgnoredDirs: true });

    release();
    await Promise.all([first, stopped, second]);

    // 旧实现:只建 1 个且已关 → 覆盖「没有 watcher」。新实现:旧的自拆,新的活着。
    expect(h.created).toHaveLength(2);
    expect(h.created[0].closed).toBe(true);
    expect(h.created[1].closed).toBe(false);
    expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(true);

    // 新 watcher 是活的:事件能按新 matcher 推出来。
    const emittedEvents = await fireEvent(h.created[1], 'change', 'build/app.js');
    expect(emittedEvents.some((e) => e.relPath === 'build/app.js')).toBe(true);
    manager.stopAll();
  });

  it('启动窗口内 stop 后没有新 start:不留 watcher,也不复活', async () => {
    const manager = new WorkdirWatchManager(() => {});
    let release = (): void => {};
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = manager.start('/repo', { showIgnoredDirs: true });
    manager.stop('/repo');
    release();
    await first;

    expect(h.created.every((c) => c.closed)).toBe(true);
    manager.stopAll();
  });

  /**
   * 评审 P1:开关打开后 daemon 曾把 node_modules / Library 也放行给事件过滤,
   * fs.watch recursive 会把装依赖 / Unity 导入的每个路径都推成 fileTree 帧过
   * SSH。事件侧必须保留恒真层(与 desktop 的 PREFILTER_ALWAYS 同名单)。
   */
  it('开关打开也不推 node_modules / Library 的事件,但放行 build / dist', async () => {
    const manager = new WorkdirWatchManager((event) => emitted.push(event));
    await manager.start('/repo', { showIgnoredDirs: true });
    const record = h.created[0];

    for (const rel of ['node_modules/react/index.js', 'Library/ScriptAssemblies/a.dll']) {
      expect(await fireEvent(record, 'change', rel), rel).toHaveLength(0);
    }
    // 正对照:开关要放行的构建产物仍然推事件(否则这个开关在远端等于没生效)。
    const buildEvents = await fireEvent(record, 'change', 'build/app.js');
    expect(buildEvents.map((e) => e.relPath)).toEqual(['build/app.js']);
    manager.stopAll();
  });

  /**
   * 评审 P2（PR #4398 轮五）：恒真层的名字比较必须与 matcher 的大小写口径一致。
   * `ignore` 包默认 `ignorecase=true`（`NODE_MODULES/` 会被恒真层匹配），而本地按
   * 段比较若区分大小写，大小写变体目录在开关打开时可见、它**自身**的 rename /
   * unlink 却被吞掉，行陈旧到手动刷新。
   */
  it('大小写变体的恒真目录：自身事件放行、内部事件仍然丢', async () => {
    const manager = new WorkdirWatchManager((event) => emitted.push(event));
    await manager.start('/repo', { showIgnoredDirs: true });
    const record = h.created[0];

    // 目录自身（大小写变体）的事件必须推出去，否则树上的这一行会陈旧。
    const own = await fireEvent(record, 'change', 'NODE_MODULES');
    expect(own.map((e) => e.relPath)).toEqual(['NODE_MODULES']);

    // 内部事件仍然被恒真层丢掉（不再增长）。
    const afterInside = await fireEvent(record, 'change', 'NODE_MODULES/react/index.js');
    expect(afterInside).toHaveLength(1);
    expect(afterInside[0].relPath).toBe('NODE_MODULES');
    manager.stopAll();
  });

  it('工作区 matcher 仍然生效(hidden/ 前缀被丢)', async () => {
    const manager = new WorkdirWatchManager((event) => emitted.push(event));
    await manager.start('/repo', { showIgnoredDirs: true });
    expect(await fireEvent(h.created[0], 'change', 'hidden/x.ts')).toHaveLength(0);
    manager.stopAll();
  });

  /**
   * 评审 P2:同一 workdir 会被两个消费方同时订阅 —— desktop 文件树(可开着
   * 「显示被忽略的目录」)与 device-link 控制端(默认隐藏)。watcher 只能有一份
   * matcher,必须取可见性并集;后到的隐藏态请求不能把先到的 reveal 覆盖掉,
   * 否则 desktop 仍列着 build / dist,却再也收不到它们的事件。
   */
  it('多消费者取可见性并集:后到的隐藏态需求不覆盖先到的 reveal', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    await manager.start('/repo', { hideMetaFiles: true }, 'device-link');

    // 并集仍是 reveal:不重建原生 watcher。
    expect(h.created).toHaveLength(1);
    expect(h.created[0].closed).toBe(false);
    expect(h.matcherOpts).toHaveLength(1);
    expect(h.matcherOpts[0]).toMatchObject({ showIgnoredDirs: true });
    manager.stopAll();
  });

  it('部分消费者 stop:按剩余并集收敛,收窄为隐藏且 watcher 仍在', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    await manager.start('/repo', { showIgnoredDirs: false }, 'device-link');
    expect(h.created).toHaveLength(1);

    manager.stop('/repo', 'desktop-tree');
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等异步 reconcile

    expect(h.created).toHaveLength(2);
    expect(h.created[0].closed).toBe(true);
    expect(h.created[1].closed).toBe(false);
    expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(false);
    manager.stopAll();
  });

  /**
   * 评审 P2（PR #4398 轮六）：并集变化触发 watcher 重建时，旧 entry 的 `pending`
   * 不能随 entry 一起丢 —— 已入队（尚未过 50ms 合并窗口）的事件仍要转发给还在线的
   * 消费者，否则文件树陈旧到同目录下一次事件或手动刷新。
   */
  it('重建 watcher 前先转发 pending 事件：并集收窄不丢已入队事件', async () => {
    const manager = new WorkdirWatchManager((event) => emitted.push(event));
    await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    await manager.start('/repo', { showIgnoredDirs: false }, 'device-link');
    expect(h.created).toHaveLength(1);

    // 可见文件的 change 事件进入 50ms 合并窗口（还没到 flush）。
    h.created[0].cb?.('change', 'src/app.ts');
    expect(emitted).toHaveLength(0);

    // desktop 消费者在窗口内停止 → 并集收窄 → 重建 watcher。
    manager.stop('/repo', 'desktop-tree');

    // pending 必须先转发给仍在线的 device-link 客户端，而不是随旧 entry 丢弃。
    expect(emitted.map((e) => e.relPath)).toEqual(['src/app.ts']);

    await new Promise((resolve) => setTimeout(resolve, 0)); // 等异步 reconcile
    expect(h.created).toHaveLength(2);
    expect(h.created.at(-1)?.closed).toBe(false);
    expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(false);
    manager.stopAll();
  });

  it('最后一个消费者 stop 才拆 watcher', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    await manager.start('/repo', { showIgnoredDirs: true }, 'device-link');

    manager.stop('/repo', 'desktop-tree');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.created.every((c) => c.closed)).toBe(false); // 并集没变:watcher 留着

    manager.stop('/repo', 'device-link');
    expect(h.created.every((c) => c.closed)).toBe(true);
    manager.stopAll();
  });

  /**
   * 评审 P1：`ignore` 的目录模式（`node_modules/`）同时匹配目录自身与全部后代，
   * 而事件过滤要的只是后代 —— 开关打开时 node_modules / Library 这一行就在树里，
   * 它自己被建 / 删 / 改名必须推给父目录 refetch，否则树陈旧到手动刷新。
   */
  it('开关打开时恒真忽略目录自身的事件仍推,只丢其后代', async () => {
    const manager = new WorkdirWatchManager((event) => emitted.push(event));
    await manager.start('/repo', { showIgnoredDirs: true });
    const record = h.created[0];

    // 目录自身的生命周期事件：推（类型由 lstat 映射出 add/unlink，这里只看 relPath）。
    await fireEvent(record, 'rename', 'node_modules');
    expect(emitted.map((e) => e.relPath)).toEqual(['node_modules']);

    // 后代仍然静默：npm install / Unity 导入不会打爆通道。
    const before = emitted.length;
    for (const rel of ['node_modules/react/index.js', 'foo/node_modules/a.js', 'foo/Library/x.dll']) {
      await fireEvent(record, 'change', rel);
    }
    expect(emitted.length).toBe(before);
    manager.stopAll();
  });

  /**
   * 评审 P1：错误处理曾调 `stop(workdir)`（默认 consumerId）—— 删错人，且
   * reconcile 看到同一个坏 entry 选项没变而原地返回，直播静默冻结到手动改开关
   * 或 daemon 重启。现在按剩余消费者并集拆掉重建成新的活 watcher。
   */
  it('watcher 出错时保留消费者意图并重建,不静默冻结', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    expect(h.created).toHaveLength(1);

    const onSpy = h.created[0].watcher.on as unknown as ReturnType<typeof vi.fn>;
    const handler = onSpy.mock.calls.find(([evt]) => evt === 'error')?.[1] as (err: Error) => void;
    handler(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.created).toHaveLength(2);
    expect(h.created[0].closed).toBe(true);
    expect(h.created[1].closed).toBe(false);
    manager.stopAll();
  });

  /**
   * 评审 P2：watcher 报错后紧接着的 reconcile 又失败时不能只记日志 —— 消费者
   * 意图还在 desired，但没有 watcher、也没有定时器再收敛，SSH 连接没断的情况下
   * 事件会永久停止。要有带退避与上限的重试（退避避免持续失败时紧密重建循环）。
   */
  it('watcher 出错后收敛失败:退避重试直到恢复', async () => {
    vi.useFakeTimers();
    try {
      const manager = new WorkdirWatchManager(() => {});
      await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
      expect(h.created).toHaveLength(1);

      // 触发 error（拆掉 entry → 立即 reconcile），并让这次 reconcile 失败。
      let failWith = (_err: Error): void => {};
      h.gate = new Promise<void>((_resolve, reject) => {
        failWith = reject;
      });
      const onSpy = h.created[0].watcher.on as unknown as ReturnType<typeof vi.fn>;
      const handler = onSpy.mock.calls.find(([evt]) => evt === 'error')?.[1] as (err: Error) => void;
      handler(new Error('boom'));
      failWith(new Error('reconcile failed'));
      await vi.advanceTimersByTimeAsync(0);

      // 退避（500ms）后重试成功：重新建出活着的 watcher。
      await vi.advanceTimersByTimeAsync(600);
      expect(h.created.length).toBeGreaterThanOrEqual(2);
      expect(h.created.at(-1)?.closed).toBe(false);
      manager.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 评审 P1（PR #4398）：退避到顶（约 15.5s）后不能永久放弃 —— 挂载 / 权限故障
   * 持续超过退避窗口时旧实现删掉重试状态，故障恢复后再没有定时器收敛；SSH 连接
   * 没断的情况下文件事件永久静默，只有重挂面板 / 改开关才能救。
   */
  it('持续失败超过退避窗口后仍会继续重建（不永久停摆）', async () => {
    vi.useFakeTimers();
    try {
      const manager = new WorkdirWatchManager(() => {});
      await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
      expect(h.created).toHaveLength(1);

      // watcher 报错触发重建，并让之后所有 reconcile 都失败（挂载持续不可用）。
      h.failNext = Number.MAX_SAFE_INTEGER;
      const onSpy = h.created[0].watcher.on as unknown as ReturnType<typeof vi.fn>;
      const handler = onSpy.mock.calls.find(([evt]) => evt === 'error')?.[1] as (err: Error) => void;
      handler(new Error('boom'));

      // 跑过退避窗口（500+1000+2000+4000+8000 ≈ 15.5s）并再等几轮。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.created.at(-1)?.closed).toBe(true); // 一直在失败，尚未建回

      // 故障恢复：下一次封顶退避（8s）内的重试必须把 watcher 建回来。
      h.failNext = 0;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(h.created.at(-1)?.closed).toBe(false);
      manager.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 评审 P1：回滚后的恢复也失败时同样要退避重试 —— 只记日志的话，原有消费者会在
   * 「选项变化 → 拆旧 watcher → 重建失败 → 回滚恢复意图」之后既没有 watcher、也没
   * 有定时器再收敛。
   */
  it('回滚后的恢复失败:退避重试直到恢复', async () => {
    vi.useFakeTimers();
    try {
      const manager = new WorkdirWatchManager(() => {});
      await manager.start('/repo', {}, 'desktop-tree'); // 已生效的隐藏态 watcher
      expect(h.created).toHaveLength(1);

      // 改选项（并集变化 → 拆旧重建）失败，且回滚后的恢复也失败。
      h.failNext = 2;
      await expect(
        manager.start('/repo', { showIgnoredDirs: true }, 'device-link'),
      ).rejects.toThrow('matcher load failed');
      await vi.advanceTimersByTimeAsync(0);

      // 只剩 desktop-tree（隐藏）的意图 —— 靠退避重试把它的 watcher 建回来。
      await vi.advanceTimersByTimeAsync(600);
      expect(h.created.at(-1)?.closed).toBe(false);
      expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(false);
      manager.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 评审 P2：**部分停止**按剩余消费者收窄 matcher 时重建失败，也要退避重试 ——
   * 旧 watcher 这时已经拆了，只记日志会让剩下的消费者永久失去实时事件。
   */
  it('部分停止后的重建失败:退避重试直到恢复', async () => {
    vi.useFakeTimers();
    try {
      const manager = new WorkdirWatchManager(() => {});
      await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
      await manager.start('/repo', {}, 'device-link');
      expect(h.created).toHaveLength(1); // 并集 watcher 只建一个

      // 部分停止 → 收窄重建，但这次 loadIgnoreMatcher 失败。
      h.failNext = 1;
      manager.stop('/repo', 'desktop-tree');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.created.at(-1)?.closed).toBe(true); // 旧 watcher 已关

      // 退避重试后按剩余消费者（隐藏）建回 watcher。
      await vi.advanceTimersByTimeAsync(600);
      expect(h.created.at(-1)?.closed).toBe(false);
      expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(false);
      manager.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 评审 P1：启动失败时若把消费者的意图留在 desired 里，控制端只会清本地注册、
   * 不会再发 watchStop → daemon 里多出一个幽灵消费者：它抬高别的消费者的可见性
   * 并集，最后一人 stop 时还会把它当孤儿 watcher 留下。
   */
  it('启动失败回滚本次消费者意图:不抬高别的消费者并集,也不留孤儿 watcher', async () => {
    const manager = new WorkdirWatchManager(() => {});
    let failWith = (_err: Error): void => {};
    h.gate = new Promise<void>((_resolve, reject) => {
      failWith = reject;
    });

    const failing = manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    failWith(new Error('matcher load failed'));
    await expect(failing).rejects.toThrow('matcher load failed');
    expect(h.created).toHaveLength(0);

    // device-link（隐藏）看到的并集不应被那个失败的 reveal 需求抬高。
    await manager.start('/repo', {}, 'device-link');
    expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(false);

    // 最后一个真实消费者 stop：watcher 被拆（没有幽灵撑着）。
    manager.stop('/repo', 'device-link');
    expect(h.created.every((c) => c.closed)).toBe(true);
    manager.stopAll();
  });

  /**
   * 自查发现：回滚改变了并集，而且失败可能就发生在「选项变化 → closeEntry 拆掉旧
   * watcher → startInner 失败」之后 —— 原有消费者此刻没有 watcher。回滚后必须按
   * 恢复后的意图再收敛一次，否则它会静默失去直播。
   */
  it('启动失败回滚后按恢复的意图重建原有消费者的 watcher', async () => {
    const manager = new WorkdirWatchManager(() => {});
    // A（隐藏）先建好 watcher。
    await manager.start('/repo', {}, 'desktop-tree');
    expect(h.created).toHaveLength(1);

    // B（reveal）到来：并集变化 → 拆旧重建；让这次 matcher 加载失败。
    let failWith = (_err: Error): void => {};
    h.gate = new Promise<void>((_resolve, reject) => {
      failWith = reject;
    });
    const failing = manager.start('/repo', { showIgnoredDirs: true }, 'device-link');
    failWith(new Error('matcher load failed'));
    await expect(failing).rejects.toThrow('matcher load failed');
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等回滚后的 reconcile

    // 回滚后只剩 A 的意图：必须有一个活着的 watcher 用隐藏 matcher。
    expect(h.created).toHaveLength(2);
    expect(h.created[0].closed).toBe(true);
    expect(h.created[1].closed).toBe(false);
    expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(false);
    manager.stopAll();
  });

  /**
   * 评审 P1：同一 consumerId 的重叠 start（双窗口启同一 workdir）共享同一次启动、
   * 一起失败时，后到的那个不能把前一个**同样失败的**尝试当「前值」恢复 —— 否则
   * 失败注册复活，回滚后的 fire-and-forget 收敛会真给它建一个没人再 stop 的
   * 孤儿 watcher。
   */
  it('同一 consumerId 的重叠 start 都失败:不复活失败注册,不留活着的孤儿 watcher', async () => {
    const manager = new WorkdirWatchManager(() => {});
    let failWith = (_err: Error): void => {};
    h.gate = new Promise<void>((_resolve, reject) => {
      failWith = reject;
    });

    const first = manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    const second = manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    failWith(new Error('matcher load failed'));
    await expect(first).rejects.toThrow('matcher load failed');
    await expect(second).rejects.toThrow('matcher load failed');
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等 fire-and-forget 收敛

    // 两个 caller 都失败 → 不能留下活着的 watcher（旧实现会复活失败注册并建出它）。
    expect(h.created.every((c) => c.closed)).toBe(true);

    // 下一次同选项 start 要真能建出活 watcher（注册表里没有幽灵）。
    await manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    expect(h.created.at(-1)?.closed).toBe(false);
    manager.stopAll();
  });

  /**
   * 正向锁定：同一消费者已有生效注册、改选项重建失败时，回滚要恢复到**已生效**
   * 的值（committed），而不是把注册从表里删掉 —— 否则那个消费者静默失去直播。
   */
  it('已有生效注册的消费者改选项失败:回滚到已生效值', async () => {
    const manager = new WorkdirWatchManager(() => {});
    await manager.start('/repo', {}, 'desktop-tree');
    expect(h.created).toHaveLength(1);

    let failWith = (_err: Error): void => {};
    h.gate = new Promise<void>((_resolve, reject) => {
      failWith = reject;
    });
    const failing = manager.start('/repo', { showIgnoredDirs: true }, 'desktop-tree');
    failWith(new Error('matcher load failed'));
    await expect(failing).rejects.toThrow('matcher load failed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 回滚到已生效的隐藏态：watcher 活着且 matcher 用隐藏选项。
    expect(h.matcherOpts.at(-1)?.showIgnoredDirs).toBe(false);
    expect(h.created.at(-1)?.closed).toBe(false);
    manager.stopAll();
  });
});
