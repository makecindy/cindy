import assert from 'node:assert/strict';
import organizationQuota from '../organization-quota/ui-page.mjs';
const { ['src/renderer/hooks/useClaudeSubscriptionUsage']: ignored, ...stubs } = organizationQuota.stubs;
export default {
  name: 'claude-quota-warning',
  entry: './quota-fixture.tsx',
  viewport: { width: 720, height: 400 },
  real: 'TodaySpendChip, useClaudeSubscriptionUsage, QuotaHoverCard, translations and themes',
  notCovered: 'Live accounts and remote transport; all quota and task costs are synthetic.',
  stubs: {
    ...stubs,
    'src/renderer/hooks/useClaudeOAuthConnected': 'export const useClaudeOAuthConnected = () => true;',
    'src/renderer/hooks/useClaudeAccountUsage': 'export const useClaudeAccountUsage = () => null;',
    'src/renderer/hooks/useSessionUsageMoney': `const money = { amount: 8.15, currency: 'USD', approximate: true, kind: 'value-estimate' }; export const useSessionUsageMoney = () => ({ actualMoney: null, estimatedValueMoney: money, totalMoney: money });`,
  },
  cases: {
    default: { about: 'Hidden total week is shown in yellow, with neutral task value', data: { totalUsed: 76 } },
    normal: { about: 'Healthy total week stays compact', data: { totalUsed: 20 } },
    critical: { about: 'Only the depleted total-week percentage turns red', data: { totalUsed: 95 } },
    rejected: { about: 'Request rejection is a separate red status with quota details', data: { totalUsed: 76, rejected: true } },
    narrow: { about: 'Extra total-week warning at narrow desktop width', viewport: { width: 320, height: 400 }, data: { totalUsed: 76 } },
  },
  async ready(page) {
    await page.getByTestId('task-usage-trigger').getByText(/75%/).waitFor();
  },
  async check(page, ui) {
    const trigger = page.getByTestId('task-usage-trigger');
    assert.ok(!(await trigger.getAttribute('class')).includes('error-fg'));
    const box = await trigger.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= await page.evaluate(() => window.innerWidth), 'quota chip stays inside the viewport');
    const total = await ui.t('todaySpend.claude.totalWeeklyLabel');
    assert.equal((await trigger.textContent()).includes(total), ui.case !== 'normal');
    assert.equal(await trigger.locator('[class*="error-fg"]').count(), ui.case === 'rejected' ? 1 : 0);
    if (ui.case === 'rejected') {
      await ui.capture('chip');
      await trigger.hover();
      await page.getByTestId('quota-hover-card').waitFor();
    }
  },
};
