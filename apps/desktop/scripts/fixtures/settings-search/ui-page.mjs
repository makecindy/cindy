import assert from 'node:assert/strict';

function readPaint(el) {
  const style = getComputedStyle(el);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = style.backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return { alpha: context.getImageData(0, 0, 1, 1).data[3] / 255, opacity: style.opacity,
    dark: document.documentElement.classList.contains('dark') };
}

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
    'visibility-desktop-commit': { about: 'Desktop visibility previews during a real pointer drag and commits once', data: { tab: 'appearance', previewBackground: 'none', visibility: 0.4 } },
    'visibility-wallpaper-commit': { about: 'Wallpaper visibility has the same preview/commit behavior', data: { tab: 'appearance', previewBackground: 'cindy-window', visibility: 0.4 } },
    ...Object.fromEntries(['none', 'cindy-window'].flatMap(background => [0.5, 1].map(visibility => [
      `glass-${background}-${visibility * 100}`, { about: 'Background sources share readable translucent cards', data: { tab: 'appearance', glassBackground: background, visibility } },
    ]))),
    'appearance-desktop-hidden': { about: 'Hidden desktop retains blur 12 with a disabled slider', data: { tab: 'appearance', hiddenBackground: 'none' } },
    'appearance-wallpaper-hidden': { about: 'Hidden wallpaper retains blur 12 with a disabled slider', data: { tab: 'appearance', hiddenBackground: 'cindy-window' } },
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
    if (ui.data.previewBackground) {
      const label = ui.data.previewBackground === 'none' ? 'desktopVisibilityLabel' : 'visibilityLabel';
      const slider = panel.getByRole('slider', { name: await ui.t(`settings.appearance.wallpaper.${label}`) });
      await slider.scrollIntoViewIfNeeded();
      const track = await slider.locator('xpath=ancestor::*[contains(@class,"cindy-slider")][1]').boundingBox();
      const thumb = await slider.boundingBox();
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
      await page.mouse.down();
      await page.mouse.move(track.x + track.width * 0.6, track.y + track.height / 2, { steps: 5 });
      await page.mouse.move(track.x + track.width * 0.8, track.y + track.height / 2, { steps: 5 });
      const preview = Number(await slider.getAttribute('aria-valuenow'));
      assert.ok(preview > 0.75 && preview < 0.85);
      assert.equal(await page.evaluate(() => window.visibilityWrites.length), 0);
      assert.equal(await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--background-visibility'))), preview);
      await ui.capture('visibility-preview');
      await page.mouse.up();
      await page.waitForFunction(() => window.visibilityWrites.length === 1);
      assert.deepEqual(await page.evaluate(() => window.visibilityWrites), [{ [ui.data.previewBackground === 'none' ? 'desktopVisibility' : 'wallpaperVisibility']: preview }]);
      await slider.press('ArrowLeft');
      await page.waitForFunction(() => window.visibilityWrites.length === 2);
      const committed = Number(await slider.getAttribute('aria-valuenow'));
      assert.equal(committed, Math.round((preview - 0.01) * 100) / 100);
      await ui.capture('visibility-committed');
      return;
    }
    // Regression: desktop transparency previously left every raised control opaque.
    // Real settings cards + Chromium CSS; cover both sources and the contrast floor.
    if (ui.data.glassBackground || ui.data.hiddenBackground === 'none') {
      const card = panel.locator('[class~="bg-[var(--settings-theme-card-bg)]"]').first();
      const paint = await card.evaluate(readPaint);
      const expected = ui.data.hiddenBackground ? 1 : ui.data.visibility === 1 ? 0.84 : paint.dark ? 0.68 : 0.72;
      assert.ok(Math.abs(paint.alpha - expected) < 0.005, `card alpha ${paint.alpha} should be ${expected}`);
      assert.equal(paint.opacity, '1', 'only the fill fades, never the control and text');
      await ui.capture('shared-glass');
      await panel.getByRole('combobox').first().click();
      const menu = page.getByRole('listbox');
      await menu.waitFor();
      assert.equal((await menu.evaluate(readPaint)).alpha, 1, 'floating choices stay opaque');
      await ui.capture('opaque-menu');
      await page.keyboard.press('Escape');
    }
    if (ui.data.hiddenBackground) {
      const label = ui.data.hiddenBackground === 'none' ? 'desktopBlurLabel' : 'blurLabel';
      const slider = panel.getByRole('slider', { name: await ui.t(`settings.appearance.wallpaper.${label}`) });
      await slider.scrollIntoViewIfNeeded();
      assert.equal(await slider.getAttribute('aria-valuenow'), '12');
      assert.equal(await slider.locator('xpath=ancestor::*[contains(@class,"cindy-slider")][1]').getAttribute('data-disabled'), '');
      assert.equal(await slider.evaluate(el => getComputedStyle(el.closest('.cindy-slider')).opacity), '0.5');
      await ui.capture('blur-suspended');
    }
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
