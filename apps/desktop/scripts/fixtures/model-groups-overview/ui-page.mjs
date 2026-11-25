import assert from 'node:assert/strict';

// Browser-tier check of the routing map in Settings → Model providers → Smart routing (2026-11-25 user
// feedback): routes that combine whole providers are drawn too, one cell per member provider instead of one
// per model they expand into, and the recent choices stay folded into the row under the map until asked for.
// No other fixture mounts the map; the unit test next to the component only covers quota on model sources.
// Minimal failing input: a whole-provider route is missing from the map or draws a cell per model; quota is
// read by resolving every expanded model; the latest task is not marked on the combined route; the recent
// list is open by default or the row under the map cannot open it.
export default {
  name: 'model-groups-overview', entry: './fixture.tsx', viewport: { width: 960, height: 760 },
  real: 'Production ModelGroupsOverview: map layout and connectors, quota per cell, the row that unfolds recent choices',
  notCovered: 'Expanding routes from the live catalog, the real quota reads and decision log in the main process',
  stubs: {
    'src/renderer/hooks/useProviders': { partial: 'export const useProviders = () => window.overviewFixture.local;' },
    'src/renderer/hooks/useDevicesProviders': { partial: 'export const useDevicesProviders = (ids) => new Map(ids.map((id) => [id, window.overviewFixture.remote[id] ?? window.overviewFixture.empty]));' },
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useSelectableDevices = () => window.overviewFixture.selectable;' },
    'src/renderer/features/provider-share/useProviderShareAgentDevices': { partial: 'export const useProviderShareAgentDevices = () => window.overviewFixture.shareName;' },
  },
  cases: {
    default: { about: 'One route by model and two that combine whole providers; the latest task went through a combined one' },
    empty: { about: 'No task has used a route yet: the row under the map still opens, onto one plain sentence', data: { empty: true } },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const nodes = async () => page.locator('[data-model-group-node]').evaluateAll((items) => items.map((item) => item.getAttribute('data-model-group-node')));
    const cell = (id) => page.locator(`[data-model-group-node="${id}"]`);
    await cell('route:auto:anthropic').waitFor();
    const all = await nodes();
    // Three routes on the left. On the right: the two model sources of the user's own route, then one cell per
    // member provider (two local ones, two shares) and never one per expanded model.
    assert.deepEqual(all.filter((id) => id.startsWith('route:')), ['route:mine', 'route:auto:openai', 'route:auto:anthropic']);
    assert.equal(all.filter((id) => id.startsWith('source:')).length, 6);
    assert.equal(all.filter((id) => id.startsWith('source:provider')).length, 4);
    // A combined route says how many models it covers (the wording follows the locale; the count does not).
    assert.match(await cell('route:auto:openai').textContent(), /3/);
    assert.match(await cell('route:auto:anthropic').textContent(), /2/);
    // Quota arrives for every member after resolving the user's route and one expansion per combined route.
    await page.waitForFunction(() => document.querySelectorAll('[data-model-group-node^="source:provider"]').length === 4
      && [...document.querySelectorAll('[data-model-group-node^="source:provider"]')].every((item) => /\d+%/.test(item.textContent ?? '')));
    assert.deepEqual(await page.evaluate(() => window.overviewFixture.calls.resolved), ['mine', 'src:gpt-6-astra', 'src:claude-opus']);
    const toggle = page.locator('[data-model-groups-recent-toggle]');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-model-group-decision]').count(), 0);
    if (ui.case === 'empty') {
      assert.equal(await page.locator('[data-latest]').count(), 0);
      await ui.capture('folded');
      await toggle.click();
      await page.locator('[data-model-groups-recent-toggle][aria-expanded="true"]').waitFor();
      assert.equal(await page.locator('[data-model-group-decision]').count(), 0);
      await ui.capture('unfolded');
      return;
    }
    // The latest task is marked on the combined route it went through and on the member it landed on.
    assert.deepEqual(await page.locator('[data-latest]').evaluateAll((items) => items.map((item) => item.getAttribute('data-model-group-node')).sort()),
      ['route:auto:anthropic', 'source:provider\u0000share:11111111-1111-4111-8111-111111111111\u0000anthropic'].sort());
    await ui.capture('folded');
    // A combined route opens its own page.
    await cell('route:auto:openai').click();
    assert.deepEqual(await page.evaluate(() => window.overviewFixture.calls.opened), ['source:auto:openai']);
    // The row under the map unfolds the recent choices and folds them again.
    await toggle.click();
    await page.locator('[data-model-group-decision]').first().waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-model-group-decision]').count(), 4);
    await ui.capture('unfolded');
    await toggle.click();
    await page.locator('[data-model-group-decision]').first().waitFor({ state: 'detached' });
  },
};
