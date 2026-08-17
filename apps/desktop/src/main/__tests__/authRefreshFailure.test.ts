/**
 * Refresh-token 失效判定回归测试。
 *
 * 守护的核心契约:冷启动 `initialize()` 与运行时 `refresh()` 只能在「确定性凭据失效」时
 * 删除本地 refresh token;429 限流 / 5xx / 断网 / 无识别码的失败必须保留 token,否则一次
 * 冷启动撞上服务端限流(本仓库新加的 auth 限流)或网络抖动就会把有效用户永久登出。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFINITIVE_REFRESH_FAILURE_CODES,
  getRefreshTokenReplacementCandidate,
  isDefinitiveRefreshFailure,
  isForeignDeviceRefreshFailure,
  pickRefreshTokenReplacementCandidate,
  resolveRefreshFailureAction,
  resolveSessionExpiredReason,
  runRefreshWithReplacementRetry,
  runRefreshWithTransientRetry,
  type RefreshFailureInfo,
  type RefreshFetchResult,
} from '../authRefreshFailure';

describe('resolveSessionExpiredReason', () => {
  it('确定性失效码映射到对应展示分类', () => {
    expect(resolveSessionExpiredReason('INVALID_REFRESH_TOKEN')).toBe('replaced-elsewhere');
    expect(resolveSessionExpiredReason('REFRESH_TOKEN_EXPIRED')).toBe('expired');
    expect(resolveSessionExpiredReason('DEVICE_MISMATCH')).toBe('device-mismatch');
    expect(resolveSessionExpiredReason('MEMBERSHIP_DISABLED')).toBe('account-unavailable');
  });

  it('未识别码 / 缺省一律 unknown,走通用文案', () => {
    expect(resolveSessionExpiredReason(undefined)).toBe('unknown');
    expect(resolveSessionExpiredReason('RATE_LIMITED')).toBe('unknown');
    expect(resolveSessionExpiredReason('SOME_FUTURE_CODE')).toBe('unknown');
  });
});

describe('isDefinitiveRefreshFailure', () => {
  it('成功响应不删除 token', () => {
    expect(isDefinitiveRefreshFailure({ ok: true, data: { accessToken: 'a' } })).toBe(false);
  });

  it('确定性凭据失效码 → 删除 token', () => {
    for (const code of ['REFRESH_TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'MEMBERSHIP_DISABLED']) {
      expect(isDefinitiveRefreshFailure({ ok: false, data: { error: { code } } })).toBe(true);
    }
  });

  it('DEVICE_MISMATCH 不是确定性失效,不得授权删盘', () => {
    const result = { ok: false, data: { error: { code: 'DEVICE_MISMATCH' } } };
    expect(isDefinitiveRefreshFailure(result)).toBe(false);
    expect(isForeignDeviceRefreshFailure(result)).toBe(true);
  });

  it('429 限流(RATE_LIMITED)→ 瞬时失败,保留 token', () => {
    expect(
      isDefinitiveRefreshFailure({ ok: false, data: { error: { code: 'RATE_LIMITED' } } }),
    ).toBe(false);
  });

  it('5xx / 无识别码的失败 → 保留 token', () => {
    expect(isDefinitiveRefreshFailure({ ok: false, data: { error: {} } })).toBe(false);
    expect(isDefinitiveRefreshFailure({ ok: false, data: {} })).toBe(false);
    expect(isDefinitiveRefreshFailure({ ok: false, data: { message: 'Bad Gateway' } })).toBe(false);
  });

  it('断网(apiFetch 返回 data:null,status:0)→ 保留 token', () => {
    expect(isDefinitiveRefreshFailure({ ok: false, data: null })).toBe(false);
  });

  it('未知 4xx 错误码 → 保留 token(保守:宁可保留也不误删)', () => {
    expect(
      isDefinitiveRefreshFailure({ ok: false, data: { error: { code: 'SOME_OTHER_ERROR' } } }),
    ).toBe(false);
  });

  it('确定性错误码集合保持冻结(防止误增删改变删除语义)', () => {
    expect([...DEFINITIVE_REFRESH_FAILURE_CODES].sort()).toEqual([
      'INVALID_REFRESH_TOKEN',
      'MEMBERSHIP_DISABLED',
      'REFRESH_TOKEN_EXPIRED',
    ]);
  });
});

describe('refresh token replacement detection', () => {
  const invalidToken: RefreshFetchResult<unknown> = {
    ok: false,
    status: 401,
    data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
  };
  const rateLimited: RefreshFetchResult<unknown> = {
    ok: false,
    status: 429,
    data: { error: { code: 'RATE_LIMITED' } },
  };
  const expiredToken: RefreshFetchResult<unknown> = {
    ok: false,
    status: 401,
    data: { error: { code: 'REFRESH_TOKEN_EXPIRED' } },
  };
  const deviceMismatch: RefreshFetchResult<unknown> = {
    ok: false,
    status: 401,
    data: { error: { code: 'DEVICE_MISMATCH' } },
  };
  const membershipDisabled: RefreshFetchResult<unknown> = {
    ok: false,
    status: 403,
    data: { error: { code: 'MEMBERSHIP_DISABLED' } },
  };

  it('磁盘 token 与请求 token 不同 → 返回替换候选', () => {
    expect(getRefreshTokenReplacementCandidate('rt-old', 'rt-new')).toBe('rt-new');
  });

  it('磁盘 token 缺失或相同 → 没有替换候选', () => {
    expect(getRefreshTokenReplacementCandidate('rt-old', null)).toBeNull();
    expect(getRefreshTokenReplacementCandidate('rt-old', '')).toBeNull();
    expect(getRefreshTokenReplacementCandidate('rt-old', 'rt-old')).toBeNull();
  });

  it('多来源候选:按顺序取第一枚「非空且不是本次请求那一枚」', () => {
    // legacy → v1 迁移窗口里两个实例可能各写一个文件,只认单一来源的一方追不上对方。
    expect(pickRefreshTokenReplacementCandidate('rt-old', ['rt-v1', 'rt-legacy'])).toBe('rt-v1');
    // v1 还没被别人更新(仍是自己那枚)→ 回退到 legacy 里旧版实例刚轮换出的新 token。
    expect(pickRefreshTokenReplacementCandidate('rt-old', ['rt-old', 'rt-legacy'])).toBe(
      'rt-legacy',
    );
    // 空洞不阻断后续候选。
    expect(pickRefreshTokenReplacementCandidate('rt-old', [null, undefined, '', 'rt-legacy'])).toBe(
      'rt-legacy',
    );
  });

  it('多来源候选:全部缺失或都等于请求 token → 没有替换候选(真确定性失效)', () => {
    expect(pickRefreshTokenReplacementCandidate('rt-old', [])).toBeNull();
    expect(pickRefreshTokenReplacementCandidate('rt-old', [null, undefined, ''])).toBeNull();
    expect(pickRefreshTokenReplacementCandidate('rt-old', ['rt-old', 'rt-old'])).toBeNull();
  });

  it('调用方交出全部来源,由 runner 跨来源挑候选', async () => {
    const okResult: RefreshFetchResult<unknown> = {
      ok: true,
      status: 200,
      data: { accessToken: 'a', refreshToken: 'rt-newer' },
    };
    const doRefresh = vi.fn(async (refreshToken: string) =>
      refreshToken === 'rt-legacy' ? okResult : invalidToken,
    );

    const result = await runRefreshWithReplacementRetry('rt-old', {
      doRefresh,
      // 模拟 authManager 的读侧:v1 仍是自己那枚,legacy 才有旧版实例轮换出的新 token。
      readLatestStoredTokens: () => ['rt-old', 'rt-legacy'],
    });

    expect(result).toMatchObject({ result: okResult, requestedToken: 'rt-legacy' });
  });

  it('首选来源存着已拒的 token 时,不得挤掉次选来源里有效的那枚', async () => {
    // codex #878 P1:v1 存着已拒的 A、legacy 被并发的旧实例轮换成有效的 C。若调用方先按
    // 优先级折叠成单个候选,交出的永远是 A;A 已被拒 → 整轮以确定性失效收场,C 从未被
    // 试过,还会连同 C 一起被删。筛选必须在折叠之前发生。
    const okResult: RefreshFetchResult<unknown> = {
      ok: true,
      status: 200,
      data: { accessToken: 'a', refreshToken: 'rt-d' },
    };
    const doRefresh = vi.fn(async (refreshToken: string) =>
      refreshToken === 'rt-c' ? okResult : invalidToken,
    );

    const result = await runRefreshWithReplacementRetry('rt-a', {
      doRefresh,
      // v1 始终是已被拒的 rt-a;legacy 在本进程重试期间被另一个实例换成了 rt-c。
      readLatestStoredTokens: () => ['rt-a', 'rt-c'],
    });

    expect(result).toMatchObject({
      result: okResult,
      requestedToken: 'rt-c',
      replacementRetries: 1,
    });
    expect(doRefresh).toHaveBeenNthCalledWith(1, 'rt-a');
    expect(doRefresh).toHaveBeenNthCalledWith(2, 'rt-c');
  });

  it('确定性失败且磁盘已有新 token → 用新 token 重试,不清登录态', () => {
    expect(resolveRefreshFailureAction(invalidToken, 'rt-old', 'rt-new')).toEqual({
      kind: 'replacement-retry',
      refreshToken: 'rt-new',
    });
  });

  it('只有 INVALID_REFRESH_TOKEN 可触发替换重试,其余确定性失败直接清登录态', () => {
    expect(resolveRefreshFailureAction(expiredToken, 'rt-old', 'rt-new')).toEqual({
      kind: 'definitive-failure',
    });
    expect(resolveRefreshFailureAction(membershipDisabled, 'rt-old', 'rt-new')).toEqual({
      kind: 'definitive-failure',
    });
  });

  it('DEVICE_MISMATCH 即使磁盘已有其它 token 也不删盘,只判 foreign-device', () => {
    expect(resolveRefreshFailureAction(deviceMismatch, 'rt-old', 'rt-new')).toEqual({
      kind: 'foreign-device',
    });
    expect(resolveRefreshFailureAction(deviceMismatch, 'rt-old', 'rt-old')).toEqual({
      kind: 'foreign-device',
    });
  });

  it('确定性失败且磁盘 token 未变化 → 清登录态', () => {
    expect(resolveRefreshFailureAction(invalidToken, 'rt-old', 'rt-old')).toEqual({
      kind: 'definitive-failure',
    });
  });

  it('非确定性失败即使磁盘 token 未变化 → 仍按瞬时失败处理', () => {
    expect(resolveRefreshFailureAction(rateLimited, 'rt-old', 'rt-old')).toEqual({
      kind: 'transient-failure',
    });
  });

  it('旧 token 确定性失败但磁盘已有新 token → 换新 token 刷新成功', async () => {
    const okResult: RefreshFetchResult<unknown> = {
      ok: true,
      status: 200,
      data: { accessToken: 'a', refreshToken: 'rt-newer' },
    };
    const doRefresh = vi.fn(async (refreshToken: string) =>
      refreshToken === 'rt-new' ? okResult : invalidToken,
    );
    const replacements: Array<{ replacementRetry: number; status: number; code?: string }> = [];

    const result = await runRefreshWithReplacementRetry('rt-old', {
      doRefresh,
      readLatestStoredTokens: () => ['rt-new'],
      onReplacementRetry: ({ replacementRetry, status, code }) =>
        replacements.push({ replacementRetry, status, code }),
    });

    expect(result).toMatchObject({
      result: okResult,
      attempts: 2,
      requestedToken: 'rt-new',
      replacementRetries: 1,
      replacementRetryExhausted: false,
    });
    expect(result.failureAction).toBeUndefined();
    expect(doRefresh).toHaveBeenNthCalledWith(1, 'rt-old');
    expect(doRefresh).toHaveBeenNthCalledWith(2, 'rt-new');
    expect(replacements).toEqual([
      { replacementRetry: 1, status: 401, code: 'INVALID_REFRESH_TOKEN' },
    ]);
  });

  it('旧 token 失败但新 token 稍后才落盘 → 延迟重读后再用新 token 刷新', async () => {
    const okResult: RefreshFetchResult<unknown> = {
      ok: true,
      status: 200,
      data: { accessToken: 'a', refreshToken: 'rt-newer' },
    };
    const doRefresh = vi.fn(async (refreshToken: string) =>
      refreshToken === 'rt-new' ? okResult : invalidToken,
    );
    const latestTokens = ['rt-old', 'rt-new'];
    const sleepCalls: number[] = [];
    const rechecks: Array<{ delayMs: number; status: number; code?: string }> = [];

    const result = await runRefreshWithReplacementRetry('rt-old', {
      doRefresh,
      readLatestStoredTokens: () => [latestTokens.shift() ?? 'rt-new'],
      replacementRecheck: {
        delaysMs: [10],
        sleep: (ms) => (sleepCalls.push(ms), Promise.resolve()),
        onBeforeRecheck: ({ delayMs, status, code }) => rechecks.push({ delayMs, status, code }),
      },
    });

    expect(result).toMatchObject({
      result: okResult,
      attempts: 2,
      requestedToken: 'rt-new',
      replacementRetries: 1,
      replacementRetryExhausted: false,
    });
    expect(doRefresh).toHaveBeenNthCalledWith(1, 'rt-old');
    expect(doRefresh).toHaveBeenNthCalledWith(2, 'rt-new');
    expect(sleepCalls).toEqual([10]);
    expect(rechecks).toEqual([{ delayMs: 10, status: 401, code: 'INVALID_REFRESH_TOKEN' }]);
  });

  it('DEVICE_MISMATCH 不做延迟重读或替换重试', async () => {
    const doRefresh = vi.fn(async () => deviceMismatch);
    const sleep = vi.fn(async () => {});

    const result = await runRefreshWithReplacementRetry('rt-old', {
      doRefresh,
      readLatestStoredTokens: () => ['rt-new'],
      replacementRecheck: {
        delaysMs: [10],
        sleep,
      },
    });

    expect(result).toMatchObject({
      result: deviceMismatch,
      attempts: 1,
      requestedToken: 'rt-old',
      replacementRetries: 0,
      replacementRetryExhausted: false,
      failureAction: { kind: 'foreign-device' },
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(doRefresh).toHaveBeenCalledTimes(1);
  });

  it('替换重试耗尽时返回 replacement-retry,调用方不应清登录态', async () => {
    const doRefresh = vi.fn(async () => invalidToken);
    const latestTokens = ['rt-new-1', 'rt-new-2'];

    const result = await runRefreshWithReplacementRetry('rt-old', {
      doRefresh,
      readLatestStoredTokens: () => [latestTokens.shift() ?? 'rt-new-2'],
      maxReplacementRetries: 1,
    });

    expect(result).toMatchObject({
      result: invalidToken,
      attempts: 2,
      requestedToken: 'rt-new-1',
      replacementRetries: 1,
      replacementRetryExhausted: true,
      failureAction: { kind: 'replacement-retry', refreshToken: 'rt-new-2' },
    });
    expect(doRefresh).toHaveBeenNthCalledWith(1, 'rt-old');
    expect(doRefresh).toHaveBeenNthCalledWith(2, 'rt-new-1');
  });

  it('两个凭证来源互指时不来回重试:已拒过的 token 不再算候选,落到确定性失效', async () => {
    // v1 与 legacy 分叉:各自都是「对方眼里的替换 token」。只排除紧邻的上一枚会让两枚
    // 来回被选中、耗尽重试后以 replacement-retry 收尾——runtime 于是每 60s 重试一枚
    // 已知无效的凭证而永不过期,冷启动则保留不可用凭证并以未登录启动。
    const doRefresh = vi.fn(async () => invalidToken);
    const disk = { v1: 'rt-v1', legacy: 'rt-legacy' };

    const result = await runRefreshWithReplacementRetry('rt-v1', {
      doRefresh,
      readLatestStoredTokens: () => [disk.v1, disk.legacy],
      maxReplacementRetries: 5,
    });

    // 两枚都试过一次就收手,不吃满 maxReplacementRetries。
    expect(result).toMatchObject({
      failureAction: { kind: 'definitive-failure' },
      replacementRetries: 1,
      replacementRetryExhausted: false,
    });
    expect(doRefresh).toHaveBeenCalledTimes(2);
    expect(doRefresh).toHaveBeenNthCalledWith(1, 'rt-v1');
    expect(doRefresh).toHaveBeenNthCalledWith(2, 'rt-legacy');
  });

  it('replacement recheck 期间读回一枚早前已拒过的 token → 同样落到确定性失效', async () => {
    const doRefresh = vi.fn(async () => invalidToken);
    // 磁盘读取序列:①第一轮读到 rt-2 → 追上去重试;②第二轮读不到替换 → 进 recheck;
    // ③recheck 期间又读回最初那枚 rt-1(例如镜像把它写进了另一个来源)。
    const diskReads: (string | null)[] = ['rt-2', null, 'rt-1', null];
    const sleepCalls: number[] = [];

    const result = await runRefreshWithReplacementRetry('rt-1', {
      doRefresh,
      readLatestStoredTokens: () => [diskReads.length ? (diskReads.shift() ?? null) : null],
      maxReplacementRetries: 5,
      replacementRecheck: {
        delaysMs: [10, 20],
        sleep: (ms) => (sleepCalls.push(ms), Promise.resolve()),
      },
    });

    // recheck 读回的 rt-1 在第一轮就被拒过,不得据此再发第三次请求。
    expect(result.failureAction).toEqual({ kind: 'definitive-failure' });
    expect(doRefresh).toHaveBeenCalledTimes(2);
    expect(doRefresh).toHaveBeenNthCalledWith(1, 'rt-1');
    expect(doRefresh).toHaveBeenNthCalledWith(2, 'rt-2');
  });
});

describe('runRefreshWithTransientRetry', () => {
  const okResult: RefreshFetchResult<unknown> = {
    ok: true,
    status: 200,
    data: { accessToken: 'a' },
  };
  const rateLimited: RefreshFetchResult<unknown> = {
    ok: false,
    status: 429,
    data: { error: { code: 'RATE_LIMITED' } },
  };
  const offline: RefreshFetchResult<unknown> = { ok: false, status: 0, data: null };
  const invalidToken: RefreshFetchResult<unknown> = {
    ok: false,
    status: 401,
    data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
  };
  const deviceMismatch: RefreshFetchResult<unknown> = {
    ok: false,
    status: 401,
    data: { error: { code: 'DEVICE_MISMATCH' } },
  };
  /** 立即 resolve 的注入 sleep,记录每次退避时长。 */
  const makeSleep = () => {
    const calls: number[] = [];
    return { calls, sleep: (ms: number) => (calls.push(ms), Promise.resolve()) };
  };

  it('首次成功 → 不重试、不退避', async () => {
    const doRefresh = vi.fn().mockResolvedValue(okResult);
    const { calls, sleep } = makeSleep();
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, { sleep });
    expect(result).toBe(okResult);
    expect(attempts).toBe(1);
    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('瞬时失败(429)后成功 → 退避 rateLimitDelayMs(默认 60s)后重试', async () => {
    const doRefresh = vi.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(okResult);
    const { calls, sleep } = makeSleep();
    const failures: RefreshFailureInfo[] = [];
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      onFailure: (info) => failures.push(info),
    });
    expect(result).toBe(okResult);
    expect(attempts).toBe(2);
    expect(calls).toEqual([60_000]);
    expect(failures).toEqual([
      { attempt: 1, status: 429, code: 'RATE_LIMITED', definitive: false, willRetry: true },
    ]);
  });

  it('确定性凭据失效 → 立即返回,不重试', async () => {
    const doRefresh = vi.fn().mockResolvedValue(invalidToken);
    const { calls, sleep } = makeSleep();
    const failures: RefreshFailureInfo[] = [];
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      onFailure: (info) => failures.push(info),
    });
    expect(result).toBe(invalidToken);
    expect(attempts).toBe(1);
    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(failures).toEqual([
      {
        attempt: 1,
        status: 401,
        code: 'INVALID_REFRESH_TOKEN',
        definitive: true,
        willRetry: false,
      },
    ]);
  });

  it('DEVICE_MISMATCH 立即返回,不按瞬时失败重试', async () => {
    const doRefresh = vi.fn().mockResolvedValue(deviceMismatch);
    const { calls, sleep } = makeSleep();
    const failures: RefreshFailureInfo[] = [];
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      onFailure: (info) => failures.push(info),
    });
    expect(result).toBe(deviceMismatch);
    expect(attempts).toBe(1);
    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(failures).toEqual([
      {
        attempt: 1,
        status: 401,
        code: 'DEVICE_MISMATCH',
        definitive: false,
        willRetry: false,
      },
    ]);
  });

  it('持续瞬时失败(断网)→ 耗尽重试次数后返回最后一次结果', async () => {
    const doRefresh = vi.fn().mockResolvedValue(offline);
    const { calls, sleep } = makeSleep();
    const failures: RefreshFailureInfo[] = [];
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      onFailure: (info) => failures.push(info),
    });
    expect(result).toBe(offline);
    expect(attempts).toBe(3);
    expect(doRefresh).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([1000, 2000]);
    expect(failures.map((f) => f.willRetry)).toEqual([true, true, false]);
    expect(failures.every((f) => !f.definitive && f.status === 0 && f.code === undefined)).toBe(
      true,
    );
  });

  it('重试中途遇到确定性失效 → 停止重试返回该结果', async () => {
    const doRefresh = vi.fn().mockResolvedValueOnce(offline).mockResolvedValueOnce(invalidToken);
    const { calls, sleep } = makeSleep();
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, { sleep });
    expect(result).toBe(invalidToken);
    expect(attempts).toBe(2);
    expect(doRefresh).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([1000]);
  });

  it('自定义退避序列决定最大请求数', async () => {
    const serverError: RefreshFetchResult<unknown> = { ok: false, status: 502, data: null };
    const doRefresh = vi.fn().mockResolvedValue(serverError);
    const { calls, sleep } = makeSleep();
    const { attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      retryDelaysMs: [10],
    });
    expect(attempts).toBe(2);
    expect(doRefresh).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([10]);
  });

  it('429 使用 rateLimitDelayMs 退避而非短退避', async () => {
    const doRefresh = vi.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(okResult);
    const { calls, sleep } = makeSleep();
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      rateLimitDelayMs: 60_000,
    });
    expect(result).toBe(okResult);
    expect(attempts).toBe(2);
    expect(calls).toEqual([60_000]);
  });

  it('非 429 瞬时失败仍使用 retryDelaysMs 短退避', async () => {
    const doRefresh = vi.fn().mockResolvedValueOnce(offline).mockResolvedValueOnce(okResult);
    const { calls, sleep } = makeSleep();
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      rateLimitDelayMs: 60_000,
    });
    expect(result).toBe(okResult);
    expect(attempts).toBe(2);
    expect(calls).toEqual([1000]);
  });

  it('rateLimitDelayMs:0 时 429 立即返回不重试(冷启动路径)', async () => {
    const doRefresh = vi.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(okResult);
    const { calls, sleep } = makeSleep();
    const failures: RefreshFailureInfo[] = [];
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      rateLimitDelayMs: 0,
      onFailure: (info) => failures.push(info),
    });
    expect(result).toBe(rateLimited);
    expect(attempts).toBe(1);
    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(failures).toEqual([
      { attempt: 1, status: 429, code: 'RATE_LIMITED', definitive: false, willRetry: false },
    ]);
  });

  it('rateLimitDelayMs:0 时非 429 瞬时失败仍正常重试', async () => {
    const doRefresh = vi.fn().mockResolvedValueOnce(offline).mockResolvedValueOnce(okResult);
    const { calls, sleep } = makeSleep();
    const { result, attempts } = await runRefreshWithTransientRetry(doRefresh, {
      sleep,
      rateLimitDelayMs: 0,
    });
    expect(result).toBe(okResult);
    expect(attempts).toBe(2);
    expect(calls).toEqual([1000]);
  });
});
