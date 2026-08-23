import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 守住 helper 子进程不泄漏。
 *
 * startChildProcess 在 spawn 之前要先 await 解析 helper 路径，dev 下那一步会现编译
 * （swiftc，可能几秒）。那段时间 `child` 还是 null，所以 stop 光看 `child` 拦不住一个
 * 正在飞的启动，重叠的启动之间也会互相覆盖 `child` 引用。漏掉的进程不是空转——它持有
 * 全局 event tap，会一直监听键盘。
 */

const mocks = vi.hoisted(() => {
  // 把 swiftc 的 execFile 回调扣在手里，由用例决定「解析 helper」何时完成（或失败），
  // 从而精确复现 spawn 之前那段窗口。
  const pendingCompilations: Array<(error?: Error) => void> = [];
  const execFile = vi.fn((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    pendingCompilations.push((error?: Error) => callback(error ?? null, '', ''));
  });
  const kill = vi.fn();
  // 记下每个 child 的事件回调，用例才能自己触发 exit —— spawn 之后到报 ready 之前那段
  // 窗口只有靠它才能复现。
  const spawnedChildren: Array<Map<string, (...args: unknown[]) => void>> = [];
  // 每个 child 的 stdout data 回调也要抓住:helper 报 ready 是从 stdout 写一行 JSON 过来的,
  // 用例要能模拟「被 kill 的同时那行 ready 才被读到」。
  const stdoutDataHandlers: Array<(chunk: string) => void> = [];
  const spawn = vi.fn(() => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    spawnedChildren.push(handlers);
    return {
      kill,
      killed: false,
      stdout: {
        setEncoding: vi.fn(),
        on: vi.fn((event: string, callback: (chunk: string) => void) => {
          if (event === 'data') stdoutDataHandlers.push(callback);
        }),
      },
      stderr: { setEncoding: vi.fn(), on: vi.fn() },
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        handlers.set(event, callback);
      }),
    };
  });
  return { pendingCompilations, execFile, spawn, kill, spawnedChildren, stdoutDataHandlers };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/cindy-listener-race-test'),
    getAppPath: vi.fn(() => '/tmp/cindy-listener-race-test/app'),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));

vi.mock('node:fs', () => ({
  default: {
    // source 存在、binary 不存在 → 必定走 swiftc 编译分支，也就是我们要的 await 窗口。
    existsSync: vi.fn((target: string) => !String(target).endsWith('xdt-macos-modifier-shortcut-listener')),
    statSync: vi.fn(() => ({ mtimeMs: 0 })),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  },
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MacModifierShortcutListener start race', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.pendingCompilations.length = 0;
    mocks.execFile.mockClear();
    mocks.spawn.mockClear();
    mocks.kill.mockClear();
    mocks.spawnedChildren.length = 0;
    mocks.stdoutDataHandlers.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not spawn a helper when the start is stopped while the dev helper is still compiling', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const starting = listener.startKeyCapture();
    await flush();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.pendingCompilations).toHaveLength(1);

    // 录制在 helper 还没编译完时结束。
    listener.stop();

    mocks.pendingCompilations[0]();
    const result = await starting;

    // 关键：迟到的启动必须放弃 spawn，否则这个 helper 谁都收不掉。
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  it('only spawns for the latest start when two starts overlap', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const first = listener.startKeyCapture();
    await flush();
    const second = listener.startKeyCapture();
    await flush();
    expect(mocks.pendingCompilations).toHaveLength(2);

    // 先让第一轮回来：它已被第二轮顶掉，不该 spawn。
    mocks.pendingCompilations[0]();
    await expect(first).resolves.toMatchObject({ ok: false });
    expect(mocks.spawn).not.toHaveBeenCalled();

    // 第二轮才是有效的那次。
    mocks.pendingCompilations[1]();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    void second;
  });

  /**
   * 代次原先只在 spawn 之前查一次，spawn 之后的落点（exit / error / 启动超时）一律报成
   * 普通失败。于是「录制结束 → stop kill 掉还没报 ready 的 helper」会给出一条 ok:false，
   * 调用方当成真故障，就会去清理更晚一轮刚建立的转发登记（按 sender id 记账，同一个设置页
   * 连续两轮共用一个 id）——新 helper 在跑，用户按 Fn 却没反应。
   */
  it('reports a superseded start when the spawned helper is killed by stop before it reports ready', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const starting = listener.startKeyCapture();
    await flush();
    mocks.pendingCompilations[0]();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawnedChildren).toHaveLength(1);

    // 录制在 helper 报 ready 之前结束。
    listener.stop();
    expect(mocks.kill).toHaveBeenCalled();

    // 被 kill 的进程随后 exit —— 这才是这次启动真正的落点。
    mocks.spawnedChildren[0].get('exit')?.(null, 'SIGTERM');

    await expect(starting).resolves.toMatchObject({ ok: false, superseded: true });
  });

  /**
   * child 被 kill 的同时它可能刚把 ready 写进 stdout，缓冲区里那行随后才被读到。
   *
   * 报成 { ok: true } 的话，recording:start 会留着转发登记、并告诉界面「capture 一切正常」，
   * 而 helper 其实已经没了 —— 用户按 Fn 毫无反应，只能关掉录制框重开。
   */
  it('reports a superseded start when a killed helper reports ready late', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const starting = listener.startKeyCapture();
    await flush();
    mocks.pendingCompilations[0]();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    // 录制结束 → stop 作废这次启动并 kill child。
    listener.stop();

    // 缓冲里那行 ready 这才被读到。
    mocks.stdoutDataHandlers[0]?.('{"type":"ready"}\n');

    await expect(starting).resolves.toMatchObject({ ok: false, superseded: true });
    expect(listener.isReady()).toBe(false);
  });

  /**
   * releaseShortcutKeepingCapture 会**故意**保留一个还没报 ready 的 capture child（有窗口正在
   * 录制时不能把它们的 keys 来源杀掉）。于是复用方只要看见 child 就报成功的话会说谎：
   *
   * A 的 capture 还在启动 → B 挂起（child 被保留）→ B 提交快捷键，setShortcut 报成功 → 快捷键
   * 存盘、界面显示已注册 → A 那次启动随后超时/exit，settle 的失败路径把 child 置空（这条路
   * 不会 scheduleRestart）→ 快捷键写着「已注册」,实际没人监听,要等下次窗口聚焦才被救回来。
   */
  it('does not accept a spawned-but-not-ready capture child as a working listener', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    // A 窗口的 capture:进程起来了,但还没报 ready。
    const capture = listener.startKeyCapture();
    await flush();
    mocks.pendingCompilations[0]();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(listener.isRunning()).toBe(true);
    expect(listener.isReady()).toBe(false);

    // B 窗口挂起:child 被刻意保留。
    listener.releaseShortcutKeepingCapture();

    // B 提交快捷键 —— 此刻绝不能报成功。
    const setting = listener.setShortcut({
      trigger: 'modifier',
      code: 'AltRight',
      key: 'Alt',
      modifiers: { meta: false, ctrl: false, alt: true, shift: false, fn: false },
    } as never);

    // A 那次启动最终失败(进程 exit)。
    mocks.spawnedChildren[0].get('exit')?.(3, null);

    await expect(setting).resolves.toMatchObject({ ok: false });
    await expect(capture).resolves.toMatchObject({ ok: false });
  });

  // 别把上面那条修成「有 child 就一律失败」:那次启动报了 ready 之后,复用方必须拿到成功。
  it('accepts the preserved capture child once the in-flight start reports ready', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const capture = listener.startKeyCapture();
    await flush();
    mocks.pendingCompilations[0]();
    await flush();
    listener.releaseShortcutKeepingCapture();

    const setting = listener.setShortcut({
      trigger: 'modifier',
      code: 'AltRight',
      key: 'Alt',
      modifiers: { meta: false, ctrl: false, alt: true, shift: false, fn: false },
    } as never);

    mocks.stdoutDataHandlers[0]?.('{"type":"ready"}\n');

    await expect(setting).resolves.toMatchObject({ ok: true });
    await expect(capture).resolves.toMatchObject({ ok: true });
    // 复用没有再 spawn 一个 helper。
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  // 同一个漏洞的另一半：解析 helper 抛异常（dev 下 swiftc 失败）时压根没查代次，
  // 已被作废的启动会把编译错误当成这次操作的故障报出去。
  it('reports a superseded start when the dev helper compilation fails after the start was stopped', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const starting = listener.startKeyCapture();
    await flush();
    listener.stop();

    mocks.pendingCompilations[0](new Error('swiftc failed'));

    await expect(starting).resolves.toMatchObject({ ok: false, superseded: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('maps bare function-key snapshots to start/tap and releases an active press on helper exit', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const onTrigger = vi.fn();
    const listener = new MacModifierShortcutListener({ onTrigger });
    const shortcut = {
      trigger: 'keyboard',
      code: 'F24',
      key: 'F24',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    } as const;

    const starting = listener.setShortcut(shortcut);
    await flush();
    mocks.pendingCompilations[0]();
    await flush();
    mocks.stdoutDataHandlers[0]?.('{"type":"ready"}\n');
    await expect(starting).resolves.toMatchObject({ ok: true });

    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["Function:F24"]}\n');
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":[]}\n');
    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'tap']);

    onTrigger.mockClear();
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["Function:F24"]}\n');
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["Function:F24","ShiftLeft"]}\n');
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["Function:F24"]}\n');
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":[]}\n');
    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);

    onTrigger.mockClear();
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["ShiftLeft"]}\n');
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["ShiftLeft","Function:F24"]}\n');
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["Function:F24"]}\n');
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":[]}\n');
    expect(onTrigger).not.toHaveBeenCalled();

    onTrigger.mockClear();
    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["Function:F24"]}\n');
    mocks.spawnedChildren[0].get('exit')?.(1, null);
    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
    listener.stop();
  });

  it('ends a held function key once and replaces the helper on a system release', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const onTrigger = vi.fn();
    const listener = new MacModifierShortcutListener({ onTrigger });
    const shortcut = {
      trigger: 'keyboard',
      code: 'F24',
      key: 'F24',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    } as const;

    const starting = listener.setShortcut(shortcut);
    await flush();
    mocks.pendingCompilations[0]();
    await flush();
    mocks.stdoutDataHandlers[0]?.('{"type":"ready"}\n');
    await expect(starting).resolves.toMatchObject({ ok: true });

    mocks.stdoutDataHandlers[0]?.('{"type":"keys","keys":["Function:F24"]}\n');
    listener.releaseActiveTrigger();

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
    expect(mocks.kill).toHaveBeenCalledTimes(1);
    await flush();
    expect(mocks.pendingCompilations).toHaveLength(2);
    mocks.pendingCompilations[1]();
    await flush();
    expect(mocks.spawnedChildren).toHaveLength(2);
    mocks.stdoutDataHandlers[1]?.('{"type":"ready"}\n');
    await flush();
    expect(listener.isReady()).toBe(true);

    // The old process may report exit after its replacement is already live.
    // It must neither end the activation twice nor schedule another restart.
    mocks.spawnedChildren[0].get('exit')?.(null, 'SIGTERM');
    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
    expect(mocks.pendingCompilations).toHaveLength(2);
    listener.stop();
  });
});
