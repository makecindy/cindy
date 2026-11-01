import assert from 'node:assert/strict';

export default {
  name: 'provider-share-sources',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 720 },
  real: 'ProvidersSection rail, real AddProviderWizard and Radix exit/reopen lifecycle, outgoing-share classification, remote group rows, translations and themes',
  notCovered: 'Live accounts, actual local runtime connection, device catalogs, sharing authorization and provider detail usage',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ mode: "local", dataOwnerId: "fixture-owner", user: null }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => "fixture-self"; export const useOptionalDataOwnerGeneration = () => 1;',
    'src/renderer/hooks/useProviders': 'export const useProviders = () => window.providerSourcesFixture.snapshot;',
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useControllableDevices = () => window.providerSourcesFixture.devices;' },
    'src/renderer/hooks/useDevicesProviders': 'export const useDevicesProviders = () => window.providerSourcesFixture.catalogs;',
    'src/renderer/hooks/useCodexAuth': 'export const useCodexAuth = () => ({ state: { kind: "unauthenticated" }, recoveryCheck: "idle" }); export const isChatGptConnectionConnected = () => false;',
    'src/renderer/hooks/useApiKey': 'export const useApiKey = () => ({ key: "", hasSavedKey: false });',
    'src/renderer/hooks/useModelAccessStatus': 'export const useModelAccessStatus = () => ({ state: "failed" });',
    'src/renderer/components/settings/useProviderSubscriptionCard': 'export const useProviderSubscriptionCard = () => null; export const useDeviceProviderSubscriptionCard = () => null;',
    'src/renderer/components/settings/ProviderAccountUsageModule': 'export const ProviderAccountUsageModule = () => null;',
    'src/renderer/features/provider-share/providerShareStore': { partial: 'export const useProviderShareReceived = () => window.providerSourcesFixture.received;' },
  },
  cases: {
    default: { about: 'Local and remote outgoing shares appear together, separately from ordinary providers' },
    'shared-sources': { about: 'Local and remote outgoing shares appear together, separately from ordinary providers' },
    'no-outgoing-shares': { about: 'The outgoing section disappears without established shares' },
    'wizard-reopen': { about: 'Complete the real wizard, reopen during a deferred refresh, and keep the new dialog interactive after the old refresh settles' },
  },
  async ready(page) {
    await page.getByTestId('provider-share-received').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'wizard-reopen') {
      const add = page.getByRole('button', { name: await ui.t('settings.providers.addProvider'), exact: true });
      const dialog = page.getByRole('dialog');
      await add.click();
      await dialog.waitFor();
      await dialog.getByRole('button', { name: /^Ollama/ }).click();
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
