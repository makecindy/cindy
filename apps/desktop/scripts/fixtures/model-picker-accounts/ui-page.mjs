export default {
  name: 'model-picker-accounts',
  entry: './fixture.tsx',
  viewport: { width: 560, height: 400 },
  real: 'Production ModelSelector popup and shared ModelSourceUsageProvider, ModelSourceDetails, UnifiedModelRail and ModelPoolQuotaSummary',
  notCovered:
    'Native login, real quotas, dispatch and mobile rendering; host account snapshots are fixtures',
  cases: {
    'quota-low': { about: 'Single account nearly exhausted' },
    'quota-exhausted': { about: 'Single account recovery countdown' },
    'quota-pool': { about: 'Pool exhausted; earliest usable account recovery' },
    'quota-partial': { about: 'Partially exhausted pool stays quiet' },
    'full-panel': { about: 'Full production ModelSelector popup with pooled accounts and red reset time' },
    'full-panel-warning': { about: 'Full production ModelSelector popup with pooled accounts and yellow reset time' },
    default: { about: 'Paused first account; unique eligible second account' },
    bound: { about: 'Existing task remains bound to the paused first account' },
    'session-bound': { about: 'Executing host resolves the native session to the second account, overriding the picker preview' },
    ambiguous: { about: 'Two accounts; average once in provider heading and separate details' },
    'reset-soon': { about: 'One account retains 80% with 12 hours until weekly reset; time is yellow' },
    'reset-urgent': { about: 'One account retains 80% with 5 hours until weekly reset; time is red' },
    unknown: { about: 'Unknown account prevents a misleading average but not a known reset reminder' },
  },
  async check(page, ui) {
    if (ui.case.startsWith('quota-')) {
      const summary = page.locator('[data-pool-quota-summary]');
      await summary.waitFor();
      if (ui.case === 'quota-partial') {
        if (await summary.locator('[data-quota-warning]').count()) throw new Error('Partial pool must not warn');
      } else await summary.locator('[data-quota-warning]').waitFor();
      await ui.capture('quota-summary');
      await summary.click();
      await page.getByRole('tooltip').filter({hasText:'second@example.test'}).waitFor();
      await ui.capture('quota-details');
      return;
    }
    if (ui.case.startsWith('full-panel')) {
      await page.locator('[data-full-picker-trigger] button').first().click();
      await page.locator('[data-morph-side][data-state="open"]').waitFor();
      await page.locator('[data-rail-item="provider:anthropic"]').click();
      await page.locator('[data-pool-quota-summary]').filter({hasText:'57%'}).waitFor();
      await page.locator('[data-pool-reset-soon]').waitFor();
      // Settle the production MorphPopover width animation before measuring or capturing.
      await page.waitForTimeout(350);
      const heading = page.locator('[data-group-provider="anthropic"]');
      const title = heading.locator(':scope > span').first();
      if (await title.evaluate(el => el.clientWidth < el.scrollWidth)) throw new Error('Provider heading is truncated by quota summary');
      await page.mouse.move(0, 0);
      await ui.capture('full-picker');
      await page.locator('[data-pool-quota-summary]').hover();
      await page.getByRole('tooltip').filter({hasText:'second@example.test'}).waitFor();
      await ui.capture('account-details');
      await page.mouse.move(0, 0);
      await page.getByRole('tooltip').waitFor({state:'hidden'});
      return;
    }
    const pool = ['ambiguous', 'reset-soon', 'reset-urgent', 'unknown'].includes(ui.case);
    const identity =
      ui.case === 'bound'
        ? 'first@example.test'
        : pool
          ? await ui.t('providerGroup.member.accountCount', { count: 2 })
          : 'second@example.test';
    await page.locator('[data-model-source-details]').filter({ hasText: pool ? 'Anthropic' : identity }).waitFor();
    await page.getByRole('button', { name: `Anthropic · ${identity}`, exact: true }).waitFor();
    if (!pool)
      await page.locator(`[data-weekly-remaining="${ui.case === 'bound' ? 34 : 80}"]`).waitFor();
    else {
      const label = ui.case === 'unknown' ? await ui.t('subscriptionAccounts.quotaUpdating') : '57%';
      await page.locator('[data-pool-quota-summary]').filter({hasText:label}).waitFor();
      if (ui.case !== 'unknown') await page.locator('[data-weekly-remaining="57"]').waitFor();
      if (ui.case === 'reset-soon' || ui.case === 'reset-urgent' || ui.case === 'unknown') await page.locator('[data-pool-reset-soon]').waitFor();
      if (ui.case !== 'ambiguous') await page.locator(`[data-pool-reset-time][class*="quota-bar-${ui.case === 'reset-urgent' ? 'crit' : 'warn'}"]`).waitFor();
      await ui.capture('overview');
      await page.locator('[data-pool-quota-summary]').click();
      await page.getByRole('tooltip').filter({hasText:'second@example.test'}).waitFor();
      await ui.capture('details');
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: `Anthropic · ${identity}`, exact: true }).hover();
    if (pool) {
      await page.getByRole('tooltip').filter({ hasText: 'first@example.test' }).waitFor();
      await page.getByRole('tooltip').filter({ hasText: 'second@example.test' }).waitFor();
    }
    await ui.capture('accounts');
  },
};
