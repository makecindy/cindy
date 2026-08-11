/**
 * lifecycle.test.ts
 * ---------------------------------------------------------------------------
 * 单测覆盖 runQuitDisposers 的三阶段编排语义:
 *   - sync 串行, 抛错不影响后续
 *   - async 并发, 整体超时兜底
 *   - post-async 串行, 必须晚于 async (用于 db close 这种依赖 async 产物的清理)
 *
 * installQuitHandler 只覆盖不触发真实退出的异常分支；真实 process / app 信号路径仍走集成验证。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// lifecycle.ts 里 import { app } from 'electron' —— 用最小 stub 喂给它。
// 真实退出路径 (信号 / before-quit) 不在本文件覆盖。
vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    isReady: () => false,
    quit: vi.fn(),
    exit: vi.fn(),
  },
}));

const nativePopupWebContentsIds = vi.hoisted(() => new Set<number>());

vi.mock('../rsb-browser-bridge/native-popup-surfaces', () => ({
  isRsbNativePopupWebContentsId: (webContentsId: number) =>
    nativePopupWebContentsIds.has(webContentsId),
}));

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  disableDevTerminalMirror: vi.fn(),
  // 默认 spawn stub —— beginShutdown 会布防真实 watchdog, 不 mock 的话
  // render-process-gone 等用例会真的 spawn `sleep 20; kill -9 <vitest pid>`,
  // 慢跑/watch 模式下会把测试进程杀掉。
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('../logger', async () => {
  const actual = await vi.importActual<typeof import('../logger')>('../logger');
  return {
    ...actual,
    createLogger: () => mocks.logger,
    disableDevTerminalMirror: mocks.disableDevTerminalMirror,
  };
});

// 每个用例独立的 watchdog 脚本落盘目录 (mkdtemp 唯一路径, 用完即删)。既满足
// 测试资源规则, 也让 win32 宿主上 installQuitHandler 的启动期预生成不会写入
// 真实 os.tmpdir (freshLifecycle 里用本目录预 seed 缓存)。
let watchdogTmpDir: string;
beforeEach(() => {
  watchdogTmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-wd-'));
});
afterEach(() => {
  rmSync(watchdogTmpDir, { recursive: true, force: true });
});

// 因为 registry 是 module-level state, 每个用例需要 reset。简单做法: 用
// vi.resetModules + 动态 import, 拿一份全新的 module 实例。
async function freshLifecycle() {
  vi.resetModules();
  const lifecycle = await import('../lifecycle');
  // win32 宿主上把 watchdog 脚本缓存 seed 到本用例的 mkdtemp 目录; 非 win32
  // 宿主上是 no-op (需要 win32 路径的用例自己显式传 platform + tmpDir)。
  lifecycle.prepareShutdownWatchdogScript({ tmpDir: watchdogTmpDir });
  return lifecycle;
}

type ProcessEventName =
  | 'SIGINT'
  | 'SIGTERM'
  | 'exit'
  | 'uncaughtException'
  | 'unhandledRejection';

function snapshotProcessListeners(events: ProcessEventName[]) {
  const before = new Map(events.map((event) => [event, new Set(process.listeners(event))]));

  return {
    added(event: ProcessEventName) {
      const previous = before.get(event) ?? new Set();
      return process.listeners(event).filter((listener) => !previous.has(listener));
    },
    restore() {
      for (const event of events) {
        const previous = before.get(event) ?? new Set();
        for (const listener of process.listeners(event)) {
          if (!previous.has(listener)) {
            process.removeListener(event, listener);
          }
        }
      }
    },
  };
}

describe('runQuitDisposers', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs sync → async → post-async in order', async () => {
    const { onQuit, runQuitDisposers } = await freshLifecycle();
    const log: string[] = [];

    onQuit('a-sync', () => { log.push('a-sync'); }, 'sync');
    onQuit('b-async', async () => {
      await new Promise((r) => setTimeout(r, 10));
      log.push('b-async');
    }, 'async');
    onQuit('c-post', async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.push('c-post');
    }, 'post-async');

    await runQuitDisposers(1000);

    expect(log).toEqual(['a-sync', 'b-async', 'c-post']);
  });

  it('sync disposer that throws does not block subsequent disposers', async () => {
    const { onQuit, runQuitDisposers } = await freshLifecycle();
    const log: string[] = [];

    onQuit('throws', () => { throw new Error('boom'); }, 'sync');
    onQuit('after', () => { log.push('after'); }, 'sync');

    await runQuitDisposers(1000);

    expect(log).toEqual(['after']);
  });

  it('async disposers run concurrently', async () => {
    const { onQuit, runQuitDisposers } = await freshLifecycle();
    const start = Date.now();

    onQuit('one', () => new Promise<void>((r) => setTimeout(r, 50)), 'async');
    onQuit('two', () => new Promise<void>((r) => setTimeout(r, 50)), 'async');

    await runQuitDisposers(1000);

    // 并发跑应当 ~50ms, 串行会是 ~100ms。给点余量, < 90ms 即视为并发。
    expect(Date.now() - start).toBeLessThan(90);
  });

  it('async phase honors timeout — post-async still runs after timeout', async () => {
    const { onQuit, runQuitDisposers } = await freshLifecycle();
    let postRan = false;

    // 永不 resolve 的 async disposer
    onQuit('hang', () => new Promise(() => { /* never */ }), 'async');
    onQuit('post', () => { postRan = true; }, 'post-async');

    const start = Date.now();
    await runQuitDisposers(50);
    const elapsed = Date.now() - start;

    expect(postRan).toBe(true);
    // 超时 50ms, 实际不应远超 (无其它阻塞)
    expect(elapsed).toBeLessThan(200);
  });

  it('post-async disposer that never resolves is bounded by timeout — later post-async still runs', async () => {
    const { onQuit, runQuitDisposers } = await freshLifecycle();
    let laterRan = false;

    // 永不 resolve 的 post-async disposer (生产事故形态: 无界 await 卡死退出)
    onQuit('hang-post', () => new Promise(() => { /* never */ }), 'post-async');
    onQuit('later-post', () => { laterRan = true; }, 'post-async');

    const start = Date.now();
    await runQuitDisposers(50);
    const elapsed = Date.now() - start;

    expect(laterRan).toBe(true);
    // 单个 post-async 预算 50ms, 实际不应远超 (无其它阻塞)
    expect(elapsed).toBeLessThan(500);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('post-async disposer "hang-post" timed out after 50ms'),
    );
  });

  it('rejected async disposer does not break the chain', async () => {
    const { onQuit, runQuitDisposers } = await freshLifecycle();
    let postRan = false;

    onQuit('rejects', async () => { throw new Error('async-boom'); }, 'async');
    onQuit('ok', async () => { /* fine */ }, 'async');
    onQuit('post', () => { postRan = true; }, 'post-async');

    await runQuitDisposers(500);

    expect(postRan).toBe(true);
  });
});

describe('armShutdownHardKillWatchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fakeSpawn() {
    const child = { once: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    return { spawn, child };
  }

  it('POSIX (darwin): /bin/sh 捕获 lstart → sleep → lstart+command 双校验后 kill -9 — detached + ignore + unref', async () => {
    const { armShutdownHardKillWatchdog, SHUTDOWN_HARD_KILL_GRACE_SECONDS } =
      await freshLifecycle();
    const { spawn, child } = fakeSpawn();

    armShutdownHardKillWatchdog({
      spawn,
      pid: 12345,
      platform: 'darwin',
      execPath: '/Apps/Cindy Test/Electron',
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe('/bin/sh');
    // 杀前身份校验(review P1 两轮):命令行匹配区分不了同一 App 的两次运行
    // (更新器重启的新实例复用 PID 会被误杀), 所以布防时先捕获进程创建时间
    // (lstart), 补刀前重取比对;不一致 = PID 已易主, 放弃。execPath grep 保留
    // 作第二道校验。
    expect(args).toEqual([
      '-c',
      'started="$(ps -p 12345 -o lstart= 2>/dev/null)"; '
      + '[ -n "$started" ] || exit 0; '
      + `sleep ${SHUTDOWN_HARD_KILL_GRACE_SECONDS}; `
      + '[ "$(ps -p 12345 -o lstart= 2>/dev/null)" = "$started" ] && '
      + "ps -p 12345 -o command= 2>/dev/null | grep -qF '/Apps/Cindy Test/Electron' && "
      + 'kill -9 12345 2>/dev/null',
    ]);
    expect(opts).toEqual({ detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`grace=${SHUTDOWN_HARD_KILL_GRACE_SECONDS}s`),
    );
  });

  it('win32: wscript 单进程 watchdog — CreationDate+ExecutablePath 双校验, 无 PowerShell、无子进程', async () => {
    const { armShutdownHardKillWatchdog, prepareShutdownWatchdogScript, SHUTDOWN_HARD_KILL_GRACE_SECONDS } =
      await freshLifecycle();
    const { spawn, child } = fakeSpawn();
    const scriptPath = prepareShutdownWatchdogScript({ platform: 'win32', tmpDir: watchdogTmpDir })!;

    armShutdownHardKillWatchdog({
      spawn,
      pid: 67890,
      platform: 'win32',
      execPath: 'C:\\Cindy\\Cindy.exe',
      tmpDir: watchdogTmpDir,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    // wscript 是 GUI 子系统程序: 天生无控制台、无窗口, detached 逃出 libuv 的
    // kill-on-close job 才能活过父进程。SystemRoot 绝对路径, 不依赖 PATH。
    expect(cmd).toBe(
      `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wscript.exe`,
    );
    // 路径在 mkdtemp 唯一目录下, 不可被同 tmpdir 下其他进程预测或篡改。
    expect(scriptPath).toMatch(/cindy-wd-/);
    expect(scriptPath).toMatch(/watchdog\.js$/);
    expect(args).toEqual([
      '//B',
      '//E:JScript',
      scriptPath,
      '67890',
      String(SHUTDOWN_HARD_KILL_GRACE_SECONDS * 1000),
      'C:\\Cindy\\Cindy.exe',
    ]);
    expect(opts).toEqual({ detached: true, windowsHide: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);

    // 脚本已预生成落盘, 且保留原 PowerShell 实现同强度的身份校验 (review P1
    // 两轮的 PID 复用防线): 布防时捕获 CreationDate, 杀前重取比对 + execPath。
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('CreationDate');
    expect(content).toContain('ExecutablePath');
    expect(content).toContain('WScript.Sleep(graceMs)');
    expect(content).toContain('.Terminate()');
    // 回归锁 (2026-08 实证): 隐藏拉起 PowerShell 会被 360 等安全软件当高危动作
    // 拦截, 每次正常退出都弹风控 —— 这条路径永远不许再出现 powershell。
    expect(content.toLowerCase()).not.toContain('powershell');
    // WSH 按系统 ANSI 代码页读文件 + JScript 只有 ES3: 必须纯 ASCII, 且不能有
    // const/let/箭头函数 (踩坑实证: 尾逗号/新语法在 //B 下静默失败, 兜底形同虚设)。
    expect(content).toMatch(/^[\x00-\x7f]*$/);
    expect(content).not.toMatch(/\b(const|let)\b|=>/);
  });

  it('prepareShutdownWatchdogScript: 非 win32 no-op; win32 幂等复用同一路径 (mkdtemp 唯一目录)', async () => {
    const { prepareShutdownWatchdogScript } = await freshLifecycle();

    expect(
      prepareShutdownWatchdogScript({ platform: 'darwin', tmpDir: watchdogTmpDir }),
    ).toBeNull();

    const first = prepareShutdownWatchdogScript({ platform: 'win32', tmpDir: watchdogTmpDir });
    expect(first).not.toBeNull();
    expect(first!).toMatch(/cindy-wd-/);
    expect(first!).toMatch(/watchdog\.js$/);
    expect(existsSync(first!)).toBe(true);
    // 幂等: 第二次 (即使传别的目录) 复用已生成的路径, 不重复写盘
    expect(
      prepareShutdownWatchdogScript({ platform: 'win32', tmpDir: join(watchdogTmpDir, 'other') }),
    ).toBe(first);
  });

  it('win32: 缓存路径被外部删除后重新生成到新目录', async () => {
    const { prepareShutdownWatchdogScript } = await freshLifecycle();
    const first = prepareShutdownWatchdogScript({ platform: 'win32', tmpDir: watchdogTmpDir })!;
    expect(existsSync(first)).toBe(true);
    rmSync(first);
    const second = prepareShutdownWatchdogScript({ platform: 'win32', tmpDir: watchdogTmpDir })!;
    expect(second).not.toBe(first);
    expect(existsSync(second)).toBe(true);
    expect(second).toMatch(/watchdog\.js$/);
  });

  it('win32: watchdog 脚本写盘失败 → 共享 spawn 失败预算, 耗尽打缺席标记, 不 throw', async () => {
    // 不走 freshLifecycle: 那里会预 seed 脚本缓存, 而本用例要的就是"prepare
    // 一直失败"(目标目录不存在) 的路径。
    vi.resetModules();
    const { armShutdownHardKillWatchdog } = await import('../lifecycle');
    const child = { once: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);

    expect(() =>
      armShutdownHardKillWatchdog({
        spawn,
        pid: 1,
        platform: 'win32',
        execPath: 'C:\\Cindy\\Cindy.exe',
        tmpDir: join(watchdogTmpDir, 'missing', 'deep'),
      }),
    ).not.toThrow();

    // 写盘失败发生在 spawn 之前: spawn 从未被调用, 预算耗尽后打缺席标记
    expect(spawn).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('external kill backstop ABSENT'),
      expect.any(Error),
    );
  });

  it('is idempotent — a second arm does not spawn again', async () => {
    const { armShutdownHardKillWatchdog } = await freshLifecycle();
    const { spawn } = fakeSpawn();

    armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' });
    armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' });

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('async spawn "error" event is warn-logged, not an uncaughtException (review P1)', async () => {
    // spawn 可能在返回后经 'error' 事件异步报失败 (ENOENT/EACCES); 必须挂
    // listener 留痕, 否则 watchdog 静默未布防且错误落入 uncaughtException。
    const { armShutdownHardKillWatchdog } = await freshLifecycle();
    const { spawn, child } = fakeSpawn();

    armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' });

    expect(child.once).toHaveBeenCalledWith('error', expect.any(Function));
    const errorListener = child.once.mock.calls[0][1] as (err: Error) => void;
    expect(() => errorListener(new Error('ENOENT'))).not.toThrow();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('watchdog process failed to start'),
      expect.any(Error),
    );
  });

  it('tolerates fake spawn children without once() (listener attach is optional)', async () => {
    const { armShutdownHardKillWatchdog } = await freshLifecycle();
    const child = { unref: vi.fn() };
    const spawn = vi.fn(() => child);

    expect(() =>
      armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' }),
    ).not.toThrow();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('spawn throwing does not propagate (watchdog failure must not block shutdown)', async () => {
    const { armShutdownHardKillWatchdog } = await freshLifecycle();
    const spawn = vi.fn(() => {
      throw new Error('spawn-boom');
    });

    expect(() =>
      armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' }),
    ).not.toThrow();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('watchdog process failed to start'),
      expect.any(Error),
    );
  });

  it('async spawn "error" retries within the 3-attempt budget, then marks the backstop ABSENT (review ×2)', async () => {
    // 异步启动失败(ENOENT/EACCES)时 watchdog 实际不在位:预算内立即重试
    // (吸收 EAGAIN 类瞬时抖动);全部失败 = 环境级问题,进程内不可能布防任何
    // 外部补刀——打明确的缺席标记(error 级)供退出尸检定位,不再无限重试。
    const { armShutdownHardKillWatchdog } = await freshLifecycle();
    const children: Array<{ once: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }> = [];
    const spawn = vi.fn(() => {
      const child = { once: vi.fn(), unref: vi.fn() };
      children.push(child);
      return child;
    });

    armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' });
    expect(spawn).toHaveBeenCalledTimes(1);
    // 第 1、2 个 child 异步报错 → 各自立即重试
    (children[0].once.mock.calls[0][1] as (err: Error) => void)(new Error('EACCES'));
    expect(spawn).toHaveBeenCalledTimes(2);
    (children[1].once.mock.calls[0][1] as (err: Error) => void)(new Error('EACCES'));
    expect(spawn).toHaveBeenCalledTimes(3);
    // 第 3 个也报错:预算耗尽 → 缺席标记,不再重试
    (children[2].once.mock.calls[0][1] as (err: Error) => void)(new Error('EACCES'));
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('external kill backstop ABSENT'),
      expect.any(Error),
    );
    // 预算耗尽后再布防:no-op(环境已证实无法 spawn)
    armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' });
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('sync spawn failure consumes the shared budget and marks ABSENT on exhaustion (review)', async () => {
    // 同步 throw 与异步 error 共享 3 次预算:同一环境级失败在一次布防里就地
    // 重试到耗尽并打缺席标记;之后其它入口的布防调用 no-op,不再空转。
    const { armShutdownHardKillWatchdog } = await freshLifecycle();
    const failingSpawn = vi.fn(() => {
      throw new Error('spawn-boom');
    });
    armShutdownHardKillWatchdog({ spawn: failingSpawn, pid: 1, platform: 'darwin' });
    expect(failingSpawn).toHaveBeenCalledTimes(3);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('external kill backstop ABSENT'),
      expect.any(Error),
    );

    const { spawn } = fakeSpawn();
    armShutdownHardKillWatchdog({ spawn, pid: 1, platform: 'darwin' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('installQuitHandler render-process-gone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativePopupWebContentsIds.clear();
  });

  type RenderGoneHandler = (
    event: unknown,
    webContents: { id: number; getType(): string },
    details: { reason: string; exitCode: number },
  ) => void;

  /** 装好 handler 后把 app.on 捕到的 render-process-gone 回调挖出来。 */
  async function installAndGrabHandler() {
    const snapshot = snapshotProcessListeners([
      'SIGINT',
      'SIGTERM',
      'exit',
      'uncaughtException',
      'unhandledRejection',
    ]);
    const { installQuitHandler } = await freshLifecycle();
    installQuitHandler(50);
    const { app } = await import('electron');
    const onMock = vi.mocked(app.on);
    // app.on 的类型是重载联合,TS 会把 event 收窄到第一个重载的字面量;按数据看待。
    const call = (onMock.mock.calls as unknown as Array<[string, unknown]>).find(
      ([event]) => event === 'render-process-gone',
    );
    expect(call).toBeDefined();
    return {
      handler: call![1] as unknown as RenderGoneHandler,
      app,
      restore: () => snapshot.restore(),
    };
  }

  it('webview guest crash (e.g. OOM) does NOT shut the app down', async () => {
    const { handler, app, restore } = await installAndGrabHandler();
    try {
      handler(
        undefined,
        { id: 42, getType: () => 'webview' },
        { reason: 'oom', exitCode: 1 },
      );
      // beginShutdown 是异步链;等一拍再断言"什么都没发生"。
      await new Promise((r) => setTimeout(r, 20));
      expect(app.exit).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('webview guest render-process-gone'),
      );
      expect(mocks.logger.error).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('main-owned popup crash does NOT shut the app down', async () => {
    nativePopupWebContentsIds.add(43);
    const { handler, app, restore } = await installAndGrabHandler();
    try {
      handler(undefined, { id: 43, getType: () => 'window' }, { reason: 'crashed', exitCode: 5 });
      await new Promise((r) => setTimeout(r, 20));
      expect(app.exit).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('native popup render-process-gone'),
      );
      expect(mocks.logger.error).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('main window renderer crash still shuts the app down with exit(1)', async () => {
    const { handler, app, restore } = await installAndGrabHandler();
    try {
      handler(
        undefined,
        { id: 1, getType: () => 'window' },
        { reason: 'crashed', exitCode: 5 },
      );
      await vi.waitFor(() => {
        expect(app.exit).toHaveBeenCalledWith(1);
      });
      // beginShutdown 应布防外部硬杀 watchdog (走默认 spawn, 被顶部 mock 接住)
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});

describe('installQuitHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables terminal mirroring before logging broken stdio errors once', async () => {
    const snapshot = snapshotProcessListeners([
      'SIGINT',
      'SIGTERM',
      'exit',
      'uncaughtException',
      'unhandledRejection',
    ]);

    try {
      const { installQuitHandler } = await freshLifecycle();
      installQuitHandler();

      const [handleUncaughtException] = snapshot.added('uncaughtException');
      expect(handleUncaughtException).toBeTypeOf('function');

      const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      handleUncaughtException(err, 'uncaughtException');
      handleUncaughtException(err, 'uncaughtException');

      expect(mocks.disableDevTerminalMirror).toHaveBeenCalledTimes(2);
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'disabled dev terminal log mirror after broken stdio',
        err,
      );
    } finally {
      snapshot.restore();
    }
  });
});
