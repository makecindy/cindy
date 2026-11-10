import assert from 'node:assert/strict';
export default {
  name: 'subscription-accounts',
  entry: './fixture.tsx',
  viewport: { width: 680, height: 850 },
  real: 'SubscriptionAccountsSection, QuotaHoverCard shared columns, production controls, translations, themes and per-account actions',
  notCovered:
    'Real browser sign-in, credentials, native CLI processes or transport; fixture supplies account metadata only',
  cases: {
    default: { about: 'Three Claude accounts: provider card on the default row, a low weekly quota, a paused limited account' },
    narrow: { about: '320-pixel content width without clipped account controls' },
    'narrow-weight': { about: '320-pixel content width with task limit, weight, assignment and account menu controls' },
    codex: { about: 'Codex accounts and weight strategy' },
    error: { about: 'Unavailable status read and inline retry on focus' },
  },
  async check(page, ui) {
    await page.getByTestId('subscription-accounts').waitFor();
    assert.equal(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (ui.case === 'error') {
      await page.getByRole('alert').waitFor();
      return;
    }
    assert.equal(await page.getByRole('switch').count(), 3);
    assert.equal(await page.getByRole('radiogroup', { name: await ui.t('subscriptionAccounts.strategy'), exact: true }).getAttribute('data-setting-id'), 'providers.subscriptionAccounts');
    // Every account's bars share one column, whatever each account's own labels and numbers are.
    const bars = await page.getByRole('progressbar').evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect();
        return `${Math.round(box.left)}-${Math.round(box.right)}`;
      }),
    );
    assert.equal(bars.length, ui.case === 'codex' || ui.case === 'narrow-weight' ? 6 : 8);
    assert.deepEqual([...new Set(bars)], [bars[0]]);
    await page.getByRole('button', { name: await ui.t('providerGroup.member.moreAria', { name: 'alex@example.com' }) }).click();
    await page.getByRole('menuitem', { name: await ui.t('subscriptionAccounts.openDirectory') }).waitFor();
    await ui.capture('menu');
    await page.keyboard.press('Escape');
    await page.getByRole('switch').first().click();
    await page.getByRole('switch').first().waitFor();
    assert.equal(await page.getByRole('switch').first().getAttribute('aria-checked'), 'false');
    await ui.capture('paused');
  },
};
