import assert from 'node:assert/strict';

export default {
  name: 'provider-share-sources',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 720 },
  real: 'ProvidersSection rail, real AddProviderWizard and Radix exit/reopen lifecycle, outgoing-share classification, remote group rows, translations and themes',
  notCovered: 'Live accounts, actual local runtime connection, device catalogs, sharing authorization and live provider-level usage readers',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ mode: "local", dataOwnerId: "fixture-owner", user: null }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => "fixture-self"; export const useOptionalDataOwnerGeneration = () => 1;',
    'src/renderer/hooks/useProviders': 'export const useProviders = () => window.providerSourcesFixture.snapshot;',
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useControllableDevices = () => window.providerSourcesFixture.devices;' },
    'src/renderer/hooks/useDevicesProviders': 'export const useDevicesProviders = () => window.providerSourcesFixture.catalogs;',
    'src/renderer/hooks/useCodexAuth': 'export const useCodexAuth = () => ({ state: { kind: "unauthenticated" }, recoveryCheck: "idle" }); export const isChatGptConnectionConnected = () => false;',
    'src/renderer/hooks/useApiKey': 'export const useApiKey = () => ({ key: "", hasSavedKey: false });',
    'src/renderer/hooks/useModelAccessStatus': 'export const useModelAccessStatus = () => ({ state: "failed" });',
    'src/renderer/components/settings/useProviderSubscriptionCard': 'export const useProviderSubscriptionCard = () => null; export const useDeviceProviderSubscriptionCard = () => null; export const useLiveQuotaForeground = () => true;',
    'src/renderer/components/settings/ProviderAccountUsageModule': 'export const ProviderAccountUsageModule = () => null;',
    'src/renderer/features/provider-share/providerShareStore': { partial: 'export const useProviderShareReceived = () => window.providerSourcesFixture.received;' },
  },
  cases: {
    'legacy-upgrade': { about: 'Old connection IDs remain in the host snapshot, while the actual settings rail shows one OpenAI supplier and both migrated accounts' },
    'legacy-upgrade-shared': { about: 'A migrated connection with an existing share keeps its selective revocation entry even when disconnected and paused, without duplicating unshared connections' },
    'subscription-claude-choice': { about: 'An existing Claude Code login is shown before choosing it or another account' },
    'subscription-codex-choice': { about: 'An existing Codex login is shown before choosing it or another account' },
    'subscription-claude-added': { about: 'An already added Claude Code login leaves only the new sign-in action' },
    'subscription-codex-added': { about: 'An already added Codex login leaves only the new sign-in action' },
    'subscription-codex-long': { about: 'The CLI shortcut keeps its action readable while truncating a long identity',
      data: { identity: 'a-very-long-subscription-account-identity-for-the-shortcut@example.com' } },
    'subscription-login': { about: 'OpenAI browser login adds an account inside the existing provider' },
    'subscription-cancel': { about: 'Closing OpenAI login cancels its owned CLI operation without creating another provider' },
    'subscription-pool': { about: 'The real local provider detail shows both subscription accounts, each with all of its own usage windows, under one provider header' },
    default: { about: 'Local and remote outgoing shares appear together, separately from ordinary providers' },
    'shared-sources': { about: 'Local and remote outgoing shares appear together, separately from ordinary providers' },
    'no-outgoing-shares': { about: 'The outgoing section disappears without established shares' },
    'wizard-reopen': { about: 'Complete the real wizard, reopen during a deferred refresh, and keep the new dialog interactive after the old refresh settles' },
    'builtin-save-guard': { about: 'Search a builtin API-key entry from a custom draft, save with deferred IPC, and block Escape until completion' },
  },
  async ready(page) {
    await page.getByTestId('provider-share-received').waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('legacy-upgrade')) {
      await page.getByRole('button', { name: /^OpenAI/ }).first().click();
      const accounts = page.getByTestId('subscription-accounts');
      await accounts.getByText('alex@example.com', { exact: true }).waitFor();
      await accounts.getByText('work@example.com', { exact: true }).waitFor();
      const shared = ui.case === 'legacy-upgrade-shared';
      assert.equal(await page.getByText('Old login one', { exact: true }).count(), shared ? 1 : 0);
      assert.equal(await page.getByText('Old login two', { exact: true }).count(), 0);
      await ui.capture('upgraded-accounts');
      if (shared) {
        const owned = page.getByTestId('provider-share-owned');
        await owned.getByText('Old login one', { exact: true }).click();
        await page.getByTestId('provider-share-entry').waitFor();
        await ui.capture('legacy-share-controls');
      }
      return;
    }
    if (/^subscription-(claude|codex)-(choice|added|long)$/.test(ui.case)) {
      await page.getByRole('button', { name: await ui.t('settings.providers.addProvider'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      const brand = ui.case.startsWith('subscription-claude-') ? /^Anthropic/ : /^OpenAI/;
      await dialog.getByRole('button', { name: brand }).first().click();
      // The shortcut names the CLI and carries the detected identity (2026-11-14).
      const cli = ui.case.startsWith('subscription-claude-') ? 'Claude Code' : 'Codex';
      await dialog.getByRole('button', { name: await ui.t('subscriptionAccounts.signIn.anotherAccount'), exact: true }).waitFor();
      const shortcut = dialog.getByRole('button', { name: await ui.t('subscriptionAccounts.signIn.useAccount', { cli }) });
      if (ui.case.endsWith('-added')) {
        assert.equal(await shortcut.count(), 0);
        assert.equal(await dialog.getByText('alex@example.com', { exact: true }).count(), 0);
      } else {
        await dialog.getByText(ui.data.identity ?? 'alex@example.com', { exact: true }).waitFor();
        await shortcut.waitFor();
      }
      assert.equal(await page.evaluate(() => window.providerSourcesFixture.subscriptionControl.commands.some(c => c.action === 'connect')), false);
      return;
    }
    if (ui.case === 'subscription-login' || ui.case === 'subscription-cancel') {
      await page.getByRole('button', { name: await ui.t('settings.providers.addProvider'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: /^OpenAI/ }).first().click();
      await dialog.getByRole('button', { name: await ui.t('subscriptionAccounts.signIn.anotherAccount'), exact: true }).click();
      await page.waitForFunction(() => window.providerSourcesFixture.subscriptionControl.commands.some(c => c.action === 'connect' && c.target === 'new'));
      if (ui.case === 'subscription-cancel') {
        await dialog.getByRole('button', { name: await ui.t('settings.providers.wizard.cancel'), exact: true }).last().click();
        await page.waitForFunction(() => window.providerSourcesFixture.subscriptionControl.commands.some(c => c.action === 'cancel'));
      } else {
        await page.getByTestId('subscription-accounts').getByText('alex@example.com', { exact: true }).waitFor();
      }
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.providerSourcesFixture.snapshot.providers.filter(p => p.id.startsWith('openai')).length), 1);
      assert.equal(await page.getByText(await ui.t('settings.providers.wizard.authorizeFailed', { name: 'OpenAI' }), { exact: true }).count(), 0);
      return;
    }
    if (ui.case === 'subscription-pool') {
      const accounts = page.getByTestId('subscription-accounts');
      await accounts.getByText('alex@example.com', { exact: true }).waitFor();
      assert.equal(await accounts.getByText('work@example.com', { exact: true }).count(), 1);
      assert.equal(await accounts.getByRole('switch').count(), 2);
      // Each account shows every window of its own quota once; no provider-level copy repeats one account.
      for (const identity of ['alex@example.com', 'work@example.com']) {
        const row = accounts.getByTestId('subscription-account').filter({ hasText: identity });
        for (const name of [await ui.t('quotaCard.fiveHourLabel'), await ui.t('quotaCard.weeklyLabel'), await ui.t('quotaCard.modelWeeklyLabel', { model: 'Fable' })])
          // High-usage bars append a screen-reader severity note to their accessible name.
          assert.equal(await row.getByRole('progressbar', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).count(), 1, `${identity}: ${name}`);
      }
      assert.equal(await page.getByRole('progressbar').count(), 6);
      return;
    }
    if (ui.case === 'builtin-save-guard') {
      await page.getByRole('button', { name: await ui.t('settings.providers.addProvider'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.customAction'), exact: true }).click();
      await page.getByRole('combobox').fill('Gemini');
      await page.getByRole('option').filter({ has: page.getByText('Gemini', { exact: true }) }).first().click();
      const subtitle = page.getByText(await ui.t('settings.providers.wizard.builtinApiKey.subtitle'), { exact: true });
      await subtitle.waitFor();
      const key = page.getByRole('dialog').locator('input[type="password"]');
      await key.fill('fixture-key');
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.finish'), exact: true }).click();
      await page.waitForFunction(() => window.providerSourcesFixture.keySaveControl.pending);
      await key.press('Escape');
      assert.equal(await subtitle.isVisible(), true, 'saving must keep the builtin wizard open');
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.providers.wizard.cancel'), exact: true }).isDisabled(), true);
      await ui.capture('builtin-save-pending');
      await page.evaluate(() => window.providerSourcesFixture.keySaveControl.release());
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).count(), 0, 'success must complete without restoring the draft');
      return;
    }
    if (ui.case === 'wizard-reopen') {
      const add = page.getByRole('button', { name: await ui.t('settings.providers.addProvider'), exact: true });
      const dialog = page.getByRole('dialog');
      await add.click();
      await dialog.waitFor();
      await dialog.getByTitle('Ollama', { exact: true }).click();
      await page.waitForFunction(() => window.providerSourcesFixture.refreshControl.pending);
      await dialog.waitFor({ state: 'hidden' });
      await add.click();
      await dialog.waitFor();
      await ui.capture('reopened-before-refresh');
      await page.evaluate(() => window.providerSourcesFixture.refreshControl.release());
      await dialog.getByRole('textbox').first().fill('DeepSeek');
      await dialog.getByRole('button', { name: /^DeepSeek/ }).first().waitFor();
      await ui.capture('reopened-after-refresh');
      await dialog.getByRole('button', { name: await ui.t('settings.providers.wizard.cancel'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await add.click();
      await dialog.waitFor();
      return;
    }
    const outgoing = page.getByTestId('provider-share-owned');
    if (ui.case === 'no-outgoing-shares') {
      assert.equal(await outgoing.count(), 0);
      return;
    }
    await outgoing.waitFor();
    assert.equal(await outgoing.getByText(await ui.t('providerShare.owned.title'), { exact: true }).count(), 1);
    assert.equal(await outgoing.locator('[data-sortable-id="openai"]').count(), 1);
    assert.equal(await outgoing.getByText('Team Anthropic', { exact: true }).count(), 1);
    assert.equal(await outgoing.getByText('Private OpenAI', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Team Anthropic', { exact: true }).count(), 1);
  },
};
