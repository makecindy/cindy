import { describe, expect, it } from 'vitest';

import {
  MAX_CONSECUTIVE_OVERLOAD_TURNS,
  OVERLOAD_RESUME_DELAY_MS,
  classifyTurnOverload,
  classifyTurnUsageLimit,
} from '../usageLimit';

describe('classifyTurnUsageLimit', () => {
  it('matches Claude structured sdkError rate_limit', () => {
    expect(classifyTurnUsageLimit({ sdkError: 'rate_limit', message: 'Too many requests' })).toBe(true);
  });

  it('does NOT match Claude billing_error (out of credit, no reset → stays blocked)', () => {
    expect(classifyTurnUsageLimit({ sdkError: 'billing_error', message: 'credit balance too low' })).toBe(false);
  });

  it('matches Codex rate-limit via message text (no structured tag)', () => {
    expect(classifyTurnUsageLimit({ message: 'rate limit reached, retry later' })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'usage limit exceeded' })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'quota exhausted' })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'HTTP 429: Too Many Requests' })).toBe(true);
  });

  it('matches a preserved non-secret rate-limit status after message redaction', () => {
    expect(classifyTurnUsageLimit({ message: 'Authorization: [REDACTED]', errorStatus: 429 })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'Authorization: [REDACTED]', errorStatus: 529 })).toBe(true);
  });

  it('matches a preserved quota marker after message redaction', () => {
    expect(classifyTurnUsageLimit({ message: 'Authorization: [REDACTED]', usageLimit: true })).toBe(true);
  });

  it('does NOT match ordinary errors', () => {
    expect(classifyTurnUsageLimit({ sdkError: 'server_error', message: 'boom' })).toBe(false);
    expect(classifyTurnUsageLimit({ message: 'tool failed: file not found' })).toBe(false);
  });

  it('handles non-object / empty input', () => {
    expect(classifyTurnUsageLimit(null)).toBe(false);
    expect(classifyTurnUsageLimit(undefined)).toBe(false);
    expect(classifyTurnUsageLimit('rate limit')).toBe(false);
    expect(classifyTurnUsageLimit({})).toBe(false);
  });
});

describe('classifyTurnOverload', () => {
  it('matches the Codex capacity rejection Codex itself never retries', () => {
    expect(
      classifyTurnOverload({ message: 'Selected model is at capacity. Please try a different model.' }),
    ).toBe(true);
  });

  it('matches Anthropic 529 by status and by error code', () => {
    expect(classifyTurnOverload({ message: 'Authorization: [REDACTED]', errorStatus: 529 })).toBe(true);
    expect(classifyTurnOverload({ message: 'overloaded_error: Overloaded' })).toBe(true);
  });

  it('does NOT match a real account rate limit (different recovery timing)', () => {
    // 限额要等账号周期重置(小时级),不能走过载的一分钟短窗口。
    expect(classifyTurnOverload({ sdkError: 'rate_limit', message: 'rate limit reached' })).toBe(false);
    expect(classifyTurnOverload({ message: 'HTTP 429: Too Many Requests', errorStatus: 429 })).toBe(false);
  });

  it('does NOT match implementation copy that merely contains "capacity"', () => {
    expect(classifyTurnOverload({ message: 'buffer capacity dropping → replayLossy' })).toBe(false);
    expect(classifyTurnOverload({ message: 'increase the cache capacity to 256' })).toBe(false);
  });

  it('does NOT match ordinary errors', () => {
    expect(classifyTurnOverload({ sdkError: 'server_error', message: 'boom' })).toBe(false);
    expect(classifyTurnOverload({ message: 'tool failed: file not found' })).toBe(false);
  });

  it('handles non-object / empty input', () => {
    expect(classifyTurnOverload(null)).toBe(false);
    expect(classifyTurnOverload(undefined)).toBe(false);
    expect(classifyTurnOverload('at capacity')).toBe(false);
    expect(classifyTurnOverload({})).toBe(false);
  });

  it('结构化 codexErrorInfo 命中时不依赖文案措辞', () => {
    // 这条锁的是「codex 改了过载文案后 goal 侧仍能自动续跑」。message 故意完全不含
    // `at capacity`：只认文案时这里会返回 false，finalizeTurn 就把 goal 判 blocked，
    // 而不是走 OVERLOAD_RESUME_DELAY_MS 的短窗口续跑 —— 可自愈的容量抖动变成死局。
    expect(
      classifyTurnOverload({
        message: 'The upstream declined this request.',
        codexErrorInfo: 'serverOverloaded',
      }),
    ).toBe(true);
    // 连 message 都没有时同样成立（host 合成的错误可能不带文案）。
    expect(classifyTurnOverload({ codexErrorInfo: 'serverOverloaded' })).toBe(true);
  });

  it('非过载的结构化 tag 不误判成过载', () => {
    // usageLimitExceeded 要走限额通道等账号周期重置，不能被拽进一分钟短窗口。
    expect(classifyTurnOverload({ message: 'boom', codexErrorInfo: 'usageLimitExceeded' })).toBe(false);
    expect(classifyTurnOverload({ message: 'boom', codexErrorInfo: 'contextWindowExceeded' })).toBe(false);
    expect(
      classifyTurnOverload({ message: 'stream gone', codexErrorInfo: 'responseStreamDisconnected' }),
    ).toBe(false);
  });

  it('529 命中两条判定，靠调用方优先判过载来消歧', () => {
    // controller 必须先问 classifyTurnOverload：走限额分支会因为账号并未被限流而
    // 拿不到 resetAt，目标就停在 usageLimited 等人手动 resume。
    const data = { message: 'Authorization: [REDACTED]', errorStatus: 529 };
    expect(classifyTurnOverload(data)).toBe(true);
    expect(classifyTurnUsageLimit(data)).toBe(true);
  });

  it('过载续跑窗口保持在分钟级', () => {
    // agent 侧已就地退避过，这里只是第二次机会；调大等于让目标长时间假死。
    expect(OVERLOAD_RESUME_DELAY_MS).toBe(60_000);
  });

  it('连续过载上限保持在小数值', () => {
    // 这是唯一不依赖用户配置的止损闸门：生产默认 maxTurns / budgetTokens 都是
    // null，noProgressStreak 又不被过载轮推进，三道预算护栏一道都拦不住。
    // 调大直接等比放大容量故障期的请求量与额度消耗。
    expect(MAX_CONSECUTIVE_OVERLOAD_TURNS).toBe(3);
  });
});
