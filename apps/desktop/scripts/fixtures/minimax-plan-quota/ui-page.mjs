import assert from 'node:assert/strict';
import organizationQuota from '../organization-quota/ui-page.mjs';

const provider = {
  id: 'minimax-fixture', name: 'MiniMax', source: 'user', connected: true,
  auth: { method: 'apiKey' }, access: { kind: 'api' },
  routing: {
    'claude-code': { upstream: 'https://api.kimi.com/coding' },
    codex: { upstream: 'https://api.minimaxi.com/v1' },
  },
};

export default {
  name: 'minimax-plan-quota',
  entry: './minimax-plan-quota-fixture.tsx',
  viewport: { width: 560, height: 740 },
  real: 'MiniMax parser, ProviderAccountUsageModule, TodaySpendChip, useProviderAccountUsage, quota cards, translations and themes',
  notCovered: 'Live MiniMax credentials/API, remote or mobile queries, complete desktop runtime. Synthetic account only.',
  stubs: {
    ...organizationQuota.stubs,
    'src/renderer/hooks/useProviders': `export const useProviders = () => ({ providers: [${JSON.stringify(provider)}] });`,
    'src/renderer/hooks/useClaudeAccountUsage': 'export const useClaudeAccountUsage = () => null;',
  },
  cases: {
    default: { about: 'Mixed Kimi/MiniMax connection: show the Codex task plan, never the Kimi account', data: {} },
    stale: { about: 'Keep labelled previous quota but hide stale task summary', data: { stale: true } },
    boosted: { about: 'A 135% boosted weekly allowance is shown as a value, not a negative-used meter', data: { boosted: true } },
    unavailable: { about: 'Rejected credentials show a readable state and refresh action', data: { error: true } },
    narrow: { about: 'Quota cards and refresh controls at 320px', viewport: { width: 320, height: 740 }, data: {} },
  },
  async ready(page) {
    await page.getByTestId('provider-usage-module').waitFor();
  },
  async check(page, ui) {
    const settings = page.getByTestId('provider-usage-module');
    const refresh = settings.getByRole('button', { name: await ui.t('providerAccountUsage.kimi.refresh') });
    await refresh.waitFor();
    if (ui.case === 'unavailable') {
      await settings.getByText(await ui.t('providerAccountUsage.minimax.unavailable'), { exact: true }).waitFor();
      assert.equal(await settings.getByRole('progressbar').count(), 0);
    } else {
      const meters = ui.case === 'boosted' ? [['providerAccountUsage.kimi.limit_5h', '80']]
        : [['providerAccountUsage.kimi.limit_5h', '80'], ['providerAccountUsage.kimi.limit_7d', '55']];
      for (const [key, percent] of meters) {
        await settings.getByText(await ui.t(key), { exact: true }).waitFor();
      }
      assert.equal(await settings.getByRole('progressbar').count(), meters.length);
      for (const [index, [, percent]] of meters.entries()) {
        const bar = settings.getByRole('progressbar').nth(index);
        assert.equal(await bar.getAttribute('aria-valuenow'), percent);
        assert.equal(await bar.getAttribute('aria-valuetext'), await ui.t('quotaCard.remainingPercent', { percent }));
      }
      await settings.getByText(await ui.t('providerAccountUsage.minimax.windowsInfo'), { exact: true }).waitFor();
      if (ui.case === 'boosted') await settings.getByText(`${await ui.t('providerAccountUsage.kimi.limit_7d')} · ${await ui.t('quotaCard.remainingPercent', { percent: 135 })}`, { exact: true }).waitFor();
      if (ui.case === 'stale') await settings.getByText(await ui.t('providerAccountUsage.kimi.stale'), { exact: true }).waitFor();
    }
    const chip = page.getByTestId('minimax-task-chip');
    if (ui.case === 'unavailable') await chip.getByText(await ui.t('quotaCard.noWindows'), { exact: true }).waitFor();
    if (['stale', 'unavailable', 'boosted'].includes(ui.case)) assert.ok(!(await chip.textContent()).includes('55%'));
    else assert.ok((await chip.textContent()).includes('55%'));
    assert.equal(await settings.getByText(/DeepSeek|Kimi Code|OpenCode Go/).count(), 0);
  },
};
