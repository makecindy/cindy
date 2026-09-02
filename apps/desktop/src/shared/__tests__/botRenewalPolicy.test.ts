/**
 * 换代判定。
 *
 * 时间边界是这一层唯一容易错的地方,而错的代价很实在:判早了 = 用户说到一半
 * 上下文没了;判晚了 = 这个功能等于没有;跨日算错 = **每次检查都换代**,伙伴
 * 每说一句话就翻一次篇。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_RENEWAL_POLICY,
  lastRenewalBoundary,
  normalizeBotRenewalPolicy,
  shouldRenewBotSession,
  type BotRenewalPolicy,
} from '../botRenewalPolicy';

/** 本地墙钟构造 —— 用户说「早上 6 点」指的是他自己所在时区的 6 点。 */
function at(y: number, m: number, d: number, h: number, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function policy(over: Partial<BotRenewalPolicy> = {}): BotRenewalPolicy {
  return { ...DEFAULT_BOT_RENEWAL_POLICY, mode: 'daily', notify: true, ...over };
}

describe('默认策略', () => {
  it('Bot 身份永久，但物理 Session 默认每天凌晨 4 点后惰性换代', () => {
    expect(DEFAULT_BOT_RENEWAL_POLICY).toEqual({
      mode: 'daily',
      atHour: 4,
      idleMinutes: 1440,
      notify: false,
    });
  });
});

describe('上一次换代时刻', () => {
  it('已经过了今天那个点:边界就是今天', () => {
    const boundary = lastRenewalBoundary(new Date(at(2026, 8, 23, 9)), 6);
    expect(boundary.getTime()).toBe(at(2026, 8, 23, 6));
  });

  it('还没到今天那个点:边界回退到昨天', () => {
    // 凌晨 2 点检查。不回退的话会算出「今天 6 点」这个未来时刻,
    // 于是任何对话都早于它 —— 每次检查都换代。
    const boundary = lastRenewalBoundary(new Date(at(2026, 8, 23, 2)), 6);
    expect(boundary.getTime()).toBe(at(2026, 8, 22, 6));
  });

  it('正好在那个点上算已过', () => {
    const boundary = lastRenewalBoundary(new Date(at(2026, 8, 23, 6)), 6);
    expect(boundary.getTime()).toBe(at(2026, 8, 23, 6));
  });
});

describe('该不该换代', () => {
  it('昨天聊的,今天早上 6 点之后再来 → 换', () => {
    expect(
      shouldRenewBotSession({
        policy: policy(),
        lastActivityAt: at(2026, 8, 22, 22),
        now: at(2026, 8, 23, 9),
      }),
    ).toBe('daily');
  });

  it('今天 6 点之后聊过,当天再来 → 不换', () => {
    expect(
      shouldRenewBotSession({
        policy: policy(),
        lastActivityAt: at(2026, 8, 23, 8),
        now: at(2026, 8, 23, 20),
      }),
    ).toBeNull();
  });

  it('半夜连着聊:凌晨 2 点还在说话,3 点再来 → 不换', () => {
    // 这一条是跨日边界最容易错的地方:今天的 6 点还没到,起点在昨天 6 点,
    // 而凌晨 2 点的活动晚于昨天 6 点 —— 不该打断一场正在进行的夜谈。
    expect(
      shouldRenewBotSession({
        policy: policy(),
        lastActivityAt: at(2026, 8, 23, 2),
        now: at(2026, 8, 23, 3),
      }),
    ).toBeNull();
  });

  it('前天聊的,凌晨 2 点来 → 换(起点是昨天 6 点)', () => {
    expect(
      shouldRenewBotSession({
        policy: policy(),
        lastActivityAt: at(2026, 8, 21, 20),
        now: at(2026, 8, 23, 2),
      }),
    ).toBe('daily');
  });

  it('还有活儿在跑就不换 —— 那些活儿回来要往这段对话里报结果', () => {
    expect(
      shouldRenewBotSession({
        policy: policy(),
        lastActivityAt: at(2026, 8, 21, 20),
        now: at(2026, 8, 23, 9),
        hasActiveWork: true,
      }),
    ).toBeNull();
  });

  it('关掉就永不换代', () => {
    expect(
      shouldRenewBotSession({
        policy: policy({ mode: 'none' }),
        lastActivityAt: at(2026, 8, 1, 10),
        now: at(2026, 8, 23, 9),
      }),
    ).toBeNull();
  });

  it('刚建好还没说过话不算「该翻篇」', () => {
    expect(
      shouldRenewBotSession({ policy: policy(), lastActivityAt: 0, now: at(2026, 8, 23, 9) }),
    ).toBeNull();
  });

  it('时钟回拨导致活动时间在未来时不据此判断', () => {
    expect(
      shouldRenewBotSession({
        policy: policy(),
        lastActivityAt: at(2026, 8, 24, 9),
        now: at(2026, 8, 23, 9),
      }),
    ).toBeNull();
  });

  it('空闲档:够久才换,不够不换', () => {
    const idle = policy({ mode: 'idle', idleMinutes: 60 });
    const now = at(2026, 8, 23, 12);
    expect(shouldRenewBotSession({ policy: idle, lastActivityAt: now - 61 * 60_000, now })).toBe(
      'idle',
    );
    expect(
      shouldRenewBotSession({ policy: idle, lastActivityAt: now - 59 * 60_000, now }),
    ).toBeNull();
  });

  it('both 档:空闲先到就报空闲', () => {
    const both = policy({ mode: 'both', idleMinutes: 60 });
    const now = at(2026, 8, 23, 12);
    // 今天 8 点聊的(晚于今天 6 点,日界不触发),但已空闲 4 小时。
    expect(shouldRenewBotSession({ policy: both, lastActivityAt: at(2026, 8, 23, 8), now })).toBe(
      'idle',
    );
  });
});

describe('策略归一', () => {
  it('乱七八糟的输入回落到默认', () => {
    expect(normalizeBotRenewalPolicy(null)).toEqual(DEFAULT_BOT_RENEWAL_POLICY);
    expect(normalizeBotRenewalPolicy({ mode: 'whenever' })).toEqual(DEFAULT_BOT_RENEWAL_POLICY);
    expect(normalizeBotRenewalPolicy({ atHour: 25 }).atHour).toBe(4);
    expect(normalizeBotRenewalPolicy({ atHour: -1 }).atHour).toBe(4);
    expect(normalizeBotRenewalPolicy({ atHour: 3.5 }).atHour).toBe(4);
  });

  it('空闲下限 5 分钟 —— 再短就不是空闲,是说两句就翻篇', () => {
    expect(normalizeBotRenewalPolicy({ idleMinutes: 1 }).idleMinutes).toBe(1440);
    expect(normalizeBotRenewalPolicy({ idleMinutes: 30 }).idleMinutes).toBe(30);
  });

  it('合法值原样保留', () => {
    expect(normalizeBotRenewalPolicy({ mode: 'none', atHour: 0, notify: false })).toEqual({
      mode: 'none',
      atHour: 0,
      idleMinutes: 1440,
      notify: false,
    });
  });
});
