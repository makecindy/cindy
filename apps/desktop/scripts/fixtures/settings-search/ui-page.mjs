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
    'model-tokens': { about: 'One analytics switch controls activity and model totals', data: {tab: 'about', cloud: true, modelTokens: true} },
    'archive-search': { about: 'Searching for auto archive or idle days opens the inline controls inside Storage', data: { tab: 'general', archiveEnabled: true } },
    'archive-legacy': { about: 'The previous Task management link opens Storage and highlights auto archive', data: { tab: 'storage', routeTab: 'task-management' } },
    'visibility-desktop-commit': { about: 'Desktop visibility previews during a real pointer drag and commits once', data: { tab: 'appearance', previewBackground: 'none', visibility: 0.4 } },
    'visibility-wallpaper-commit': { about: 'Wallpaper visibility has the same preview/commit behavior', data: { tab: 'appearance', previewBackground: 'cindy-window', visibility: 0.4 } },
    ...Object.fromEntries(['none', 'cindy-window'].flatMap(background => [0.5, 1].map(visibility => [
      `glass-${background}-${visibility * 100}`, { about: 'Background sources share readable translucent cards', data: { tab: 'appearance', glassBackground: background, visibility } },
    ]))),
    'appearance-desktop-hidden': { about: 'Hidden desktop retains blur 12 with a disabled slider', data: { tab: 'appearance', hiddenBackground: 'none' } },
    'appearance-wallpaper-hidden': { about: 'Hidden wallpaper retains blur 12 with a disabled slider', data: { tab: 'appearance', hiddenBackground: 'cindy-window' } },
    'liquid-glass': { about: 'Liquid Glass is searchable and applies immediately in Interface material', data: { tab: 'personalization', liquidGlass: true } },
    'personalization-custom': { about: 'Custom auxiliary slots forward search IDs to real model selector buttons', data: { tab: 'personalization', customAuxiliary: true } },
    'worktree-model-naming': { about: 'Model naming defaults off, can be found in search, and clears its override on reset', data: { tab: 'personalization', worktreeModelNaming: true } },
    'tab-switch': { about: 'Committed settings tabs paint at full opacity with normal motion enabled', data: { tab: 'personalization', tabSwitch: true } },
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
    if (ui.data.liquidGlass) {
      const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
      const control = page.getByRole('switch', { name: await ui.t('settings.personalization.liquidGlass.label') });
      await search.fill('Liquid Glass');
      await page.locator('[id="settings-search-result-settings.personalization.liquidGlass.label"]').click();
      const initial = ui.platform === 'darwin' ? 'true' : 'false';
      await control.and(page.locator('[aria-checked="' + initial + '"]')).waitFor();
      await control.click();
      await control.and(page.locator('[aria-checked="' + (initial === 'true' ? 'false' : 'true') + '"]')).waitFor();
      const clarityLabel = await ui.t('settings.personalization.liquidGlass.clarity');
      await search.fill(clarityLabel);
      await page.locator('[id="settings-search-result-settings.personalization.liquidGlass.clarity"]').click();
      const slider = page.getByRole('slider', { name: clarityLabel });
      if (initial === 'true') await control.click();
      await slider.and(page.locator('[aria-valuenow="50"]')).waitFor();
      const track = slider.locator('xpath=..').locator('xpath=..');
      const bounds = await track.boundingBox();
      assert.ok(bounds?.width);
      const before = await page.evaluate(() => window.glassWrites.length);
      const point = (value) => page.mouse.move(bounds.x + bounds.width * value / 100,
        bounds.y + bounds.height / 2);
      const expectClarity = (value) => slider.and(page.locator(`[aria-valuenow="${value}"]`)).waitFor();
      await point(50);
      await page.mouse.down();
      for (const [pointer, expected] of [[26, 25], [27, 27], [49, 50], [74, 75]]) {
        await point(pointer);
        await expectClarity(expected);
      }
      const moved = 75;
      assert.equal(await page.evaluate(() => window.glassWrites.length), before);
      await page.mouse.up();
      await page.waitForFunction((expected) => window.glassWrites.at(-1)?.liquidGlassClarity === expected, moved);
      assert.equal(await page.evaluate(() => window.glassWrites.length), before + 1);
      await control.click();
      await slider.and(page.locator('[data-disabled]')).waitFor();
      assert.equal(await slider.getAttribute('aria-valuenow'), String(moved));
      await control.click();
      await slider.and(page.locator(':not([data-disabled])')).waitFor();
      assert.equal(await slider.getAttribute('aria-valuenow'), String(moved));
      await slider.press('ArrowRight');
      await expectClarity(76);
      await page.waitForFunction(() => window.glassWrites.at(-1)?.liquidGlassClarity === 76);
      const restore = await ui.t('settings.defaults.restore');
      const mark = page.getByRole('button', { name: restore + ' (50%)', exact: true });
      const settingsField = page.locator('#settings-search-target-personalization-liquid-glass-clarity');
      await ui.capture('default-tick', { locator: settingsField });
      await mark.click();
      await expectClarity(50);
      assert.equal(await page.evaluate(() => window.glassResets.at(-1)?.[0]), 'liquidGlassClarity');
      assert.equal(await control.getAttribute('aria-checked'), 'true');
      if (initial === 'true') {
        await control.click();
        await control.and(page.locator('[aria-checked="false"]')).waitFor();
      }
      await page.getByRole('button', { name: restore, exact: true }).click();
      await control.and(page.locator('[aria-checked="' + initial + '"]')).waitFor();
      assert.equal(await page.evaluate(() => window.glassResets.at(-1)?.[0]), 'liquidGlass');

      // A custom theme can choose a sidebar color distinct from the main surface.
      const sidebarColor = await page.evaluate(() => {
        const aside = document.createElement('aside');
        aside.className = 'bg-sidebar';
        aside.style.setProperty('--sidebar', '210 30% 45%');
        aside.style.setProperty('--surface', 'white');
        const tint = document.createElement('div');
        tint.className = 'sidebar-frost';
        aside.append(tint);
        document.body.append(aside);
        const root = document.documentElement;
        const previous = root.getAttribute('data-liquid-glass');
        root.dataset.liquidGlass = 'off';
        try {
          return getComputedStyle(tint).backgroundColor;
        } finally {
          aside.remove();
          if (previous === null) delete root.dataset.liquidGlass;
          else root.dataset.liquidGlass = previous;
        }
      });
      assert.equal(sidebarColor, 'rgb(80, 115, 149)');

      // Exercise the actual stylesheet cascade against both app background modes.
      const paints = await page.evaluate(() => {
        const root = document.documentElement;
        const state = ['data-liquid-glass', 'data-wallpaper-active', 'data-desktop-background']
          .map(name => [name, root.getAttribute(name)]);
        const saved = root.style.getPropertyValue('--glass-clarity-preview');
        const aside = document.createElement('aside');
        aside.className = 'bg-sidebar';
        const tint = document.createElement('div');
        tint.className = 'sidebar-frost';
        aside.append(tint);
        const menu = document.createElement('div');
        menu.className = 'bg-[var(--cmd-palette-bg)]';
        document.body.append(aside, menu);
        root.dataset.liquidGlass = 'on';
        try {
          return [['true', null], [null, 'true']].map(([wallpaper, desktop]) => {
            if (wallpaper) root.setAttribute('data-wallpaper-active', wallpaper);
            else root.removeAttribute('data-wallpaper-active');
            if (desktop) root.setAttribute('data-desktop-background', desktop);
            else root.removeAttribute('data-desktop-background');
            return [0, 1].map(clarity => {
              root.style.setProperty('--glass-clarity-preview', String(clarity));
              const { backgroundColor, backgroundImage } = getComputedStyle(menu);
              return [getComputedStyle(tint).backgroundImage, backgroundColor, backgroundImage,
                getComputedStyle(root).getPropertyValue('--menu-panel-surface')];
            });
          });
        } finally {
          aside.remove();
          menu.remove();
          for (const [name, value] of state) value === null ? root.removeAttribute(name) : root.setAttribute(name, value);
          if (saved) root.style.setProperty('--glass-clarity-preview', saved);
          else root.style.removeProperty('--glass-clarity-preview');
        }
      });
      for (const [low, high] of paints) {
        assert.notEqual(low[0], 'none');
        assert.notEqual(high[0], 'none');
        assert.notEqual(low[0], high[0]);
        assert.notEqual(low[1], high[1]);
        assert.notEqual(high[2], 'none');
        assert.notEqual(low[3], high[3]);
      }
    }
    // Product regression: the opt-in must remain off until selected. Exercise the
    // real setting, search and local override; existing cases only read controls.
    if (ui.data.modelTokens) {
      const toggle = panel.getByRole('switch', { name: await ui.t('settings.about.analyticsLabel'), exact: true });
      await toggle.scrollIntoViewIfNeeded();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await ui.capture('token-counts-default');
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[data-setting-id="settings.about.analyticsLabel"]')?.getAttribute('aria-checked') === 'true');
      await ui.capture('token-counts-enabled');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      return;
    }
    if (ui.data.worktreeModelNaming) {
      const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
      await search.fill(await ui.t('settings.worktreeModelNaming.cell.label'));
      await page.locator('[id="settings-search-result-personalization.worktreeModelNaming"]').click();
      const row = panel.locator('#settings-worktree-model-naming');
      const toggle = row.getByRole('switch');
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(await page.evaluate(() => localStorage.getItem('worktree.modelNaming.enabled')), null);
      await ui.capture('naming-default');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      assert.equal(await page.evaluate(() => localStorage.getItem('worktree.modelNaming.enabled')), 'true');
      await ui.capture('naming-enabled');
      await row.getByRole('button', { name: await ui.t('settings.defaults.restore'), exact: true }).click();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(await page.evaluate(() => localStorage.getItem('worktree.modelNaming.enabled')), null);
      return;
    }
    // 2026-11-14 recording: settled screenshots missed a blank frame caused by each tab's fade-in.
    // Exercise real SettingsView navigation and Chromium paint, with normal motion, on the first
    // committed frame. This browser scenario covers the animation gap beside the Suspense unit tests.
    if (ui.data.tabSwitch) {
      await panel.locator('textarea').first().waitFor();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const tab of ['general', 'personalization']) {
        await page.getByRole('tab', { name: await ui.t(`settings.tabs.${tab}`), exact: true }).click();
        const destination = page.locator(`#settings-panel-${tab}`);
        await destination.waitFor();
        const opacity = await destination.evaluate(element => new Promise(resolve => {
          requestAnimationFrame(() => resolve(Number(getComputedStyle(element.parentElement).opacity)));
        }));
        assert.equal(opacity, 1, `${tab} must paint at full opacity on its first frame`);
        await ui.capture(`${tab}-first-frame`);
      }
      return;
    }
    // Browser regression: relocating auto archive must preserve discoverability.
    // A search from General and the previous deep link must both reach the real
    // Storage controls; a component-only fixture cannot catch a stale route.
    if (ui.case === 'archive-search') {
      const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
      await search.fill(await ui.t('taskManagement.enabled'));
      await page.locator('[id="settings-search-result-task-management.autoArchive"]').click();
      await page.waitForFunction(() => document.getElementById('settings-task-auto-archive')
        ?.classList.contains('settings-search-target-highlight'));
      assert.equal(await panel.getAttribute('id'), 'settings-panel-storage');
      assert.ok(await panel.getByRole('switch', { name: await ui.t('taskManagement.enabled'), exact: true }).isVisible());
      assert.equal(await page.locator('#settings-tab-task-management').count(), 0);
      await ui.capture('archive-search-target');
      await search.fill(await ui.t('taskManagement.days'));
      await page.locator('[id="settings-search-result-task-management.archiveDays"]').click();
      await page.waitForFunction(() => document.getElementById('settings-task-archive-days')
        ?.classList.contains('settings-search-target-highlight'));
      assert.ok(await panel.getByRole('combobox', { name: await ui.t('taskManagement.days'), exact: true }).isVisible());
      return;
    }
    if (ui.data.tab === 'storage') {
      const archive = panel.getByRole('region', { name: await ui.t('taskManagement.archive'), exact: true });
      await archive.getByRole('switch', { name: await ui.t('taskManagement.enabled'), exact: true }).waitFor();
      assert.equal(await page.locator('#settings-tab-task-management').count(), 0);
      assert.equal(await page.getByRole('tabpanel').count(), 1);
      const database = panel.getByRole('heading', { name: await ui.t('settings.about.storage.databaseSectionTitle'), exact: true });
      assert.ok((await archive.boundingBox()).y < (await database.boundingBox()).y);
      await archive.evaluate(el => el.scrollIntoView({ block: 'start' }));
      await ui.capture('archive-layout');
      if (ui.case === 'archive-legacy') {
        assert.equal(await page.locator('#settings-tab-storage').getAttribute('aria-selected'), 'true');
        await page.waitForFunction(() => document.getElementById('settings-task-auto-archive-section')
          ?.classList.contains('settings-search-target-highlight'));
        return;
      }
    }
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
      const name = await ui.t(`settings.appearance.wallpaper.${label}`);
      // Windows desktop blur uses Acrylic's on/off switch; artwork and the
      // other platforms retain the strength slider. Both suspend at visibility 0.
      if (ui.platform === 'win32' && ui.data.hiddenBackground === 'none') {
        const toggle = panel.getByRole('switch', { name });
        await toggle.scrollIntoViewIfNeeded();
        assert.equal(await toggle.isDisabled(), true);
        assert.equal(await toggle.getAttribute('aria-checked'), 'false');
        assert.equal(await panel.getByRole('slider', { name }).count(), 0);
      } else {
        const slider = panel.getByRole('slider', { name });
        await slider.scrollIntoViewIfNeeded();
        assert.equal(await slider.getAttribute('aria-valuenow'), '12');
        assert.equal(await slider.locator('xpath=ancestor::*[contains(@class,"cindy-slider")][1]').getAttribute('data-disabled'), '');
        assert.equal(await slider.evaluate(el => getComputedStyle(el.closest('.cindy-slider')).opacity), '0.5');
      }
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
