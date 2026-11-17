import assert from 'node:assert/strict';

// This computer's provider is unusable and another own computer has the same one: the picker lists
// that copy and asks before using it; cancel changes nothing (2026-11-18 user decision). A share of the
// same provider and a provider only that computer has are used directly, without asking.
export default {
  name: 'discovered-provider-copy',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 640 },
  real: 'ModelSelector rail and rows, listedSourceFolds askBeforeUse, ConfirmDialog, relocation copy helpers, translations and themes',
  notCovered: 'ChatInput and draft wiring (same helpers, covered by vitest), live device catalogs, sending and the actual move to another computer',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ mode: "local", dataOwnerId: "fixture-owner", user: null }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => "fixture-self"; export const useOptionalDataOwnerGeneration = () => 1;',
    'src/renderer/hooks/useProviders': 'export const useProviders = () => window.listingFixture.snapshot;',
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useControllableDevices = () => window.listingFixture.devices;' },
    'src/renderer/hooks/useDevicesProviders': 'export const useDevicesProviders = ids => new Map(ids.flatMap(id => window.listingFixture.catalogs.has(id) ? [[id, window.listingFixture.catalogs.get(id)]] : []));',
    'src/renderer/hooks/useDeviceProviders': { partial: 'export const useDeviceProviders = id => id && window.listingFixture.catalogs.has(id) ? { ...window.listingFixture.catalogs.get(id), unsupported: false } : { providers: [], loading: false, error: null, unsupported: false };' },
    'src/renderer/hooks/useAgentCapabilities': { partial: 'const state = { capabilities: { hasFastMode: false, availableModels: [], effortLevels: [{ id: "high", displayName: "High" }], permissionModes: [] }, loading: false, error: null }; export const useAgentCapabilities = () => state;' },
  },
  cases: {
    default: { about: 'New task: choosing ROG\'s copy of the signed-out Anthropic asks first; cancel keeps this computer, confirm moves; a share is used without asking' },
    'running-task': { about: 'Running task: one relocation dialog that says why, with no "don\'t remind me"; cancel keeps the task where it is' },
  },
  async ready(page) {
    await page.locator('[data-composer] button').first().waitFor();
  },
  async check(page, ui) {
    const composer = page.locator('[data-composer]');
    const route = () => composer.getAttribute('data-route');
    const dialog = page.getByRole('alertdialog');
    const open = async () => {
      await composer.locator('button').first().click();
      await page.getByRole('listbox').waitFor();
    };
    const pick = async (rail) => {
      await page.locator(`[data-rail-item="${rail}"]`).click();
      await page.getByRole('listbox').getByText('Fable 5.2', { exact: true }).first().click();
    };
    const draft = ui.case === 'default';
    const cancel = draft ? 'newChat.modelSelector.discoveredCopy.cancel' : 'newChat.chatInput.agentRelocation.cancel';
    const confirm = draft ? 'newChat.modelSelector.discoveredCopy.confirm' : 'newChat.chatInput.agentRelocation.confirm';

    await open();
    assert.ok(await page.locator('[data-rail-item="remote:rog:anthropic"]').isVisible(), 'ROG\'s copy is listed while this computer\'s is unusable');
    await ui.capture('01-picker-lists-other-copy');
    await page.locator('[data-rail-item="remote:rog:anthropic"]').click();
    await page.getByRole('listbox').getByText('Fable 5.2', { exact: true }).first().waitFor();
    await ui.capture('01b-browsing-other-copy');
    await page.getByRole('listbox').getByText('Fable 5.2', { exact: true }).first().click();
    await dialog.waitFor();
    assert.ok((await dialog.textContent()).includes(await ui.t('newChat.modelSelector.discoveredCopy.unavailableHere', { provider: 'Anthropic' })));
    assert.equal(await dialog.getByRole('checkbox').count(), 0, 'No "don\'t remind me" for this question');
    await ui.capture('02-asks-before-using');
    await dialog.getByRole('button', { name: await ui.t(cancel), exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await route(), 'local:anthropic', 'Cancel changes nothing');
    await ui.capture('03-cancel-keeps-this-computer');
    // Cancelling also closes the picker; choose again.
    await open();
    await pick('remote:rog:anthropic');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: await ui.t(confirm), exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await route(), 'rog:anthropic');
    await ui.capture('04-confirmed-runs-on-rog');
    // Reopened, the picker shows the chosen copy on ROG as the one in use.
    await open();
    await ui.capture('04b-reopened-shows-rog');
    if (!draft) return;
    // Already-added sources: no question.
    await pick('remote:share:pat:anthropic');
    await page.waitForTimeout(150);
    assert.equal(await dialog.count(), 0, 'A share is used without asking');
    assert.equal(await route(), 'share:pat:anthropic');
    await ui.capture('05-share-used-directly');
  },
};
