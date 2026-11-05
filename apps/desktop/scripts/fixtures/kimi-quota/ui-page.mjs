import assert from 'node:assert/strict';
import organizationQuota from '../organization-quota/ui-page.mjs';
const provider = { id: 'kimi-coding', name: 'Kimi Code', connected: true, auth: { method: 'oauth', oauth: { tokenUrl: 'https://auth.kimi.com/api/oauth/token' } }, routing: { pi: { upstream: 'https://api.kimi.com/coding/v1' } } };
export default {
  name: 'kimi-quota',
  entry: './kimi-quota-fixture.tsx',
  viewport: { width: 560, height: 740 },
  real: 'ProviderAccountUsageModule, TodaySpendChip, useProviderAccountUsage, QuotaHoverCard, translations and themes',
  notCovered: 'Live Kimi credentials/API, actual remote transport, native macOS menu bar and full settings/model picker navigation. Synthetic account only.',
  stubs: {
    ...organizationQuota.stubs,
    'src/renderer/hooks/useProviders': `export const useProviders = () => ({ providers: [${JSON.stringify(provider)}] });`,
    'src/renderer/hooks/useClaudeAccountUsage': 'export const useClaudeAccountUsage = () => null;',
  },
  cases: {
    default: { about: 'New subscription: only the returned 5-hour quota', data: {} },
    legacy: { about: 'Legacy subscription: 5-hour and weekly quota', data: { legacy: true } },
    monthly: { about: 'Monthly total and coding limits keep their period labels', data: { monthly: true } },
    'narrow-monthly': { about: 'Monthly limits with the same reset remain distinguishable at 320px', viewport: { width: 320, height: 740 }, data: { monthly: true } },
    unavailable: { about: 'Rejected credentials never display 0% or an API-key-only remedy', data: { error: true } },
    stale: { about: 'Retained quota is labelled stale; the task chip hides old numbers', data: { stale: true } },
    empty: { about: 'No returned quota windows does not imply unlimited or empty', data: { empty: true } },
    narrow: { about: '320px settings card and task chip', viewport: { width: 320, height: 740 }, data: { legacy: true } },
  },
  async ready(page) {
    await page.getByTestId('provider-usage-module').waitFor();
    await page.waitForFunction(() => !document.body.textContent.includes('quotaCard.waiting'));
  },
  async check(page, ui) {
    const settings = page.getByTestId('provider-usage-module');
    const monthly = ['monthly', 'narrow-monthly'].includes(ui.case);
    if (ui.case === 'unavailable') {
      await settings.getByText(await ui.t('providerAccountUsage.kimi.error.auth'), { exact: true }).waitFor();
      assert.equal(await settings.getByRole('progressbar').count(), 0);
    } else if (ui.case === 'empty') {
      await settings.getByText(await ui.t('quotaCard.noWindows'), { exact: true }).waitFor();
      assert.equal(await settings.getByRole('progressbar').count(), 0);
    } else {
      await settings.getByText(await ui.t('quotaCard.remainingPercent', { percent: monthly ? '35' : '77' }), { exact: true }).waitFor();
      assert.equal(await settings.getByText(await ui.t('quotaCard.noWindows'), { exact: true }).count(), 0);
      assert.equal(await settings.getByRole('progressbar').count(), monthly || ['legacy', 'narrow'].includes(ui.case) ? 2 : 1);
      if (ui.case === 'stale') await settings.getByText(await ui.t('providerAccountUsage.kimi.stale'), { exact: true }).waitFor();
    }
    assert.equal(await settings.getByText(/DeepSeek/).count(), 0);
    const chip = page.getByTestId('kimi-task-chip');
    if (['stale', 'unavailable', 'empty'].includes(ui.case)) assert.ok(!(await chip.textContent()).includes('77%'));
    else assert.ok((await chip.textContent()).includes(monthly ? '35%' : '77%'));
    if (monthly) {
      assert.ok((await chip.textContent()).includes(await ui.t('providerAccountUsage.kimi.limit_month_total')));
      assert.ok((await chip.textContent()).includes(await ui.t('providerAccountUsage.kimi.limit_month_code')));
    }
    if (ui.case === 'default') {
      await chip.getByRole('button').first().focus();
      await page.getByTestId('quota-hover-card').last().getByRole('progressbar').first().waitFor();
      await ui.capture('task-details');
    }
  },
};
