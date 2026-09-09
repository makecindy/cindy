/**
 * awaitWithStartupTimeout 单测 —— 冷启动 auth 黑洞网络护栏的时序编排。
 *
 * 关注点:
 * 1. flow 在时限内 settle:结果 / 异常原样透传,与直接 await 无差异,迟到回调不触发;
 * 2. 超时:返回 onTimeout 兜底值,flow 继续后台运行,迟到 resolve / reject 走对应回调;
 * 3. 迟到 reject 即使不注册 onLateError 也被消化,不产生 unhandled rejection;
 * 4. timeoutMs <= 0 退化为直接 await。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthApiError } from '@cindy/auth-client';

import {
  LOGIN_PREPARING_GATE_TIMEOUT_MS,
  awaitLoginProvidersWithPreparingGate,
  awaitWithStartupTimeout,
  mapLoginProvidersLoadFailure,
} from '../authStartupGate';

describe('awaitWithStartupTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flow 在时限内 resolve:透传结果,不触发超时与迟到回调', async () => {
    const onTimeout = vi.fn(() => 'fallback');
    const onLateResult = vi.fn();
    const p = awaitWithStartupTimeout(Promise.resolve('ok'), {
      timeoutMs: 1000,
      onTimeout,
      onLateResult,
    });
    await expect(p).resolves.toBe('ok');
    // 结果返回后即便时间流逝,超时与迟到回调也不再触发
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onLateResult).not.toHaveBeenCalled();
  });

  it('flow 在时限内 reject:异常原样透传给调用方,不走 onLateError', async () => {
    const onLateError = vi.fn();
    const boom = new Error('boom');
    const p = awaitWithStartupTimeout(Promise.reject(boom), {
      timeoutMs: 1000,
      onTimeout: () => 'fallback',
      onLateError,
    });
    await expect(p).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onLateError).not.toHaveBeenCalled();
  });

  it('超时:返回 onTimeout 兜底值;flow 迟到 resolve 时回调 onLateResult', async () => {
    let resolveFlow!: (v: string) => void;
    const flow = new Promise<string>((r) => {
      resolveFlow = r;
    });
    const onLateResult = vi.fn();
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: () => 'fallback',
      onLateResult,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('fallback');
    expect(onLateResult).not.toHaveBeenCalled();

    // 模拟黑洞网络恢复后请求迟到完成
    resolveFlow('late-login');
    await vi.advanceTimersByTimeAsync(0);
    expect(onLateResult).toHaveBeenCalledWith('late-login');
  });

  it('supports an async timeout recovery before returning the fallback', async () => {
    const flow = new Promise<string>(() => undefined);
    const recovery = vi.fn(async () => {
      await Promise.resolve();
    });
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: async () => {
        await recovery();
        return 'recovered-fallback';
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('recovered-fallback');
    expect(recovery).toHaveBeenCalledOnce();
  });

  it('超时:flow 迟到 reject 时回调 onLateError,rejection 被消化', async () => {
    let rejectFlow!: (err: unknown) => void;
    const flow = new Promise<string>((_r, rej) => {
      rejectFlow = rej;
    });
    const onLateError = vi.fn();
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: () => 'fallback',
      onLateError,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('fallback');

    const boom = new Error('late boom');
    rejectFlow(boom);
    await vi.advanceTimersByTimeAsync(0);
    expect(onLateError).toHaveBeenCalledWith(boom);
  });

  it('超时且未注册 onLateError:迟到 rejection 静默消化,不产生 unhandled rejection', async () => {
    let rejectFlow!: (err: unknown) => void;
    const flow = new Promise<string>((_r, rej) => {
      rejectFlow = rej;
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const p = awaitWithStartupTimeout(flow, {
        timeoutMs: 1000,
        onTimeout: () => 'fallback',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBe('fallback');

      rejectFlow(new Error('late boom'));
      // unhandledRejection 在真实微任务/事件循环层面派发,切回真实计时器等一拍
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('超时且 onTimeout 抛错:waiter 收到该错误;flow 迟到 resolve 仍走 onLateResult', async () => {
    let resolveFlow!: (v: string) => void;
    const flow = new Promise<string>((r) => {
      resolveFlow = r;
    });
    const boom = new Error('timeout-fallback-failed');
    const onLateResult = vi.fn();
    const p = awaitWithStartupTimeout(flow, {
      timeoutMs: 1000,
      onTimeout: () => {
        throw boom;
      },
      onLateResult,
    });
    // 先挂上 rejection 断言再推进计时器,避免超时 reject 在 expect 之前变成 unhandled。
    const rejected = expect(p).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;

    resolveFlow('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onLateResult).toHaveBeenCalledWith('late');
  });

  it('timeoutMs <= 0:退化为直接 await,永不超时', async () => {
    const onTimeout = vi.fn(() => 'fallback');
    let resolveFlow!: (v: string) => void;
    const flow = new Promise<string>((r) => {
      resolveFlow = r;
    });
    const p = awaitWithStartupTimeout(flow, { timeoutMs: 0, onTimeout });
    await vi.advanceTimersByTimeAsync(60_000);
    resolveFlow('ok');
    await expect(p).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('awaitLoginProvidersWithPreparingGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stalled getProviders becomes retryable AUTH_SERVICE_UNAVAILABLE after 30s', async () => {
    const hung = new Promise<string>(() => undefined);
    const log = { info: vi.fn(), warn: vi.fn() };
    const p = awaitLoginProvidersWithPreparingGate(hung, log);
    const rejected = expect(p).rejects.toMatchObject({
      name: 'AuthApiError',
      code: 'AUTH_SERVICE_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(LOGIN_PREPARING_GATE_TIMEOUT_MS - 1);
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await p.catch((err: unknown) => err);
    await rejected;

    expect(error).toBeInstanceOf(AuthApiError);
    expect(mapLoginProvidersLoadFailure(error)).toEqual({
      success: false,
      code: 'AUTH_SERVICE_UNAVAILABLE',
      state: { step: 'error', code: 'AUTH_SERVICE_UNAVAILABLE', recoverTo: 'identifier' },
    });

    const hungRetry = new Promise<string>(() => undefined);
    const retry = awaitLoginProvidersWithPreparingGate(hungRetry, log);
    const retryRejected = expect(retry).rejects.toMatchObject({
      code: 'AUTH_SERVICE_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(LOGIN_PREPARING_GATE_TIMEOUT_MS);
    await retryRejected;
  });

  it('does not abort a late getProviders; only logs the late settle', async () => {
    let resolveFlow!: (v: string) => void;
    const flow = new Promise<string>((resolve) => {
      resolveFlow = resolve;
    });
    const log = { info: vi.fn(), warn: vi.fn() };
    const p = awaitLoginProvidersWithPreparingGate(flow, log);
    const rejected = expect(p).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(LOGIN_PREPARING_GATE_TIMEOUT_MS);
    await rejected;

    resolveFlow('late-providers');
    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).toHaveBeenCalledWith('login providers settled after preparing gate timeout');
    expect(log.warn).not.toHaveBeenCalledWith(
      'login providers request failed after preparing gate timeout',
      expect.anything(),
    );
  });
});
