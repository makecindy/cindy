import assert from 'node:assert/strict';

// Browser-tier regression for duplicate source rails when remotely viewing a task.
// The former performance/group fixtures do not cover equivalent account records.
// Minimal input: two target records with equal verified account keys and models,
// plus a distinct viewer catalog. Observe both the rail and selectable model rows.
// Only host catalog data is replaced. Production filtering and rail rendering stay real.
export default {
  name: 'model-selector-remote-repro', entry: './fixture.tsx', viewport: { width: 780, height: 650 },
  real: 'Production ModelSelector and its source-folding/rail rendering',
  notCovered: 'Live MBP screenshot identity, credentials, actual network or task failover',
  stubs: {
    'src/renderer/hooks/useAgentCapabilities': { partial: 'const state = { capabilities: { hasFastMode: false, availableModels: [{ id: "gpt-6-astra", displayName: "GPT-6-Astra" }], effortLevels: [{ id: "high", displayName: "High" }], permissionModes: [] }, loading: false, error: null }; export const useAgentCapabilities = () => state;' },
    'src/renderer/hooks/useProviders': { partial: 'export const useProviders = () => window.selectorRepro.local;' },
    'src/renderer/hooks/useDeviceProviders': { partial: 'export const useDeviceProviders = id => id ? window.selectorRepro.target : window.selectorRepro.empty;' },
    'src/renderer/hooks/useDevicesProviders': { partial: 'export const useDevicesProviders = keys => new Map(keys.flatMap(key => { const hit = Object.entries(window.selectorRepro.others).find(([id]) => key === id || key.includes(JSON.stringify(id))); return hit ? [[key, hit[1]]] : []; }));' },
    'src/renderer/features/provider-group/useLocalProviderGroups': { partial: 'export const useLocalProviderGroups = () => ({});' },
  },
  cases: {
    local: { about: 'Task opened on its own computer: equivalent sources fold' },
    default: { about: 'Same task opened remotely: equivalent sources also fold' },
    'remote-device-only': { about: 'Remote ChatInput without location choices passes only deviceId; target rails and rows still fold' },
    'remote-single': { about: 'A genuinely single-record target catalog stays single when remotely viewed' },
    'remote-current': { about: 'The duplicate the task uses stays listed and its equal steps aside: still one entry' },
    'remote-distinct': { about: 'Different verified account identities remain separate despite equal display names' },
    'remote-extra-model': { about: 'A source with additional models is not hidden' },
    'remote-other-computer': { about: 'Task on another computer: a third computer offering the same source is not listed again' },
    'remote-other-distinct': { about: 'Task on another computer: a third computer with a different account stays listed' },
  },
  async check(page, ui) {
    await page.locator('[data-repro-trigger] button').first().click();
    await page.getByRole('listbox').waitFor();
    const otherRails = await page.locator('[data-rail-item^="remote:"]').count();
    if (ui.case.startsWith('remote-other-'))
      assert.equal(otherRails, ui.case === 'remote-other-distinct' ? 1 : 0, `Observed other-computer rails: ${otherRails}`);
    const rails = page.locator('[data-rail-item^="provider:"]');
    const count = await rails.count();
    const separate = ['remote-distinct', 'remote-extra-model'].includes(ui.case);
    assert.equal(count, separate ? 2 : 1, `Observed provider rails: ${count}`);
    if (ui.case === 'remote-current') assert.equal(await rails.first().getAttribute('data-rail-item'), 'provider:openai-old');
    const rows = page.getByRole('option').filter({ hasText: 'GPT-6-Astra' });
    assert.equal(await rows.count(), separate ? 2 : 1, 'The visible model rows must match the source rail');
    assert.equal(await page.getByText('VIEWER ONLY MODEL', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'MBP ONLY', exact: true }).count(), 0);
    await ui.capture('provider-rails');
  },
};
