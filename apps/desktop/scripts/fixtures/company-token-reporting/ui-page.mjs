import assert from 'node:assert/strict';

export default {
  name: 'company-token-reporting',
  entry: './view.tsx',
  viewport: { width: 1100, height: 780 },
  real: 'Company statistics settings, switch, copy and themes',
  notCovered: 'Server policy, authentication and network transport',
  stubs: {
    'src/renderer/hooks/useUsageHistory': `
      const money = {amount:0, currency:'CNY', approximate:false, kind:'actual-cost'};
      const history = { todayKey: '2026-11-18', days: [{day:'2026-11-18',tokens:12400,money}],
        models: [], modelDaily: [], totals: {today:money,last30Days:money,last30DaysWithEstimatedValue:money,last30DaysEstimatedValue:money,todayTokens:12400,last30DaysTokens:12400},
        anomaly:{isAnomalous:false,trailing7DayAvg:null}, streak: { current: 1, longest: 1 } };
      export const useUsageHistory = () => ({history, refreshing: false});
    `,
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({isAuthenticated:true,mode:"cloud",user:{orgId:"fixture",membershipKind:"org"},dataOwnerGeneration:1});',
  },
  cases: { default: { about: 'Enterprise account with reporting enabled' } },
  async ready(page) { await page.getByRole('switch').waitFor(); },
  async check(page) {
    await page.waitForFunction(() => document.body.dataset.noticeShown === 'true');
    const toggle = page.getByRole('switch');
    assert.equal(await toggle.isChecked(), true);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true');
  },
};
