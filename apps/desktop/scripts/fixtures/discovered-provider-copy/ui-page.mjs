import assert from 'node:assert/strict';

export default {
  name: 'discovered-provider-copy',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 640 },
  real: 'ModelSelector rail and rows, listedSourceFolds, unavailable-source row copy and themes',
  notCovered: 'ChatInput and draft routing, live device catalogs, sending and the actual move to another computer',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ mode: "local", dataOwnerId: "fixture-owner", user: null }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => "fixture-self"; export const useOptionalDataOwnerGeneration = () => 1;',
    'src/renderer/hooks/useProviders': 'export const useProviders = () => window.listingFixture.snapshot;',
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useControllableDevices = () => window.listingFixture.devices;' },
    'src/renderer/hooks/useDevicesProviders': 'export const useDevicesProviders = ids => new Map(ids.flatMap(id => window.listingFixture.catalogs.has(id) ? [[id, window.listingFixture.catalogs.get(id)]] : []));',
    'src/renderer/hooks/useDeviceProviders': { partial: 'export const useDeviceProviders = id => id && window.listingFixture.catalogs.has(id) ? { ...window.listingFixture.catalogs.get(id), unsupported: false } : { providers: [], loading: false, error: null, unsupported: false };' },
    'src/renderer/hooks/useAgentCapabilities': { partial: 'const state = { capabilities: { hasFastMode: false, availableModels: [], effortLevels: [{ id: "high", displayName: "High" }], permissionModes: [] }, loading: false, error: null }; export const useAgentCapabilities = () => state;' },
  },
  cases: {
    default: { about: 'New task: signed-out Anthropic offers the ROG copy with the reason shown before choosing' },
    'running-task': { about: 'Running task: choosing ROG stages the route directly after showing the reason in the row' },
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
    await open();
    assert.ok(await page.locator('[data-rail-item="remote:rog:anthropic"]').isVisible(), 'ROG\'s copy is listed while this computer\'s is unusable');
    await ui.capture('01-picker-lists-other-copy');
    await page.locator('[data-rail-item="remote:rog:anthropic"]').click();
    const row = page.getByRole('option').filter({ hasText: 'Fable 5.2' }).first();
    await row.getByText(await ui.t('newChat.modelSelector.discoveredCopy.unavailableHere', { provider: 'Anthropic' })).waitFor();
    assert.equal(await route(), 'local:anthropic', 'Browsing does not choose a computer');
    await ui.capture('02-reason-before-selection');
    await row.getByText('Fable 5.2', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-composer]')?.getAttribute('data-route') === 'rog:anthropic');
    assert.equal(await dialog.count(), 0, 'Choosing the row applies the route directly');
    await ui.capture('03-selected-rog');
    if (ui.case !== 'default') return;

    await open();
    await page.locator('[data-rail-item="remote:share:pat:anthropic"]').click();
    const shareRow = page.getByRole('option').filter({ hasText: 'Fable 5.2' }).first();
    await shareRow.getByText('Fable 5.2', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-composer]')?.getAttribute('data-route') === 'share:pat:anthropic');
    assert.equal(await dialog.count(), 0, 'Choosing an existing share also applies directly');
    await ui.capture('04-selected-share');
  },
};
