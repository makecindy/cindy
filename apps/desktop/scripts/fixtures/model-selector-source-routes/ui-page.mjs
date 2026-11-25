import assert from 'node:assert/strict';

// Browser-tier check of how a provider route appears and behaves in the new-task model picker
// (2026-11-24 user decision): it is listed as one ordinary provider, its members are not listed, and
// choosing a model under it keeps a real member's model in the draft while recording the route that
// decides the member. No other fixture mounts the picker with provider routes.
// Minimal failing input: members still listed next to the merged entry; choosing a row hands the
// draft the merged entry's made-up provider id; the chosen row is not shown as selected afterwards.
// Case `shared` (2026-11-25 user report: choosing a model under the merged entry made the panel jump and
// lose the selection): every member is shared by someone else, so the draft's Agent location is a share.
// Minimal failing input: the route is recorded a beat after the model, the reopened panel shows no selected
// row under the merged entry, or the task computer's other providers lose their rows.
export default {
  name: 'model-selector-source-routes', entry: './fixture.tsx', viewport: { width: 860, height: 660 },
  real: 'Production ModelSelector, rail, rows and its selection callbacks',
  notCovered: 'Expanding routes from the live catalog, resolving the member when the task starts, sending',
  stubs: {
    'src/renderer/hooks/useAgentCapabilities': { partial: 'const state = { capabilities: { hasFastMode: true, availableModels: [], effortLevels: [{ id: "low", displayName: "Low" }, { id: "medium", displayName: "Medium" }, { id: "high", displayName: "High" }], permissionModes: [] }, loading: false, error: null }; export const useAgentCapabilities = () => state;' },
    'src/renderer/hooks/useProviders': { partial: 'export const useProviders = () => window.sourceRoutesFixture.local;' },
    'src/renderer/hooks/useDeviceProviders': { partial: 'export const useDeviceProviders = () => window.sourceRoutesFixture.empty;' },
    'src/renderer/hooks/useDevicesProviders': { partial: 'export const useDevicesProviders = (ids) => new Map(ids.map((id) => [id, window.sourceRoutesFixture.remote[id] ?? window.sourceRoutesFixture.empty]));' },
    'src/renderer/features/provider-group/useLocalProviderGroups': { partial: 'export const useLocalProviderGroups = () => ({});' },
  },
  cases: {
    default: { about: 'Two providers of one brand: one merged entry, members not listed, a chosen row records member and route' },
    hidden: { about: 'The user hid the provider route: members are listed as before', data: { hidden: true } },
    shared: { about: 'Every member is a provider shared by someone else: choosing a model keeps the merged entry and the selection', data: { shared: true } },
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
    if (ui.case === 'shared') {
      // The two shares are one entry; neither is listed on its own.
      assert.deepEqual((await rail()).filter(key => key.includes('anthropic') || key.includes('share:')), ['provider:sroute:auto:anthropic']);
      await page.locator('[data-rail-item="provider:sroute:auto:anthropic"]').click();
      const shared = page.getByRole('option');
      await shared.filter({ hasText: 'CLAUDE-SONNET' }).first().getByText('CLAUDE-SONNET', { exact: true }).click();
      await page.waitForFunction(() => window.sourceRoutesFixture.calls.attached.length === 1);
      const chosen = await calls();
      // The draft gets the first share's model together with where it runs, and the route in the same click:
      // recorded a beat later, the panel first jumps to that share's own list and then back.
      assert.deepEqual(chosen.unified, [{ providerId: 'anthropic', modelId: 'claude-sonnet', effort: chosen.unified[0].effort,
        agentDeviceId: 'share:11111111-1111-4111-8111-111111111111' }]);
      assert.deepEqual(chosen.attached, [{ type: 'route', id: 'src:sonnet' }]);
      assert.deepEqual(chosen.attachedInSameClick, [true]);
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      await trigger.click();
      await page.getByRole('listbox').waitFor();
      // Reopened: the chosen row is the selected one under the merged entry, not under a share and not nowhere.
      await page.locator('[data-rail-item="provider:sroute:auto:anthropic"]').click();
      await page.getByRole('option', { selected: true }).filter({ hasText: 'CLAUDE-SONNET' }).waitFor();
      await ui.capture('shared-chosen-row');
      // The task computer's own providers keep their rows although the draft's Agent now runs on a share.
      await page.locator('[data-rail-item="provider:xd"]').click();
      await page.getByRole('option').filter({ hasText: 'GPT-5.5' }).first().waitFor();
      return;
    }
    // One entry for the merged route, in the first member's place; the members themselves are gone.
    // The merged entry comes before ordinary providers, right after the routing cell, and is marked as a route
    // (2026-11-25 user feedback: it looked like any other provider in the rail).
    assert.deepEqual((await rail()).filter(key => key.startsWith('provider:')), ['provider:sroute:auto:openai', 'provider:xd']);
    assert.equal(await page.locator('[data-rail-item="provider:sroute:auto:openai"] [data-route-source-mark]').count(), 1);
    assert.equal(await page.locator('[data-rail-item="provider:xd"] [data-route-source-mark]').count(), 0);
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
