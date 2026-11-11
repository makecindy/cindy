import { describe, expect, it } from 'vitest';
import { subscriptionQuotaOverview } from './subscriptionSelection';

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
