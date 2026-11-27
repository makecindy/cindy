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
  real: 'Production ModelGroupsSection, ModelSelector, and ModelGroupsOverview: map layout and connectors, quota per cell, the row that unfolds recent choices',
  notCovered: 'Expanding routes from the live catalog, the real quota reads and decision log in the main process',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({ mode: "local", dataOwnerId: null, user: null });' },
    'src/renderer/hooks/useAgentCapabilities': { partial: 'const state = { capabilities: { availableModels: [], effortLevels: [], permissionModes: [] }, loading: false, error: null }; export const useAgentCapabilities = (_kind, deviceId) => { if (deviceId) window.overviewFixture.capabilityReads.push(deviceId); return state; };' },
    'src/renderer/hooks/useModelRouteDevices': { partial: 'export const useModelRouteDevices = () => ({ devices: window.overviewFixture.editDevices });' },
    'src/renderer/hooks/useDeviceProviders': { partial: 'export const useDeviceProviders = (id) => id ? window.overviewFixture.old : window.overviewFixture.empty;' },
    'src/renderer/hooks/useProviders': { partial: 'export const useProviders = () => window.overviewFixture.local;' },
    'src/renderer/hooks/useDevicesProviders': { partial: 'export const useDevicesProviders = (ids) => new Map(ids.map((id) => [id, window.overviewFixture.remote[id] ?? window.overviewFixture.empty]));' },
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useSelectableDevices = () => window.overviewFixture.selectable;' },
    'src/renderer/features/provider-share/useProviderShareAgentDevices': { partial: 'export const useProviderShareAgentDevices = () => window.overviewFixture.shareName;' },
  },
  cases: {
    default: { about: 'One route by model and two that combine whole providers; the latest task went through a combined one' },
    harness: { about: 'A model route picks a Harness through the Session model selector, then reopens the saved choice', data: { harness: true } },
    empty: { about: 'No task has used a route yet: the row under the map still opens, onto one plain sentence', data: { empty: true } },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const nodes = async () => page.locator('[data-model-group-node]').evaluateAll((items) => items.map((item) => item.getAttribute('data-model-group-node')));
    const cell = (id) => page.locator(`[data-model-group-node="${id}"]`);
    if (ui.case === 'harness') {
      await cell('route:mine').click();
      const detail = page.getByTestId('model-group-route-detail');
      assert.deepEqual(await page.evaluate(() => window.overviewFixture.capabilityReads), []);
      const add = detail.getByRole('button', { name: new RegExp(await ui.t('modelGroups.settings.addSource')) });
      await add.click();
      const option = page.getByRole('option').filter({ hasText: 'GPT-6-Sol' });
      await option.first().click({ button: 'right' });
      const flyout = page.getByTestId('unified-model-config-flyout');
      await flyout.locator('[data-engine-capsule="pi"]').waitFor();
      await ui.capture('choose-harness');
      await flyout.locator('[data-engine-capsule="pi"]').click();
      const candidate = detail.locator('[data-model-group-candidate="2"]');
      await candidate.getByText('OpenAI · Pi').waitFor();
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      await candidate.getByRole('button', { name: new RegExp(await ui.t('modelGroups.settings.editSource')) }).click();
      await page.getByRole('option', { selected: true }).filter({ hasText: 'GPT-6-Sol' }).first().click({ button: 'right' });
      assert.equal(await flyout.locator('[data-engine-capsule="pi"]').getAttribute('aria-pressed'), 'true');
      await flyout.locator('[data-engine-capsule="codex"]').click();
      await candidate.getByText('OpenAI · Codex').waitFor();
      const oldCandidate = detail.locator('[data-model-group-candidate="1"]');
      await oldCandidate.getByRole('button', { name: new RegExp(await ui.t('modelGroups.settings.editSource')) }).click();
      // A provider on an old host has no selectable models. The same panel
      // still lets the user edit this row in place and choose a local source.
      await page.locator('[data-rail-item="provider:openai"]').click();
      await page.getByRole('option').filter({ hasText: 'GPT-6-Luna' }).first().getByText('GPT-6-Luna', { exact: true }).click();
      await oldCandidate.getByText('OpenAI · Codex').waitFor();
      assert.equal(await detail.locator('[data-model-group-candidate]').count(), 3);
      return;
    }
    await cell('route:auto:anthropic').waitFor();
    const all = await nodes();
    // Three routes on the left. On the right: the two model sources of the user's own route, then one cell per
    // member provider (two local ones, two shares) and never one per expanded model.
    assert.deepEqual(all.filter((id) => id.startsWith('route:')), ['route:mine', 'route:auto:openai', 'route:auto:anthropic']);
    assert.equal(all.filter((id) => id.startsWith('source:')).length, 6);
    assert.equal(all.filter((id) => id.startsWith('source:provider')).length, 4);
    // The two kinds of route are drawn in two labelled parts, never interleaved (2026-11-25 user feedback):
    // the user's own route with its model sources first, the combined ones with their member providers after.
    const parts = await page.locator('[data-testid="model-groups-map"] [data-model-group-kind]').evaluateAll((items) => items.map((item) => ({
      kind: item.getAttribute('data-model-group-kind'),
      cells: [...item.querySelectorAll('[data-model-group-node]')].map((cell) => cell.getAttribute('data-model-group-node').split('\u0000')[0]),
    })));
    assert.deepEqual(parts.map((part) => part.kind), ['model', 'provider']);
    assert.deepEqual(parts[0].cells.filter((id) => id.startsWith('route:')), ['route:mine']);
    assert.equal(parts[0].cells.some((id) => id.startsWith('source:provider')), false);
    assert.deepEqual(parts[1].cells.filter((id) => id.startsWith('route:')), ['route:auto:openai', 'route:auto:anthropic']);
    assert.equal(parts[1].cells.filter((id) => id.startsWith('source:')).every((id) => id.startsWith('source:provider')), true);
    // A combined route carries the brand mark of its first member; the user's own route keeps the route mark.
    assert.equal(await cell('route:auto:openai').locator('svg').count() > 0, true);
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
