import { describe, expect, it } from 'vitest';
import {
  hasUsableCodexCredits,
  selectableSubscriptionAccount,
  subscriptionQuotaOverview,
} from './subscriptionSelection';

// Unit: chosen picker design C needs a common display rule on Desktop/Mobile.
// Previous coverage had only independent quotas, no average or reset reminder.
const now = 1_800_000_000_000;
const reset = (hours: number) => now / 1000 + hours * 3600;
describe('weekly account-pool overview', () => {
  it('averages account percentages, retaining a reminder for the account near reset', () => {
    expect(subscriptionQuotaOverview([
      { remaining: 34, resetsAt: reset(72) },
      { remaining: 80, resetsAt: reset(6) },
    ], now)).toEqual({average:57,resetSoonCount:1,nextResetIndex:1,reset:{remaining:80,time:'6h',level:'crit'},members:[
      {remaining:34,resetSoon:false,resetLevel:'normal'},{remaining:80,resetSoon:true,resetLevel:'crit'},
    ]});
  });
  it.each([undefined, null, NaN, Infinity])('leaves an incomplete average unknown (%s)', remaining => {
    const view = subscriptionQuotaOverview([{remaining}, {remaining:80,resetsAt:reset(6)}],now);
    expect(view.average).toBeNull();
    expect(view.resetSoonCount).toBe(1);
  });
  it('does not turn an expired snapshot into quota or a reset reminder', () => {
    const accounts = [{remaining:80,resetsAt:reset(6)}, {remaining:0,resetsAt:reset(72)}];
    expect(subscriptionQuotaOverview(accounts,now).average).toBe(40);
    expect(subscriptionQuotaOverview(accounts,now+6*3600000)).toMatchObject({average:null,resetSoonCount:0});
  });
  it.each([
    [30,24,true], [29,6,true], [80,24+1/3600,false], [80,0,false], [0,6,false], [10,24,false], [10,6,true],
  ])('uses weekly consumption pace for reminders within 24h (%s%%, %sh)', (remaining,hours,expected) => {
    expect(subscriptionQuotaOverview([{remaining,resetsAt:reset(hours)}],now).resetSoonCount).toBe(expected?1:0);
  });
  // The visible deadline and percentage must refer to the same earliest qualifying
  // account, regardless of pool order; expired and empty members cannot win.
  it('selects the earliest substantial reset and advances after expiry', () => {
    const accounts = [
      {remaining:80,resetsAt:reset(6)}, {remaining:60,resetsAt:reset(2)},
      {remaining:0,resetsAt:reset(1)}, {remaining:90,resetsAt:reset(-1)},
    ];
    expect(subscriptionQuotaOverview(accounts,now).nextResetIndex).toBe(1);
    expect(subscriptionQuotaOverview(accounts,now+2*3600000).nextResetIndex).toBe(0);
    expect(subscriptionQuotaOverview(accounts,now+6*3600000).nextResetIndex).toBeNull();
    expect(subscriptionQuotaOverview(accounts,now+6*3600000).reset).toBeNull();
    expect(subscriptionQuotaOverview(accounts,now+115*60000).reset).toEqual({remaining:60,time:'5m',level:'crit'});
  });
  it('uses the existing reset-time warning and critical boundaries', () => {
    expect(subscriptionQuotaOverview([{remaining:80,resetsAt:reset(24)}],now).reset?.level).toBe('warn');
    expect(subscriptionQuotaOverview([{remaining:80,resetsAt:reset(6+1/3600)}],now).reset?.level).toBe('warn');
    expect(subscriptionQuotaOverview([{remaining:80,resetsAt:reset(6)}],now).reset?.level).toBe('crit');
  });
  it('allows a known percentage with no reset time but never invents a deadline', () => {
    expect(subscriptionQuotaOverview([{remaining:80}],now)).toMatchObject({average:80,resetSoonCount:0});
    expect(subscriptionQuotaOverview([],now)).toMatchObject({average:null,resetSoonCount:0});
  });
});

/* 测试价值
 * - 生产入口与可观察结果：selectableSubscriptionAccount / hasUsableCodexCredits 对单账号 OpenAI 池的选中预览结果。
 * - Bug／规则依据：OpenAI 订阅周额度 100% 但仍有可用 Credits（如 60314.38）时，不应被当作不可用而返回 null。
 * - 现有覆盖缺口：原单测只测 subscriptionQuotaOverview，未覆盖 Credits 对 selectableSubscriptionAccount 的放行与拦截。
 * - 最小失败输入：status='limited' 且 usage.codex.credits={ hasCredits: true, unlimited: false, balance: '60314.38' }。
 * - tier：unit（纯函数状态矩阵，无 I/O）。
 */
describe('OpenAI credits usability in selectableSubscriptionAccount', () => {
  it.each([
    [{ hasCredits: true, unlimited: false, balance: '60314.38' }, true],
    [{ hasCredits: true, unlimited: true, balance: null }, true],
    [{ hasCredits: true, unlimited: false, balance: '1,234.50' }, true],
    [{ hasCredits: true, unlimited: false, balance: '0' }, false],
    [{ hasCredits: true, unlimited: false, balance: '-1' }, false],
    [{ hasCredits: false, unlimited: false, balance: '60314.38' }, false],
    [{ hasCredits: true, unlimited: false, balance: '60314.38', spendControlReached: true }, false],
    [null, false],
    [undefined, false],
  ])('treats status=limited account with credits=%j as selectable=%s', (credits, expected) => {
    expect(hasUsableCodexCredits(credits)).toBe(expected);
    const account = {
      id: 'default',
      paused: false,
      status: 'limited',
      running: 0,
      limit: 4,
      identity: 'user@example.test',
      usage: credits === undefined ? undefined : { codex: { credits } },
    };
    const picked = selectableSubscriptionAccount({ configured: true, accounts: [account] });
    expect(picked).toBe(expected ? account : null);
  });
});
