import assert from 'node:assert/strict';
export default {
  name: 'subscription-accounts',
  entry: './fixture.tsx',
  viewport: { width: 680, height: 850 },
  real: 'SubscriptionAccountsSection, QuotaHoverCard shared columns, production controls, translations, themes and per-account actions',
  notCovered:
    'Real browser sign-in, credentials, native CLI processes or transport; fixture supplies account metadata only',
  cases: {
    expiry: { about: 'Login expiry and the selected-account renewal action, before interaction' },
    'expiry-narrow': { about: 'Login expiry and renewal at 320-pixel content width, before interaction' },
    'identity-unknown': { about: 'A stale account row explains how to reconnect when the executor cannot confirm the original identity' },
    default: { about: 'Three Claude accounts: independent 18-day, 3-day and unknown login expiry, per-account renewal and aligned usage' },
    'expiry-past': { about: 'A past CLI estimate warns but does not mark the account signed out' },
    narrow: { about: '320-pixel content width without clipped account controls' },
    'narrow-weight': { about: '320-pixel content width with task limit, weight, assignment and account menu controls' },
    codex: { about: 'Codex accounts and weight strategy' },
    'codex-no-usage': { about: 'A signed-in second Codex account retains reset controls without usage data' },
    'codex-no-usage-narrow': { about: 'Second-account reset controls without usage data at 320-pixel content width' },
    error: { about: 'Unavailable status read and inline retry on focus' },
    'provider-auth': { about: 'Codex provider-managed authentication explains the independent-account recovery action' },
    'provider-auth-preview': { about: 'Provider-managed authentication offers a separate account directory at 320px', viewport: { width: 320, height: 600 } },
    empty: { about: 'Nothing signed in: no placeholder account, strategy or count, only Add account' },
  },
  async check(page, ui) {
    if (ui.case === 'provider-auth-preview') {
      await page.getByText(await ui.t('subscriptionAccounts.providerManagedAuth'), { exact: true }).waitFor();
      await page.getByRole('button', { name: await ui.t('subscriptionAccounts.signIn.anotherAccount'), exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('subscriptionAccounts.signIn.useCodex'), exact: true }).count(), 0);
      assert.equal(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await ui.capture('provider-auth-preview');
      return;
    }
    await page.getByTestId('subscription-accounts').waitFor();
    assert.equal(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (ui.case === 'identity-unknown') {
      await page.getByTestId('subscription-account').nth(1).getByRole('button', {
        name: await ui.t('subscriptionAccounts.loginAccountAria', { name: 'long.work.account@research.example.com' }), exact: true,
      }).click();
      await page.getByText(await ui.t('subscriptionAccounts.loginIdentityUnknown'), { exact: true }).waitFor();
      await ui.capture('identity-unknown');
      return;
    }
    if (ui.case === 'provider-auth') {
      await page.getByRole('button', { name: await ui.t('subscriptionAccounts.add'), exact: true }).click();
      await page.getByText(await ui.t('subscriptionAccounts.providerManagedAuth'), { exact: true }).waitFor();
      await ui.capture('provider-auth');
      return;
    }
    if (ui.case === 'error') {
      await page.getByRole('alert').waitFor();
      return;
    }
    if (ui.case === 'empty') {
      await page.getByRole('button', { name: await ui.t('subscriptionAccounts.add'), exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.animate-spinner'));
      assert.equal(await page.getByTestId('subscription-account').count(), 0);
      assert.equal(await page.getByRole('radiogroup').count(), 0);
      assert.equal(await page.getByRole('switch').count(), 0);
      return;
    }
    const codex = ui.case.startsWith('codex') || ui.case === 'narrow-weight';
    if (codex) {
      const rows = page.getByTestId('subscription-account');
      for (let index = 0; index < 3; index++) {
        await rows.nth(index).getByRole('switch', { name: await ui.t('codexResets.autoUse.label'), exact: true }).waitFor();
        assert.equal(await rows.nth(index).getByRole('switch', { name: await ui.t('codexResets.autoUse.label'), exact: true }).getAttribute('aria-checked'), String(index === 0));
      }
      await ui.capture('account-resets');
    }
    assert.equal(await page.getByRole('switch').count(), codex ? 6 : 3);
    assert.equal(await page.getByRole('radiogroup', { name: await ui.t('subscriptionAccounts.strategy'), exact: true }).getAttribute('data-setting-id'), 'providers.subscriptionAccounts');
    // Every account's bars share one column, whatever each account's own labels and numbers are.
    const bars = await page.getByRole('progressbar').evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect();
        return `${Math.round(box.left)}-${Math.round(box.right)}`;
      }),
    );
    assert.equal(bars.length, ui.case.startsWith('codex-no-usage') ? 4 : codex ? 6 : 8);
    assert.deepEqual([...new Set(bars)], [bars[0]]);
    if (['default', 'narrow', 'expiry-past', 'expiry', 'expiry-narrow'].includes(ui.case)) {
      const rows = page.getByTestId('subscription-account');
      await rows.nth(0).getByText(await ui.t('subscriptionAccounts.loginExpiresInDays', { days: 18 }), { exact: true }).waitFor();
      await rows.nth(1).getByText(await ui.t(ui.case === 'expiry-past'
        ? 'subscriptionAccounts.loginMayHaveExpired' : 'subscriptionAccounts.loginExpiresInDays', { days: 3 }), { exact: true }).waitFor();
      await rows.nth(2).getByText(await ui.t('subscriptionAccounts.loginExpiryUnknown'), { exact: true }).waitFor();
      await ui.capture('expiry');
      if (ui.case === 'expiry' || ui.case === 'expiry-narrow') return;
      await rows.nth(1).getByRole('button', { name: await ui.t('subscriptionAccounts.loginAccountAria', { name: 'long.work.account@research.example.com' }), exact: true }).click();
      await rows.nth(1).getByText(await ui.t('subscriptionAccounts.loginExpiresInDays', { days: 30 }), { exact: true }).waitFor();
      await rows.nth(0).getByText(await ui.t('subscriptionAccounts.loginExpiresInDays', { days: 18 }), { exact: true }).waitFor();
      await ui.capture('renewed');
    }
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
