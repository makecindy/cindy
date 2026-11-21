import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractUsageLimitRecoveryHint,
  isGlmCycleQuotaExhausted,
} from '@/lib/usageLimitRecovery';

const NOW = Date.parse('2026-01-24T10:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usage limit recovery detection', () => {
  it('uses Claude structured rate-limit data and a structured reset timestamp', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          sdkError: 'rate_limit',
          message: 'Rate limit reached',
          resetAt: '2026-01-24T12:30:00.000Z',
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: Date.parse('2026-01-24T12:30:00.000Z'), resetAtSource: 'structured' });
  });

  it('recognizes Codex usage-limit signals and relative retry times', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          codexErrorInfo: 'usageLimitExceeded',
          message: 'Usage limit reached. Try again in 1h 15m.',
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: NOW + 75 * 60_000, isAccountUsageLimit: true, resetAtSource: 'relative' });
  });

  it('parses the Codex app-server "try again at" wording in local time', () => {
    const sameDay = new Date(NOW);
    sameDay.setHours(23, 30, 0, 0);
    if (sameDay.getTime() <= NOW) sameDay.setDate(sameDay.getDate() + 1);
    expect(
      extractUsageLimitRecoveryHint(
        {
          codexErrorInfo: 'usageLimitExceeded',
          message: "You've hit your usage limit. Upgrade to Pro, or try again at 11:30 PM.",
        },
        NOW,
      )?.resetAtMs,
    ).toBe(sameDay.getTime());

    expect(
      extractUsageLimitRecoveryHint(
        {
          codexErrorInfo: 'usageLimitExceeded',
          message: "You've hit your usage limit. Try again at Jan 27, 2026 3:05 PM.",
        },
        NOW,
      )?.resetAtMs,
    ).toBe(new Date(2026, 0, 27, 15, 5).getTime());
  });

  it('drops zone-less clock times when the local time zone is not trusted (SSH sessions)', () => {
    const remote = { localTimeZoneTrusted: false };
    expect(
      extractUsageLimitRecoveryHint(
        { codexErrorInfo: 'usageLimitExceeded', message: 'Try again at Jan 27, 2026 3:05 PM.' },
        NOW,
        remote,
      )?.resetAtMs,
    ).toBeNull();
    // 带时区的钟点与相对时长不受影响。
    expect(
      extractUsageLimitRecoveryHint(
        { sdkError: 'rate_limit', message: "You've hit your limit · resets 11pm (UTC)" },
        NOW,
        remote,
      )?.resetAtMs,
    ).toBe(Date.parse('2026-01-24T23:00:00.000Z'));
    expect(
      extractUsageLimitRecoveryHint(
        { codexErrorInfo: 'usageLimitExceeded', message: 'Try again in 1h 15m.' },
        NOW,
        remote,
      )?.resetAtMs,
    ).toBe(NOW + 75 * 60_000);
  });

  it("parses Pi's approximate ChatGPT relative reset", () => {
    expect(
      extractUsageLimitRecoveryHint(
        { message: 'You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.' },
        NOW,
      )?.resetAtMs,
    ).toBe(NOW + 12 * 60_000);
  });

  it('extracts the organization plan and reset time from the Codex 429 payload', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          message:
            'API Error: Request rejected (429) · {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"business","resets_at":1788220709,"eligible_promo":null,"resets_in_seconds":1264528}}',
        },
        Date.parse('2026-08-17T00:00:00.000Z'),
      ),
    ).toEqual({
      resetAtMs: Date.parse('2026-08-31T23:58:29.000Z'),
      isAccountUsageLimit: true,
      planType: 'business',
      resetAtSource: 'structured',
    });
  });

  it('does not classify a transient Codex 429 as an account usage limit', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          errorStatus: 429,
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
          message: 'Too many requests',
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: null });
  });

  it('parses the real Claude session-limit wording with a named timezone', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          message: "You've hit your session limit · resets 9:10pm (Asia/Shanghai)",
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: Date.parse('2026-01-24T13:10:00.000Z') });
  });

  // Unit regression: the screenshot's text-only five-hour error was not recognized,
  // so its explicit timezone/reset was lost. Existing cases only covered session/weekly.
  it.each(["You've hit your 5-hour limit", 'You’ve hit your 5-hour limit'])(
    'parses the five-hour deadline without SDK metadata: %s', (message) => {
      expect(extractUsageLimitRecoveryHint(
        { message: `${message} · resets 2:30am (Pacific/Auckland)` },
        Date.parse('2026-11-11T10:00:00Z'),
        { localTimeZoneTrusted: false },
      )).toEqual({ resetAtMs: Date.parse('2026-11-11T13:30:00Z') });
    },
  );

  it('normalizes Intl midnight hour 24 while parsing a time-of-day reset', () => {
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (
      this: Intl.DateTimeFormat,
      date,
    ) {
      return [
        ...originalFormatToParts
          .call(this, date)
          .map((part) =>
            part.type === 'hour' && part.value === '00' ? { ...part, value: '24' } : part,
          ),
        { type: 'weekday', value: 'not-a-number' },
      ];
    });

    expect(
      extractUsageLimitRecoveryHint(
        {
          sdkError: 'rate_limit',
          message: "You've hit your session limit · resets 12:00am (UTC)",
        },
        Date.parse('2026-01-24T23:00:00.000Z'),
      ),
    ).toEqual({ resetAtMs: Date.parse('2026-01-25T00:00:00.000Z') });
  });

  it('keeps weekly limits actionable without guessing an unsupported weekday reset time', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          message: "You've hit your weekly limit · resets Mon 12:00am (Asia/Shanghai)",
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: null });
  });

  it('keeps a restorable limit actionable when the reset time is unknown', () => {
    expect(
      extractUsageLimitRecoveryHint({ errorStatus: 429, message: 'Too many requests' }, NOW),
    ).toEqual({ resetAtMs: null });
  });

  // GLM(智谱)1308 的实录文案把重置时间写成中文绝对时刻且不带时区,之前五个模式
  // 都不命中,任务只能停在 no usable reset time(issue #9194)。
  it('parses the GLM Chinese quota reset timestamp without a time zone', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          errorStatus: 429,
          message:
            'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-11-06 18:54:03 重置。]',
        },
        Date.parse('2026-11-05T00:00:00.000Z'),
      )?.resetAtMs,
    ).toBe(new Date(2026, 10, 6, 18, 54, 3).getTime());
  });

  it('parses a bare local wall-clock reset timestamp', () => {
    expect(
      extractUsageLimitRecoveryHint(
        { errorStatus: 429, message: 'rate limit exceeded. Your quota resets at 2026-11-06 18:54:03.' },
        Date.parse('2026-11-05T00:00:00.000Z'),
      )?.resetAtMs,
    ).toBe(new Date(2026, 10, 6, 18, 54, 3).getTime());
  });

  it('drops a zone-less wall-clock reset when the local time zone is not trusted', () => {
    // 不带时区的时刻按本机时区理解;SSH 远程会话时报错来自远端主机,不能按本机时区解析。
    expect(
      extractUsageLimitRecoveryHint(
        {
          errorStatus: 429,
          message: '您的限额将在 2026-11-06 18:54:03 重置。',
        },
        Date.parse('2026-11-06T10:00:00.000Z'),
        { localTimeZoneTrusted: false },
      )?.resetAtMs,
    ).toBeNull();
  });

  it('keeps a reset timestamp that carries a time zone out of the wall-clock path', () => {
    // 带 Z / 数字偏移的时间由 ISO 与数字偏移分支负责,裸本地时刻分支不能抢走它。
    expect(
      extractUsageLimitRecoveryHint(
        { errorStatus: 429, message: 'Your quota resets at 2026-11-06T18:54:03Z.' },
        Date.parse('2026-11-06T10:00:00.000Z'),
      )?.resetAtMs,
    ).toBe(Date.parse('2026-11-06T18:54:03.000Z'));
  });

  it('keeps a reset timestamp that names a time zone out of the wall-clock path', () => {
    // 裸字母时区(UTC / GMT / EST...)同样是绝对时间,不能按本机时区理解。
    const hint = extractUsageLimitRecoveryHint(
      { errorStatus: 429, message: 'Your quota resets at 2026-11-06 18:54:03 UTC.' },
      Date.parse('2026-11-05T00:00:00.000Z'),
    );
    expect(hint?.resetAtMs ?? null).toBeNull();
  });

  it('drops a wall-clock reset timestamp that is already in the past', () => {
    // 只接受未来时刻;nowMs 取各时区换算结果之后,保证跨时区稳定。
    const hint = extractUsageLimitRecoveryHint(
      { errorStatus: 429, message: 'Your quota resets at 2026-11-06 18:54:03.' },
      Date.parse('2026-11-08T00:00:00.000Z'),
    );
    expect(hint?.resetAtMs ?? null).toBeNull();
  });

  // GLM Coding Plan 的周期额度文案(5 小时 / 每周窗口用尽)本身就是账号限额信号,
  // 不依赖上游有没有带上 429 之类的结构化标记(Claude Code bridge 常常不带)。
  it('recognizes the GLM cycle quota wording as a usage limit and tags its reset source', () => {
    const hint = extractUsageLimitRecoveryHint(
      {
        message:
          'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-11-06 18:54:03 重置。]',
      },
      Date.parse('2026-11-01T00:00:00.000Z'),
    );
    expect(hint?.resetAtMs).toBe(new Date(2026, 10, 6, 18, 54, 3).getTime());
    expect(hint?.resetAtSource).toBe('local-wall-clock');
  });

  it('separates the GLM cycle quota wording from an ordinary rate limit', () => {
    expect(isGlmCycleQuotaExhausted({ message: '已达到 5 小时的使用上限。' })).toBe(true);
    expect(isGlmCycleQuotaExhausted({ message: '已达到每周使用上限。' })).toBe(true);
    expect(isGlmCycleQuotaExhausted({ message: 'Too many requests' })).toBe(false);
    expect(isGlmCycleQuotaExhausted({ message: '请求过于频繁，请 1 分钟后再试' })).toBe(false);
    expect(isGlmCycleQuotaExhausted({ message: 'Your 5-minute limit resets in 1 min' })).toBe(false);
    expect(isGlmCycleQuotaExhausted(null)).toBe(false);
  });

  it('excludes billing depletion and temporary upstream overload', () => {
    expect(
      extractUsageLimitRecoveryHint(
        { sdkError: 'billing_error', message: 'Credit balance too low' },
        NOW,
      ),
    ).toBeNull();
    expect(
      extractUsageLimitRecoveryHint(
        {
          errorStatus: 529,
          codexErrorInfo: 'serverOverloaded',
          message: 'Selected model is at capacity',
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      extractUsageLimitRecoveryHint({ message: 'insufficient_quota: add billing credits' }, NOW),
    ).toBeNull();
  });

  it('keeps an upstream overload that also says "rate limit exceeded" out of the limit path', () => {
    // 实录文案同时命中限额正则与过载短语，过载短语必须优先(否则会按限额的周期
    // 重置去安排自动续跑，issue #7897)。
    expect(
      extractUsageLimitRecoveryHint(
        { message: 'rate limit exceeded: The engine is currently overloaded, please try again later' },
        NOW,
      ),
    ).toBeNull();
  });
});
