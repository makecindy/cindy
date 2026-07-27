import { describe, expect, it, vi } from 'vitest';

import {
  stopRuntimeForQuit,
  stopRuntimeForQuitIfUsed,
  trackBrowserRuntimeUsage,
} from '../browser-dispose.js';
import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('stopRuntimeForQuit', () => {
  it('sends a stop action on the quit path', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => ({
      ok: true,
      action: 'stop',
      status: 200,
    }));
    const logger = fakeLogger();

    await stopRuntimeForQuit({ call }, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual({ action: 'stop' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns but does not throw when stop returns not-ok', async () => {
    const call = vi.fn(
      async (): Promise<BrowserControlResult> => ({
        ok: false,
        action: 'stop',
        errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: 'boom',
      }),
    );
    const logger = fakeLogger();

    await expect(stopRuntimeForQuit({ call }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown error (shutdown must not stall)', async () => {
    const call = vi.fn(async (): Promise<BrowserControlResult> => {
      throw new Error('dispatch exploded');
    });
    const logger = fakeLogger();

    await expect(stopRuntimeForQuit({ call }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('stopRuntimeForQuitIfUsed', () => {
  it('skips the stop dispatch entirely when the runtime was never used', async () => {
    // The vendored dispatch bridge boots the browser control service before
    // routing ANY action — so "never used" must mean zero calls, not a no-op stop.
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => ({
      ok: true,
      action: 'stop',
      status: 200,
    }));
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('never used this session'),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stops normally when the runtime saw traffic this session', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: true, action: req.action, status: 200 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toEqual({ action: 'stop' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not count a rejected call as usage — service liveness unproven', async () => {
    // Review P1: marking at dispatch time would treat a failed-boot call as
    // "service is up", and the quit-time stop would then re-run the boot.
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => {
      throw new Error('dispatch exploded');
    });
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await expect(tracked.call({ action: 'status' })).rejects.toThrow('dispatch exploded');
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('counts an ok:false WITH http status as usage — the service answered, it is up (review)', async () => {
    // HTTP >=400 走的是 dispatcher 真实应答:服务已启动,只是 action 失败;
    // 跳过 stop 会把已启动的服务/Chrome 留成孤儿(锁住 profile)。
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: false, action: req.action, status: 500 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toEqual({ action: 'stop' });
  });

  it('does not count an ok:false WITHOUT status as usage — thrown boots have no http reply', async () => {
    // catch 路径(启动 throw / disabled)不带 status:服务存活未证实,不计使用。
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: false, action: req.action, errorCode: 'BROWSER_RUNTIME_UNAVAILABLE', message: 'disabled' }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('beginQuiescence blocks NEW non-stop calls with a RESOLVED ok:false result (review ×2)', async () => {
    // 底层 runtime 的契约是 call 永不 reject(总是 resolve BrowserControlResult,
    // 调用方只看 res.ok)——门禁必须 resolve ok:false 而不是 reject,否则会在
    // 只检查 res.ok 的调用方处变成 unhandledRejection。
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: true, action: req.action, status: 200 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });

    tracked.beginQuiescence();

    const res = await tracked.call({ action: 'status' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('BROWSER_RUNTIME_UNAVAILABLE');
    // 无 status → 不计使用
    expect(tracked.everCalled()).toBe(false);
    expect(call).not.toHaveBeenCalled();
    // stop 仍放行(quit 路径自己要发 stop)
    await tracked.call({ action: 'stop' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not count a stop dispatch as usage — teardown is not traffic', async () => {
    // Review P1: ExternalChromeBackend.dispose (backend switching) sends a
    // stop through the same wrapper; counting it would make the quit path
    // dispatch a second stop that re-boots the service.
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: true, action: req.action, status: 200 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'stop' });
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('a successful stop RESETS usage — use → backend-switch stop → quit skips (review P1)', async () => {
    // 使用后切换后端(ExternalChromeBackend.dispose)已成功停掉服务;若使用态
    // 终身保留,退出时会再派一次 stop,vendored bridge 会先把已停的服务重新
    // 拉起——这正是本包装要避免的退出期启动。stopped:true = 真正 tear down。
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: true, action: req.action, status: 200, data: req.action === 'stop' ? { stopped: true } : undefined }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    expect(tracked.everCalled()).toBe(true);
    await tracked.call({ action: 'stop' });
    expect(tracked.everCalled()).toBe(false);
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call).toHaveBeenCalledTimes(2); // status + 后端切换的 stop,quit 未再派
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('a failed stop does NOT reset usage — service may still be up, quit stop stays', async () => {
    let stopCount = 0;
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => {
        if (req.action !== 'stop') return { ok: true, action: req.action, status: 200 };
        stopCount += 1;
        return stopCount === 1
          ? { ok: false, action: req.action, status: 500, errorCode: 'BROWSER_RUNTIME_ACTION_FAILED', message: 'busy' }
          : { ok: true, action: req.action, status: 200 };
      },
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    await tracked.call({ action: 'stop' }); // 失败的 stop:服务可能还活着
    expect(tracked.everCalled()).toBe(true);
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call.mock.calls.map(([req]) => req.action)).toEqual(['status', 'stop', 'stop']);
  });

  it('a pre-stop call settling AFTER a successful stop does not re-mark usage (review ×2)', async () => {
    // BackendRouter.setBackend 处理旧后端 dispose 时不等其在途调用排空:在途
    // 调用可能在 stop 成功重置之后才 settle——它应答的是已被拆掉的服务实例,
    // 若翻回使用态,退出路径会再派 stop 把服务重新拉起。epoch 必须拦住它。
    let resolveSlow!: (r: BrowserControlResult) => void;
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>((req) =>
      req.action === 'stop'
        ? Promise.resolve({ ok: true, action: req.action, status: 200, data: { stopped: true } })
        : new Promise((resolve) => {
            resolveSlow = resolve;
          }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    const slow = tracked.call({ action: 'snapshot' }); // stop 前已在途
    await tracked.call({ action: 'stop' }); // 后端切换的成功 stop
    resolveSlow({ ok: true, action: 'snapshot', status: 200 }); // 晚到的旧应答
    await slow;
    expect(tracked.everCalled()).toBe(false);

    await stopRuntimeForQuitIfUsed(tracked, logger);
    expect(call.mock.calls.map(([req]) => req.action)).toEqual(['snapshot', 'stop']); // quit 未再派
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('quit waits for an in-flight backend-switch stop, then skips its own stop (review)', async () => {
    // stop 若不进 inFlight,settleInFlight 之后它才落定重置使用态,quit 已经
    // 多派了一次 stop——vendored bridge 会为路由这次 stop 把刚停掉的服务再拉起。
    let resolveStop!: (r: BrowserControlResult) => void;
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>((req) =>
      req.action === 'stop'
        ? new Promise((resolve) => {
            resolveStop = resolve;
          })
        : Promise.resolve({ ok: true, action: req.action, status: 200 }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' }); // usage = true
    const switchStop = tracked.call({ action: 'stop' }); // 后端切换的 stop,在途
    const quit = stopRuntimeForQuitIfUsed(tracked, logger);
    resolveStop({ ok: true, action: 'stop', status: 200, data: { stopped: true } });
    await switchStop;
    await quit;

    expect(call.mock.calls.map(([req]) => req.action)).toEqual(['status', 'stop']); // quit 未再派
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });

  it('a call admitted AFTER a pending stop re-marks usage once it answers (review P1)', async () => {
    // 后端切换的 stop 在途期间,一条 start(比 stop 晚派发)赢得竞态并拉起了
    // 新 Chrome:它的应答必须重新计入使用,否则 quit 会跳过清理、泄漏进程与
    // profile 锁(epoch-per-stop 方案会误伤这类新调用,seq 屏障不会)。
    let resolveStop!: (r: BrowserControlResult) => void;
    let resolveStart!: (r: BrowserControlResult) => void;
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>((req) => {
      if (req.action === 'stop' && !resolveStop) {
        return new Promise((resolve) => {
          resolveStop = resolve;
        });
      }
      if (req.action === 'start') {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      return Promise.resolve({ ok: true, action: req.action, status: 200 });
    });
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    const pendingStop = tracked.call({ action: 'stop' }); // 先派发的 stop
    const lateStart = tracked.call({ action: 'start' }); // stop 之后新进的 start
    resolveStop({ ok: true, action: 'stop', status: 200, data: { stopped: true } }); // stop 真正 tear down:只作废更早的调用
    await pendingStop;
    resolveStart({ ok: true, action: 'start', status: 200 }); // start 应答:重新计使用
    await lateStart;
    expect(tracked.everCalled()).toBe(true);

    await stopRuntimeForQuitIfUsed(tracked, logger);
    expect(call.mock.calls.map(([req]) => req.action)).toEqual(['stop', 'start', 'stop']); // quit 照常清理
  });

  it('a NO-OP stop (stopped:false) does not invalidate a racing cold start (review P1)', async () => {
    // 后端切换的 stop 撞上冷启动:vendored /stop 见 running===null 返回
    // stopped:false(HTTP 200)——它没有 tear down 任何东西,更没覆盖到那次
    // 在途 launch。若照样清使用态+抬屏障,晚到的 start 应答会被忽略,quit
    // 跳过清理,新拉起的 Chrome 和 profile 锁被留下。
    let resolveStart!: (r: BrowserControlResult) => void;
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>((req) => {
      if (req.action === 'start') {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      return Promise.resolve(
        req.action === 'stop'
          ? { ok: true, action: req.action, status: 200, data: { stopped: false } }
          : { ok: true, action: req.action, status: 200 },
      );
    });
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    const coldStart = tracked.call({ action: 'start' }); // 冷启动在途(先派发)
    await tracked.call({ action: 'stop' }); // 后端切换的 no-op stop
    resolveStart({ ok: true, action: 'start', status: 200 }); // launch 完成
    await coldStart;
    expect(tracked.everCalled()).toBe(true);

    await stopRuntimeForQuitIfUsed(tracked, logger);
    expect(call.mock.calls.map(([req]) => req.action)).toEqual(['start', 'stop', 'stop']); // quit 照常清理
  });

  it('usage flips back on when non-stop traffic resumes after a successful stop', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      async (req) => ({ ok: true, action: req.action, status: 200, data: req.action === 'stop' ? { stopped: true } : undefined }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    await tracked.call({ action: 'status' });
    await tracked.call({ action: 'stop' });
    await tracked.call({ action: 'start' }); // 服务被重新使用
    await stopRuntimeForQuitIfUsed(tracked, logger);

    expect(call.mock.calls.map(([r]) => r.action)).toEqual(['status', 'stop', 'start', 'stop']);
  });
});

describe('stopRuntimeForQuitIfUsed — quit racing an in-flight first call (review P1)', () => {
  it('waits for a still-booting call; success → stop dispatched', async () => {
    let resolveFirst!: (r: BrowserControlResult) => void;
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>((req) =>
      req.action === 'stop'
        ? Promise.resolve({ ok: true, action: req.action, status: 200 })
        : new Promise((resolve) => {
            resolveFirst = resolve;
          }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    void tracked.call({ action: 'start' });
    const quit = stopRuntimeForQuitIfUsed(tracked, logger);
    // 在途启动尚未落定,quit 必须等待而不是立即判"never used"
    resolveFirst({ ok: true, action: 'start', status: 200 });
    await quit;

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toEqual({ action: 'stop' });
  });

  it('waits for a still-booting call; failure → skip (service liveness unproven)', async () => {
    let rejectFirst!: (err: Error) => void;
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const tracked = trackBrowserRuntimeUsage({ call });
    const logger = fakeLogger();

    void tracked.call({ action: 'start' }).catch(() => undefined);
    const quit = stopRuntimeForQuitIfUsed(tracked, logger);
    rejectFirst(new Error('boot exploded'));
    await quit;

    expect(call).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('never used this session'));
  });
});
