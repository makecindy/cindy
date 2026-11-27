import assert from 'node:assert/strict';
import base from '../provider-share-sources/ui-page.mjs';

/** Design check: choose which of your computers runs a provider (hidden with one computer). */
export default {
  name: 'provider-run-location',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 720 },
  real: 'ProvidersSection detail, ProviderRunLocationRow, shared Select, translations and themes',
  notCovered: 'Persisting the choice, routing new tasks, live device catalogs; computers and accounts are fixture data',
  stubs: {
    ...base.stubs,
    'src/renderer/hooks/useProviders': 'import { useSyncExternalStore } from "react"; const sub = f => { window.addEventListener("repro-provider-change", f); return () => window.removeEventListener("repro-provider-change", f); }; export const useProviders = () => useSyncExternalStore(sub, () => window.providerSourcesFixture.snapshot);',
    'src/renderer/hooks/useCodexAuth': 'export const useCodexAuth = () => (!window.providerSourcesFixture.snapshot.providers[0].connected ? { state: { kind: "unauthenticated" }, recoveryCheck: "idle" } : { state: { kind: "authenticated", identity: "chris@example.com", authSource: "oauth" }, recoveryCheck: "idle" }); export const isChatGptConnectionConnected = () => window.providerSourcesFixture.snapshot.providers[0].connected;',
  },
  cases: {
    'empty-pool': { about: 'Sign in from the built-in OpenAI detail with no saved account' },
    'recovery-leave': { about: 'Leave provider detail during pending login, return and retry' },
    'recovery-success': { about: 'Use production login controls through simulated host success; no real credentials' },
    'recovery-failure': { about: 'Use production login controls through simulated host failure; no real credentials' },
    'recovery-cancel': { about: 'Use production login controls through simulated host cancel; no real credentials' },
    'recovery-pinned': { about: 'Use production login controls through simulated host pinned; no real credentials' },

    default: { about: 'This computer is signed in; Automatic keeps tasks here' },
    borrowing: { about: 'This computer is not signed in; the local sign-in stays visible and nothing moves to MBP-M5 on its own' },
    pinned: { about: 'Signed in here, but the user chose to run this provider on MBP-M5' },
    'never-signed-in': { about: 'Anthropic was never signed in here; it is still listed, stays on this computer, and MBP-M5 is offered as a choice' },
    'single-computer': { about: 'No other computer offers the provider: the row is hidden' },
    'local-management': { about: 'Five saved local accounts retain management and inline recovery while using remote models' },
  },
  async ready(page) {
    await page.getByRole('heading').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'empty-pool') {
      const actions = page.getByTestId('provider-detail-actions');
      await actions.getByRole('button', { name: await ui.t('subscriptionAccounts.login'), exact: true }).click();
      const connected = actions.getByRole('button', { name: await ui.t('settings.providers.button.disconnect'), exact: true });
      await connected.or(page.getByText(await ui.t('subscriptionAccounts.failed'), { exact: true })).first().waitFor();
      await ui.capture('after-sign-in');
      assert.ok(await connected.isVisible(), 'Signing in to an empty pool should connect the new account');
      return;
    }
    const row = page.getByTestId('provider-run-location');
    if (ui.case === 'recovery-pinned') {
      await row.waitFor();
      await ui.capture('01-connected-but-pinned-actions');
      await page.getByTestId('provider-detail-actions').getByRole('button', { name: await ui.t('settings.providers.button.disconnect'), exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      assert.match(await dialog.textContent() ?? '', new RegExp(await ui.t('settings.connections.codex.logoutConfirm.title')));
      await ui.capture('02-disconnect-confirmation-cancelled');
      await dialog.getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true }).click();
      assert.equal(await page.evaluate(() => window.providerSourcesFixture.subscriptionControl.commands.filter(c => c.action !== 'read').length), 0);
      return;
    }
    if (ui.case.startsWith('recovery-')) {
      const accounts = page.getByTestId('subscription-accounts');
      await accounts.getByText('alex@example.com', { exact: true }).waitFor();
      await ui.capture('01-local-connected');
      // Change only the simulated host snapshot, not rendered DOM or production logic.
      await page.evaluate(() => {
        const f = window.providerSourcesFixture;
        f.snapshot = { ...f.snapshot, providers: f.snapshot.providers.map(p => p.id === 'openai' ? { ...p, connected: false } : p) };
        window.dispatchEvent(new Event('repro-provider-change'));
        window.__uiPage.emit('subscriptionAccountsChanged', { providerId: 'openai' });
      });
      // 2026-11-18: a disconnect never moves new tasks to another computer on its own.
      assert.doesNotMatch(await row.textContent() ?? '', /MBP-M5/);
      assert.equal(await page.getByTestId('provider-detail-actions').getByRole('button').count(), 1);
      // The simulated host retains the same saved account throughout recovery.
      const saved = await page.evaluate(() => window.electronAPI.subscriptionAccounts.command({ action: 'read', providerId: 'openai' }));
      assert.deepEqual(saved.accounts.map(a => a.id), ['default']);
      await ui.capture('02-local-disconnected-stays-here');
      await row.getByRole('combobox').click();
      const local = page.getByRole('option', { name: new RegExp(await ui.t('settings.providers.detail.runLocation.optionLocal')) });
      // Choosing this computer means "do not use another computer", so it stays selectable.
      assert.notEqual(await local.getAttribute('aria-disabled'), 'true');
      await ui.capture('03-local-selectable');
      await page.keyboard.press('Escape');
      const actions = page.getByTestId('provider-detail-actions');
      await actions.getByRole('button', { name: await ui.t('subscriptionAccounts.login'), exact: true }).waitFor();
      await ui.capture('04-local-reconnect-visible');
      const signIn = actions.getByRole('button', { name: await ui.t('subscriptionAccounts.login'), exact: true });
      await signIn.click();
      await page.waitForFunction(() => window.providerSourcesFixture.subscriptionControl.pending);
      const commands = await page.evaluate(() => window.providerSourcesFixture.subscriptionControl.commands);
      assert.ok(commands.some(c => c.action === 'login' && c.accountId === 'default'));
      assert.equal(commands.some(c => ['add', 'connect', 'create'].includes(c.action)), false);
      const cancel = actions.getByRole('button', { name: await ui.t('settings.providers.button.cancel'), exact: true });
      await cancel.waitFor();
      await actions.getByText(await ui.t('settings.providers.pill.connecting'), { exact: true }).waitFor();
      await ui.capture('06-pending-progress-and-cancel');
      if (ui.case === 'recovery-cancel' || ui.case === 'recovery-leave') {
        if (ui.case === 'recovery-leave') {
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: /^Anthropic/ }).first().click();
        } else await cancel.click();
        await page.waitForFunction(() => !window.providerSourcesFixture.subscriptionControl.pending);
        assert.ok(await page.evaluate(() => window.providerSourcesFixture.subscriptionControl.commands.some(c => c.action === 'cancel')));
      } else {
        await page.keyboard.press('Escape');
        await page.evaluate(ok => window.providerSourcesFixture.subscriptionControl.finish(ok), ui.case === 'recovery-success');
        await page.waitForFunction(() => !window.providerSourcesFixture.subscriptionControl.pending);
      }
      if (ui.case === 'recovery-leave') {
        await page.getByRole('button', { name: /^OpenAI/ }).first().click();
      }
      if (ui.case === 'recovery-failure') await page.getByText(await ui.t('subscriptionAccounts.failed'), { exact: true }).waitFor();
      else assert.equal(await page.getByText(await ui.t('subscriptionAccounts.failed'), { exact: true }).count(), 0);
      if (ui.case !== 'recovery-success') {
        await ui.capture('07-after-cancel-or-failure');
        await signIn.click();
        await page.waitForFunction(() => window.providerSourcesFixture.subscriptionControl.pending);
        await page.evaluate(() => window.providerSourcesFixture.subscriptionControl.finish(true));
      }
      await accounts.getByText('alex@example.com', { exact: true }).waitFor();
      assert.doesNotMatch(await row.textContent() ?? '', /MBP-M5/);
      const recovered = await page.evaluate(() => window.electronAPI.subscriptionAccounts.command({ action: 'read', providerId: 'openai' }));
      assert.deepEqual(recovered.accounts.map(a => a.id), ['default']);
      await ui.capture('08-recovered-original-account-local');
      return;
    }
    if (ui.case === 'never-signed-in') {
      // Review #9740: a built-in provider only another computer offers must not vanish from the list.
      await page.getByRole('button', { name: /^Anthropic/ }).first().click();
      await row.waitFor();
      // Still listed, but new tasks stay here until the user chooses MBP-M5 (2026-11-18).
      assert.doesNotMatch(await row.textContent() ?? '', /MBP-M5/);
      await row.getByRole('combobox').click();
      await page.getByRole('option', { name: 'MBP-M5' }).waitFor();
      await ui.capture('row');
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case === 'single-computer') {
      assert.equal(await row.count(), 0);
      return;
    }
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    await ui.capture('row');
    if (ui.case === 'local-management') {
      const accounts = page.getByTestId('subscription-accounts');
      await accounts.getByText('account1@example.com', { exact: true }).waitFor();
      await accounts.getByText(await ui.t('settings.providers.detail.runLocation.optionLocal'), { exact: true }).waitFor();
      assert.equal(await accounts.getByTestId('subscription-account').count(), 5);
      await accounts.getByRole('button', { name: await ui.t('subscriptionAccounts.add'), exact: true }).waitFor();
      await accounts.getByTestId('subscription-account').first().getByRole('button', {
        name: await ui.t('subscriptionAccounts.loginAccountAria', { name: 'account1@example.com' }), exact: true,
      }).waitFor();
      await accounts.getByTestId('subscription-account').nth(1).getByRole('button', { name: await ui.t('commonUi.retry'), exact: true }).click();
      const commands = await page.evaluate(() => window.providerSourcesFixture.subscriptionControl.commands);
      assert.ok(commands.length > 1);
      assert.ok(commands.every(command => command.action === 'read'));
      assert.match(await row.textContent() ?? '', /MBP-M5/);
      await ui.capture('local-account-management');
      return;
    }
    if (ui.case === 'borrowing') {
      await page.getByTestId('provider-detail-actions').getByRole('button', { name: await ui.t('settings.providers.openai.connect'), exact: true }).waitFor();
      await ui.capture('local-login-visible');
      return;
    }
    if (ui.case !== 'default') return;
    await row.getByRole('combobox').click();
    await page.getByRole('option', { name: 'MBP-M5' }).waitFor();
    await ui.capture('menu');
    await page.keyboard.press('Escape');
  },
};
