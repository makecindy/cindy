import assert from 'node:assert/strict';

// Browser-tier check of Settings → Model providers → Smart routing → Provider route detail (2026-11-28 user
// decision): NO two-layer nested auto-routing. Local multi-account pools flatten directly into individual numbered
// rows (1, 2, 3, 4) alongside other providers, devices, and shares — each independently toggleable/reorderable/weighted —
// and "Test" (ModelGroupRoutePreview) resolves directly to the concrete flat sources with zero wrapped "auto".
// Minimal failing input: auto:openai with 2 local accounts + OpenAI-Codex + shared source.
export default {
  name: 'model-groups-source-detail', entry: './fixture.tsx', viewport: { width: 820, height: 1080 },
  real: 'Production SourceRouteDetail + ModelGroupRoutePreview: flat numbered local accounts, BYOK, and shared sources with individual switches, zero nested auto rows, and flat dry-run trace',
  notCovered: 'Main-process automatic route deduplication (covered by sourceRoutes.test.ts) and live provider IPC',
  stubs: {
    'src/renderer/hooks/useProviders': { partial: 'export const useProviders = () => window.sourceDetailFixture.local;' },
    'src/renderer/hooks/useDevicesProviders': { partial: 'export const useDevicesProviders = () => window.sourceDetailFixture.remote;' },
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useSelectableDevices = () => window.sourceDetailFixture.selectable;' },
    'src/renderer/features/provider-share/useProviderShareAgentDevices': { partial: 'export const useProviderShareAgentDevices = () => window.sourceDetailFixture.shareName;' },
    'src/renderer/hooks/useModelRouteDevices': { partial: 'export const useModelRouteDevices = () => window.sourceDetailFixture.modelRouteDevices;' },
    'src/renderer/hooks/usePluginEngines': {
      partial: 'export const usePluginEngines = () => window.sourceDetailFixture.pluginEngines; export const useDevicesPluginEngines = () => window.sourceDetailFixture.devicesPluginEngines; export const useRemotePluginEngines = () => [];',
    },
    'src/renderer/features/provider-group/useLocalProviderGroups': { partial: 'export const useLocalProviderGroups = () => window.sourceDetailFixture.localGroups;' },
  },
  cases: {
    default: { about: 'Flat 4-source provider route (2 local accounts, BYOK, share) with flat Test preview open' },
    weighted: { about: 'Weighted strategy with one local account toggled off and skipped in Test preview', data: { mode: 'weighted' } },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const members = [0, 1, 2, 3].map((i) => page.locator(`[data-source-route-member="${i}"]`));
    await members[0].waitFor();
    await page.getByText('OpenAI · account-a@example.com').waitFor();
    await page.getByText('OpenAI · account-b@example.com').waitFor();
    // Zero nested account or computer auto-routing rows anywhere on the page.
    assert.equal(await page.locator('[data-auto-route^="accounts:"]').count(), 0);
    assert.equal(await page.locator('[data-auto-route^="computers:"]').count(), 0);
    // All 4 flat rows live in the same card and each has its own Switch.
    for (const member of members) {
      assert.equal(await member.locator('[role="switch"]').count(), 1);
    }
    // Click "Test" (试一下) and verify the flat trace lists all 4 individual sources directly.
    await page.locator('[data-settings-search-action="Previews which source a route would pick; changes no setting"]').click();
    const preview = page.getByTestId('model-group-preview');
    await preview.waitFor();
    const previewText = await preview.textContent();
    assert.match(previewText ?? '', /OpenAI · account-a@example\.com/);
    assert.match(previewText ?? '', /OpenAI · account-b@example\.com/);
    assert.match(previewText ?? '', /OpenAI-Codex/);
    if (ui.case === 'weighted') {
      assert.equal(await preview.locator('[data-model-group-trace="skipped"]').count(), 1);
    } else {
      assert.equal(await preview.locator('[data-model-group-trace="picked"]').count(), 1);
      assert.equal(await preview.locator('[data-model-group-trace="standby"]').count(), 3);
    }
    await ui.capture(ui.case === 'weighted' ? 'weighted' : 'default');
  },
};
