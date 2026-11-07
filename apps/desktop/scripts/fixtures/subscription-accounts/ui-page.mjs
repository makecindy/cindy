import assert from 'node:assert/strict';
export default {
  name: 'subscription-accounts',
  entry: './fixture.tsx',
  viewport: { width: 680, height: 850 },
  real: 'SubscriptionAccountsSection, production controls, translations, themes and per-account actions',
  notCovered:
    'Real browser sign-in, credentials, native CLI processes or transport; fixture supplies account metadata only',
  cases: {
    default: { about: 'Three Claude accounts with quota, pause and long identity' },
    narrow: { about: '320-pixel content width without clipped account controls' },
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
    assert.equal(await page.getByRole('combobox').first().getAttribute('data-setting-id'), 'providers.subscriptionAccounts');
    assert.equal(await page.getByRole('progressbar').count(), 3);
    await page.getByRole('switch').first().click();
    await page.getByRole('switch').first().waitFor();
    assert.equal(await page.getByRole('switch').first().getAttribute('aria-checked'), 'false');
    await ui.capture('paused');
  },
};
