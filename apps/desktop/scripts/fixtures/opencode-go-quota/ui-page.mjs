import assert from 'node:assert/strict';
import organizationQuota from '../organization-quota/ui-page.mjs';

const provider = {
  id: 'opencode-go', name: 'OpenCode Go', source: 'user', connected: true,
  auth: { method: 'apiKey' }, access: { kind: 'api' },
  routing: { codex: { upstream: 'https://opencode.ai/zen/go/v1' } },
};

export default {
  name: 'opencode-go-quota',
  entry: './opencode-go-quota-fixture.tsx',
  viewport: { width: 560, height: 740 },
  real: 'ProviderAccountUsageModule, TodaySpendChip, useProviderAccountUsage, QuotaHoverCard, translations and themes',
  notCovered: 'Live OpenCode credentials/API, actual remote transport and native macOS menu bar. Synthetic account only.',
  stubs: {
    ...organizationQuota.stubs,
    'src/renderer/hooks/useProviders': `export const useProviders = () => ({ providers: [${JSON.stringify(provider)}] });`,
    'src/renderer/hooks/useClaudeAccountUsage': 'export const useClaudeAccountUsage = () => null;',
  },
  cases: {
    default: { about: 'Rolling, weekly and monthly Go allowance render together', data: {} },
    stale: { about: 'Retained quota is labelled stale; the task chip hides old numbers', data: { stale: true } },
    unavailable: { about: 'Rejected credentials never display as a quota exhaustion', data: { error: true } },
    narrow: { about: 'The three Go quota windows remain legible at 320px', viewport: { width: 320, height: 740 }, data: {} },
  },
  async ready(page) {
    await page.getByTestId('provider-usage-module').waitFor();
    await page.waitForFunction(() => !document.body.textContent.includes('quotaCard.waiting'));
  },
  async check(page, ui) {
    const settings = page.getByTestId('provider-usage-module');
    if (ui.case === 'unavailable') {
      await settings.getByText(await ui.t('providerAccountUsage.error.auth'), { exact: true }).waitFor();
      assert.equal(await settings.getByRole('progressbar').count(), 0);
    } else {
      assert.equal(await settings.getByRole('progressbar').count(), 3);
      for (const [key, percent] of [
        ['providerAccountUsage.kimi.limit_5h', '70'],
        ['providerAccountUsage.kimi.limit_7d', '55'],
        ['providerAccountUsage.kimi.limit_month_total', '90'],
      ]) {
        await settings.getByText(await ui.t(key), { exact: true }).waitFor();
        await settings.getByText(await ui.t('quotaCard.remainingPercent', { percent }), { exact: true }).waitFor();
      }
      if (ui.case === 'stale') await settings.getByText(await ui.t('providerAccountUsage.kimi.stale'), { exact: true }).waitFor();
    }
    const chip = page.getByTestId('opencode-go-task-chip');
    if (['stale', 'unavailable'].includes(ui.case)) assert.ok(!(await chip.textContent()).includes('55%'));
    else assert.ok((await chip.textContent()).includes('55%'));
    assert.equal(await settings.getByText(/DeepSeek/).count(), 0);
  },
};
