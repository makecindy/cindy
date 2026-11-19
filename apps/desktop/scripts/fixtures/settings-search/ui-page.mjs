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
    'page-search-highlight': { about: 'Search briefly fills the background of a single navigation option or setting', data: { tab: 'general', fullDatabase: true } },
    'page-search-highlight-motion': { about: 'The highlighted background returns smoothly to its resting color', data: { tab: 'general', highlightMotion: true, fullDatabase: true } },
    'model-tokens': { about: 'A signed-in profile can opt in to and stop sharing model totals', data: {tab: 'about', modelTokens: true} },
    'archive-search': { about: 'Searching for auto archive or idle days opens the inline controls inside Storage', data: { tab: 'general', archiveEnabled: true } },
    'archive-legacy': { about: 'The previous Task management link opens Storage and highlights auto archive', data: { tab: 'storage', routeTab: 'task-management' } },
    'visibility-desktop-commit': { about: 'Desktop visibility previews during a real pointer drag and commits once', data: { tab: 'appearance', previewBackground: 'none', visibility: 0.4 } },
    'visibility-wallpaper-commit': { about: 'Wallpaper visibility has the same preview/commit behavior', data: { tab: 'appearance', previewBackground: 'cindy-window', visibility: 0.4 } },
    ...Object.fromEntries(['none', 'cindy-window'].flatMap(background => [0.5, 1].map(visibility => [
      `glass-${background}-${visibility * 100}`, { about: 'Background sources share readable translucent cards', data: { tab: 'appearance', glassBackground: background, visibility } },
    ]))),
    'appearance-desktop-hidden': { about: 'Hidden desktop retains blur 12 with a disabled slider', data: { tab: 'appearance', hiddenBackground: 'none' } },
    'appearance-wallpaper-hidden': { about: 'Hidden wallpaper retains blur 12 with a disabled slider', data: { tab: 'appearance', hiddenBackground: 'cindy-window' } },
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
    if (ui.case === 'page-search-highlight' || ui.data.highlightMotion) {
      // Search feedback should fade immediately even when scrolling motion is reduced.
      await page.emulateMedia({ reducedMotion: ui.data.highlightMotion ? 'no-preference' : 'reduce' });
      const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
      const highlights = page.locator('.settings-search-target-highlight');
      for (const [id, titleKey, targetId] of [
        ['appearance', 'settings.tabs.appearance', 'settings-tab-appearance'],
        ['builtinTools', 'settings.tabs.builtinTools', 'settings-tab-builtin-tools'],
        ['mcp.duplicates', null, 'settings-mcp-duplicates'],
        ['settings.appearance.wallpaper.customChoose', 'settings.appearance.wallpaper.options.custom', 'settings-search-settings-appearance-wallpaper-custom'],
        ['personalization.instructions', 'settings.personalization.subtitle', 'settings-user-instructions'],
        ['settings.about.storage.databaseSectionTitle', 'settings.about.storage.databaseSectionTitle', 'settings-search-settings-about-storage-databaseSectionTitle'],
      ]) {
        await search.fill(titleKey ? await ui.t(titleKey) : 'MCP');
        await page.locator(`[id="settings-search-result-${id}"]`).click();
        const highlight = highlights.and(page.locator(`[id="${targetId}"]`));
        await highlight.waitFor();
        assert.equal(await highlights.count(), 1);
        if (id === 'settings.about.storage.databaseSectionTitle') {
          // A full progress track clips the outset and completely covers an in-track tint.
          const fullTrack = highlight.getByRole('progressbar', { name: await ui.t(titleKey) }).and(
            page.locator('[aria-valuenow="100"]'),
          );
          await fullTrack.waitFor();
          assert.equal(await highlight.evaluate(el => getComputedStyle(el).overflow), 'visible');
        }
        if (targetId.startsWith('settings-tab-')) {
          assert.ok(await highlight.evaluate(el => {
            const sidebar = el.closest('aside').getBoundingClientRect();
            const target = el.getBoundingClientRect();
            return target.top >= sidebar.top && target.bottom <= sidebar.bottom;
          }), `${targetId} must be visible in the settings sidebar`);
        }
        const style = await highlight.evaluate(el => {
          const nativeField = el.matches('input, textarea, select');
          const face = nativeField ? null : '::after';
          const dark = document.documentElement.classList.contains('dark');
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          const brightness = (fill) => {
            context.globalAlpha = 1;
            context.fillStyle = dark ? '#000' : '#fff';
            context.fillRect(0, 0, 1, 1);
            context.globalAlpha = Number(fill.opacity);
            context.fillStyle = fill.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
            return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          };
          const animation = el.getAnimations({ subtree: true })
            .find(candidate => candidate.animationName === (nativeField ? 'settings-search-field-feedback' : 'settings-search-feedback'));
          const duration = animation.effect.getComputedTiming().duration;
          const sample = (progress) => {
            animation.currentTime = duration * progress;
            return brightness(getComputedStyle(el, face));
          };
          const peak = sample(0);
          const early = sample(0.15);
          const middle = sample(0.5);
          const late = sample(0.8);
          const end = sample(0.999);
          animation.currentTime = 0;
          const fill = getComputedStyle(el, face);
          return { peak, early, middle, late, end, dark, duration, outline: fill.outlineStyle,
            outlineColor: fill.outlineColor,
            radius: parseFloat(fill.borderTopLeftRadius), top: parseFloat(fill.top), left: parseFloat(fill.left),
            fieldShadow: nativeField && fill.boxShadow };
        });
        const distance = frame => Math.abs(style[frame] - style.end);
        assert.equal(style.duration, ui.data.highlightMotion ? 2200 : 550);
        assert.ok(style.dark ? style.peak > style.end : style.peak < style.end);
        assert.ok(distance('peak') > distance('early') && distance('early') > distance('middle'));
        assert.ok(distance('middle') > distance('late') && distance('late') > 0);
        assert.ok(style.radius > 0);
        if (style.fieldShadow) assert.notEqual(style.fieldShadow, 'none');
        else assert.ok(style.top < 0 && style.left < 0);
        assert.ok(style.outline === 'none' || style.outlineColor === 'rgba(0, 0, 0, 0)');
        if (!ui.data.highlightMotion) await ui.capture(`${targetId}-highlight`);
      }
      await highlights.waitFor({ state: 'detached' });
      return;
    }
    // Product regression: the opt-in must remain off until selected. Exercise the
    // real setting, search and local override; existing cases only read controls.
    if (ui.data.modelTokens) {
      const toggle = panel.getByRole('switch', { name: await ui.t('settings.about.productTokenUsage'), exact: true });
      await toggle.scrollIntoViewIfNeeded();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await ui.capture('token-counts-default');
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[data-setting-id="settings.about.productTokenUsage"]')?.getAttribute('aria-checked') === 'true');
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
      if (!el || !rect || rect.top < 0 || rect.top >= innerHeight) return false;
      if (el.getAttribute('role') === 'tabpanel') {
        const tab = document.getElementById(el.getAttribute('aria-labelledby') ?? '');
        return tab?.classList.contains('settings-search-target-highlight');
      }
      return el.classList.contains('settings-search-target-highlight');
    }, entry.targetId);
    assert.equal(await panel.getAttribute('id'), 'settings-panel-' + ui.data.tab);
    assert.ok(await target.isVisible());
    await ui.capture('search-target');
  },
};
