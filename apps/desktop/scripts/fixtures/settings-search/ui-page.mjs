import assert from 'node:assert/strict';

// Real settings routes and controls. Host responses are deterministic fixtures;
// no account, credentials, preference files or external services are accessed.
export default {
  name: 'settings-search',
  entry: './fixture.tsx',
  viewport: { width: 1280, height: 900 },
  real: 'SettingsView, settings sidebar/search, migrated sections and their original controls, translations and themes',
  notCovered: 'Native dialogs, persistence, real accounts, downloads, device connections and macOS native behavior',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: `export const useAuth = () => ({ mode: (window.__uiPage.ctx.data.cloud || window.__uiPage.ctx.data.tab === 'billing') ? 'cloud' : 'local', dataOwnerId: 'fixture-account', user: { id: 'fixture-account', name: 'Preview', membershipKind: 'personal' } });` },
  },
  cases: {
    'personalization-custom': { about: 'Custom auxiliary slots forward search IDs to real model selector buttons', data: { tab: 'personalization', customAuxiliary: true } },
    'remote-signed-in': { about: 'Signed-in device controls and relay section with searchable targets', data: { tab: 'remote-control', cloud: true } },
    ...Object.fromEntries([
    'general', 'appearance', 'personalization', 'voice-input', 'shortcuts',
    'remote-control', 'import', 'builtin-tools', 'storage', 'help', 'about', 'agent-island', 'usage', 'billing', 'shared-tasks', 'ghosts',
  ].map(tab => [tab === 'general' ? 'default' : tab, { about: `Real ${tab} settings and all rendered rows`, data: { tab } }])),
  },
  async check(page, ui) {
    const panel = page.getByRole('tabpanel');
    await panel.waitFor();
    assert.equal(await panel.getAttribute('id'), `settings-panel-${ui.data.tab}`);
    // Caller annotations must survive custom components, including the two
    // classical selectors sharing a definition distinct from display language.
    if (ui.data.tab === 'general') {
      assert.equal(await panel.locator('#settings-language [role="combobox"]').getAttribute('data-setting-id'), 'general.displayLanguage');
      if (ui.locale.includes('lzh')) {
        const classical = panel.locator('#settings-classical-language [role="combobox"]');
        assert.equal(await classical.count(), 2);
        for (const control of await classical.all()) assert.equal(await control.getAttribute('data-setting-id'), 'general.classicalLanguage');
      }
    }
    if (ui.data.customAuxiliary) {
      for (const slot of ['preferred', 'fallback1', 'fallback2']) {
        const trigger = panel.locator('button[data-setting-id="settings.auxiliaryModels.' + slot + '.label"]');
        assert.equal(await trigger.count(), 1);
        assert.equal(await trigger.getAttribute('aria-haspopup'), 'listbox');
      }
    }
    // Expand actual disclosure buttons without opening selects or write actions.
    for (let i = 0; i < 20; i++) {
      const disclosure = panel.locator('button[aria-expanded="false"]:not([aria-haspopup]):not([role="combobox"]):not([data-state])').first();
      if (!await disclosure.count()) break;
      await disclosure.click();
    }
    // Inspect each scroll position so the check covers long settings pages too.
    const scroller = panel.locator('xpath=../..');
    const height = await scroller.evaluate(el => el.scrollHeight);
    const viewport = await scroller.evaluate(el => el.clientHeight);
    assert.ok(viewport > 0, 'settings scroll container has a measurable height');
    for (let top = 0; top < height; top += viewport) {
      await scroller.evaluate((el, value) => { el.scrollTop = value; }, top);
      await ui.capture(`rows-${top}`);
    }
    // Search for a rendered setting through the real sidebar and verify the
    // resulting highlight and scroll position, not just the URL or catalog data.
    const entry = await panel.evaluate((el, tab) => {
      const controls = [...el.querySelectorAll('[data-setting-id]')].reverse();
      const entries = window.settingsFixtureEntries;
      return controls.map(control => entries.find(item => item.id === control.dataset.settingId && item.tab === tab))
        .find(item => item && document.getElementById(item.targetId))
        ?? entries.find(item => item.tab === tab && item.targetId === el.id);
    }, ui.data.tab);
    assert.ok(entry, 'page has a searchable definition');
    const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
    await search.fill(await ui.t(entry.titleKey));
    await page.locator('[id="settings-search-result-' + entry.id + '"]').click();
    const target = page.locator('[id="' + entry.targetId + '"]');
    await page.waitForFunction(id => {
      const el = document.getElementById(id);
      const rect = el?.getBoundingClientRect();
      return el?.classList.contains('settings-search-target-highlight') && rect.top >= 0 && rect.top < innerHeight;
    }, entry.targetId);
    assert.equal(await panel.getAttribute('id'), 'settings-panel-' + ui.data.tab);
    assert.ok(await target.isVisible());
    await ui.capture('search-target');
  },
};
