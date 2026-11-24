import assert from 'node:assert/strict';

// Browser-tier check of how a provider route appears and behaves in the new-task model picker
// (2026-11-24 user decision): it is listed as one ordinary provider, its members are not listed, and
// choosing a model under it keeps a real member's model in the draft while recording the route that
// decides the member. No other fixture mounts the picker with provider routes.
// Minimal failing input: members still listed next to the merged entry; choosing a row hands the
// draft the merged entry's made-up provider id; the chosen row is not shown as selected afterwards.
export default {
  name: 'model-selector-source-routes', entry: './fixture.tsx', viewport: { width: 860, height: 660 },
  real: 'Production ModelSelector, rail, rows and its selection callbacks',
  notCovered: 'Expanding routes from the live catalog, resolving the member when the task starts, sending',
  stubs: {
    'src/renderer/hooks/useAgentCapabilities': { partial: 'const state = { capabilities: { hasFastMode: true, availableModels: [], effortLevels: [{ id: "low", displayName: "Low" }, { id: "medium", displayName: "Medium" }, { id: "high", displayName: "High" }], permissionModes: [] }, loading: false, error: null }; export const useAgentCapabilities = () => state;' },
    'src/renderer/hooks/useProviders': { partial: 'export const useProviders = () => window.sourceRoutesFixture.local;' },
    'src/renderer/hooks/useDeviceProviders': { partial: 'export const useDeviceProviders = () => window.sourceRoutesFixture.empty;' },
    'src/renderer/features/provider-group/useLocalProviderGroups': { partial: 'export const useLocalProviderGroups = () => ({});' },
  },
  cases: {
    default: { about: 'Two providers of one brand: one merged entry, members not listed, a chosen row records member and route' },
    hidden: { about: 'The user hid the provider route: members are listed as before', data: { hidden: true } },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const trigger = page.locator('[data-source-routes-trigger] button').first();
    const rail = async () => page.locator('[data-rail-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-rail-item')));
    const calls = () => page.evaluate(() => window.sourceRoutesFixture.calls);
    await trigger.click();
    await page.getByRole('listbox').waitFor();
    if (ui.case === 'hidden') {
      assert.deepEqual((await rail()).filter(key => key.startsWith('provider:')), ['provider:xd', 'provider:openai', 'provider:byok-1']);
      await ui.capture('members-listed');
      return;
    }
    // One entry for the merged route, in the first member's place; the members themselves are gone.
    assert.deepEqual((await rail()).filter(key => key.startsWith('provider:')), ['provider:xd', 'provider:sroute:auto:openai']);
    // It keeps the brand mark of its first member instead of falling back to a letter.
    assert.equal(await page.locator('[data-rail-item="provider:sroute:auto:openai"] svg').count() > 0, true);
    await page.locator('[data-rail-item="provider:sroute:auto:openai"]').click();
    const rows = page.getByRole('option');
    await rows.filter({ hasText: 'GPT-6-LUNA' }).first().waitFor();
    assert.equal(await rows.filter({ hasText: 'GPT-6-LUNA' }).count(), 1);
    await ui.capture('merged-entry');
    // Click the name, not the row centre: the favourite and customise buttons sit right after a short name.
    await rows.filter({ hasText: 'GPT-6-LUNA' }).first().getByText('GPT-6-LUNA', { exact: true }).click();
    // The draft is handed a real member's model, never the merged entry's own id, then the route.
    await page.waitForFunction(() => window.sourceRoutesFixture.calls.attached.length === 1);
    const first = await calls();
    assert.deepEqual(first.unified, [{ providerId: 'openai', modelId: 'gpt-6-luna', effort: first.unified[0].effort }]);
    assert.deepEqual(first.attached, [{ type: 'route', id: 'src:luna' }]);
    // The trigger reads as an ordinary model, and reopening shows that row selected under the merged entry.
    await page.waitForFunction(() => document.querySelector('[data-source-routes-trigger] button')?.textContent?.includes('GPT-6-LUNA'));
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await trigger.click();
    await page.getByRole('listbox').waitFor();
    await page.locator('[data-rail-item="provider:sroute:auto:openai"]').click();
    await page.getByRole('option', { selected: true }).filter({ hasText: 'GPT-6-LUNA' }).waitFor();
    await ui.capture('chosen-row');
    // Choosing an ordinary model afterwards goes back to a plain selection: nothing new is attached.
    await page.locator('[data-rail-item="provider:xd"]').click();
    await page.getByRole('option').filter({ hasText: 'GPT-5.5' }).first().getByText('GPT-5.5', { exact: true }).click();
    await page.waitForFunction(() => window.sourceRoutesFixture.calls.unified.length === 2);
    const second = await calls();
    assert.equal(second.unified[1].providerId, 'xd');
    assert.equal(second.attached.length, 1);
    assert.equal(second.cleared, 1);
  },
};
