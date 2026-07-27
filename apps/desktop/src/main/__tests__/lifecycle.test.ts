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

// 因为 registry 是 module-level state, 每个用例需要 reset。简单做法: 用
// vi.resetModules + 动态 import, 拿一份全新的 module 实例。
async function freshLifecycle() {
  vi.resetModules();
  return import('../lifecycle');
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

  it('POSIX (darwin): /bin/sh -c "sleep <grace>; kill -9 <pid>" — detached + ignore + unref', async () => {
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
    // 杀前身份校验(review P1):ps 的 command 仍含本进程 execPath 才补刀,
    // PID 复用给无关进程时校验不过、放弃补刀。
    expect(args).toEqual([
      '-c',
      `sleep ${SHUTDOWN_HARD_KILL_GRACE_SECONDS}; `
      + "ps -p 12345 -o command= 2>/dev/null | grep -qF '/Apps/Cindy Test/Electron' && "
      + 'kill -9 12345 2>/dev/null',
    ]);
    expect(opts).toEqual({ detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`grace=${SHUTDOWN_HARD_KILL_GRACE_SECONDS}s`),
    );
  });

  it('win32: cmd.exe /d /s /c "ping -n <grace+1> … & taskkill /f /pid <pid>" — windowsHide + unref', async () => {
    const { armShutdownHardKillWatchdog, SHUTDOWN_HARD_KILL_GRACE_SECONDS } =
      await freshLifecycle();
    const { spawn, child } = fakeSpawn();

    armShutdownHardKillWatchdog({
      spawn,
      pid: 67890,
      platform: 'win32',
      execPath: 'C\\Cindy\\Cindy.exe'.replace(/\\\\/g, '\\'),
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    // 规范拼写 COMSPEC(Windows env 大小写不敏感, 代码用规范名对齐 shellResolver);
    // 非 Windows 测试机上没有该变量, 走 'cmd.exe' 兜底。
    expect(cmd).toBe(process.env.COMSPEC ?? 'cmd.exe');
    // 杀前身份校验:tasklist 映像名仍匹配本进程 exe 才 taskkill。
    expect(args).toEqual([
      '/d',
      '/s',
      '/c',
      `ping -n ${SHUTDOWN_HARD_KILL_GRACE_SECONDS + 1} 127.0.0.1 >nul & `
      + 'tasklist /FI "PID eq 67890" /NH | findstr /I /C:"Cindy.exe" >nul && '
      + 'taskkill /f /pid 67890',
    ]);
    expect(opts).toEqual({ detached: true, windowsHide: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
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
      expect.stringContaining('failed to arm shutdown hard-kill watchdog'),
      expect.any(Error),
    );
  });
});

describe('installQuitHandler render-process-gone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
