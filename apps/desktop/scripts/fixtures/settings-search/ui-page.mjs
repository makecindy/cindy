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
  real: 'SettingsView, settings sidebar/search, sidebar account menu, original controls, translations and themes',
  notCovered: 'Native dialogs, persistence, real accounts, downloads, device connections and macOS native behavior',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: `
      const accounts = async () => ({ accounts: [], mutationAllowed: true });
      export const useAuth = () => ({
        mode: (window.__uiPage.ctx.data.cloud || window.__uiPage.ctx.data.tab === 'billing') ? 'cloud' : 'local',
        dataOwnerId: 'fixture-account', user: { id: 'fixture-account', name: 'Preview', membershipKind: window.__uiPage.ctx.data.organization ? 'org' : 'personal' },
        listAccounts: accounts, syncAccounts: accounts,
      });` },
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
    'personalization-custom': { about: 'Custom auxiliary slots forward search IDs to real model selector buttons', data: { tab: 'personalization', customAuxiliary: true } },
    'worktree-model-naming': { about: 'Model naming defaults off, can be found in search, and clears its override on reset', data: { tab: 'personalization', worktreeModelNaming: true } },
    'tab-switch': { about: 'Committed settings tabs paint at full opacity with normal motion enabled', data: { tab: 'personalization', tabSwitch: true } },
    'remote-signed-in': { about: 'Signed-in device controls and relay section with searchable targets', data: { tab: 'remote-control', cloud: true } },
    'group-deep-link': { about: 'A device settings link reopens its collapsed group without changing tabs', data: { tab: 'remote-control', cloud: true, groupDeepLink: true } },
    'advanced-disclosure': { about: 'Advanced settings collapse with the shared transition and reopen for search', data: { tab: 'general' } },
    'sidebar-usage': { about: 'Clicking the sidebar account once reveals local usage and available balance above Settings', data: { accountUsage: true, cloud: true, previewUsage: true } },
    'sidebar-usage-large-balance': { about: 'Localized balances with grouped digits remain readable in the account menu', data: { accountUsage: true, cloud: true, previewUsage: true, largeBalance: true } },
    'sidebar-usage-local': { about: 'Local accounts can reach usage history and are not offered a billing entry', data: { accountUsage: true, previewUsage: true } },
    'sidebar-usage-org': { about: 'Organization accounts can reach usage history without attempting personal billing reads', data: { accountUsage: true, cloud: true, organization: true, previewUsage: true } },
    'sidebar-usage-legacy': { about: 'An account with only the basic balance API still sees its available balance', data: { accountUsage: true, cloud: true, legacyBalance: true, previewUsage: true } },
    'settings-layout-general': { about: 'General settings organize related controls into cards beneath the grouped sidebar', data: { tab: 'general', layoutPreview: true, interactivePreview: true } },
    'settings-layout-appearance': { about: 'The grouped sidebar and appearance controls share the wallpaper and theme', data: { tab: 'appearance', layoutPreview: true, interactivePreview: true } },
    ...Object.fromEntries(['general', 'billing'].map(tab => [`settings-large-font-${tab}`, {
      about: `Actions on the ${tab} page stay in view at the smallest window width with a large UI font`,
      viewport: { width: 800, height: 900 },
      data: { tab, cloud: true, interactivePreview: true, largeUiFont: true, previewUsage: true },
    }])),
    ...Object.fromEntries([
    'general', 'appearance', 'personalization', 'voice-input', 'shortcuts',
    'remote-control', 'import', 'builtin-tools', 'storage', 'help', 'about', 'agent-island', 'usage', 'billing', 'shared-tasks', 'ghosts',
    'providers', 'model-groups', 'computer-use', 'im-bot',
  ].map(tab => [tab === 'general' ? 'default' : tab, { about: `Real ${tab} settings and all rendered rows`, data: { tab,
    previewUsage: tab === 'usage' || tab === 'billing', sampleModels: tab === 'model-groups' } }])),
  },
  async check(page, ui) {
    const panel = page.getByRole('tabpanel');
    // Browser regression for PR #11473: a 24px UI font and the 800px window
    // can push translated account or billing actions past the edge of the card.
    if (ui.data.largeUiFont) {
      const actionKey = ui.data.tab === 'general' ? 'sidebar.user.menuAddAccount' : 'billing.settings.topupCard.action';
      const action = panel.getByRole('button', { name: await ui.t(actionKey), exact: true });
      await action.waitFor();
      assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--app-ui-font-size')), '24px');
      assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Settings panel must fit horizontally');
      assert.ok(await page.locator('aside h1').evaluate(el => {
        const title = document.createRange();
        title.selectNodeContents(el);
        return title.getClientRects().length === 1 && el.scrollWidth <= el.clientWidth + 1 &&
          el.getBoundingClientRect().right <= el.closest('aside').getBoundingClientRect().right;
      }), 'Settings title must fit on one line in the sidebar');
      if (ui.data.tab === 'general') {
        assert.ok(await panel.locator('#settings-language').evaluate(el => {
          const label = el.firstElementChild;
          const control = el.querySelector('[role="combobox"]');
          return Boolean(label && control && label.scrollWidth <= label.clientWidth + 1);
        }), 'Display language text must fit beside or above its selector');
      }
      await ui.capture('large-font-actions');
      return;
    }
    // Browser regression for PR #11473: a native details element skipped the
    // motion frame. The unit search test checks scrolling, not real disclosure.
    if (ui.case === 'advanced-disclosure') {
      const trigger = panel.locator('button[aria-controls="settings-general-advanced"]');
      const content = page.locator('#settings-general-advanced');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await trigger.click();
      await content.evaluate(el => Promise.allSettled(el.getAnimations().map(animation => animation.finished)));
      const expandedHeight = (await content.boundingBox()).height;
      assert.ok(expandedHeight > 0);
      await trigger.click();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await content.getAttribute('inert'), '');
      const closing = await content.evaluate(el => {
        const animation = el.getAnimations().find(item => item.transitionProperty === 'grid-template-rows');
        if (!animation) return null;
        animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
        return el.getBoundingClientRect().height;
      });
      assert.ok(closing > 0 && closing < expandedHeight, `Expected an intermediate height, got ${closing} / ${expandedHeight}`);
      await content.evaluate(el => Promise.allSettled(el.getAnimations().map(animation => animation.finished)));
      const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
      await search.fill(await ui.t('settings.sections.gitSafety'));
      await page.locator('[id="settings-search-result-general.gitSafety"]').click();
      await page.waitForFunction(() => {
        const target = document.getElementById('settings-search-target-general-git-safety');
        const top = target?.getBoundingClientRect().top;
        return target?.classList.contains('settings-search-target-highlight') && top >= 0 && top < innerHeight;
      });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(await content.getAttribute('inert'), null);
      await ui.capture('advanced-search-target');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await trigger.click();
      assert.equal(await content.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      assert.equal(await content.evaluate(el => el.offsetHeight), 0);
      return;
    }
    // Browser regression for PR #11473: a SettingsLinkChip to the current tab
    // must reopen the group. Nav unit tests inject a route key and cannot prove
    // SettingsView forwards it or that the real collapse renders in-between frames.
    if (ui.data.groupDeepLink) {
      const group = page.locator('#settings-nav-connections');
      const tabs = page.locator('#settings-nav-connections-tabs');
      const remote = page.locator('#settings-tab-remote-control');
      const link = page.locator('#settings-fixture-deep-link').getByRole('button');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await remote.waitFor();
      const expandedHeight = (await tabs.boundingBox()).height;
      await group.click();
      assert.equal(await group.getAttribute('aria-expanded'), 'false');
      assert.equal(await remote.evaluate((el) => { el.focus(); return document.activeElement === el; }), false);
      const closing = await tabs.evaluate((el) => {
        const animation = el.getAnimations().find((item) => item.transitionProperty === 'grid-template-rows');
        if (!animation) return null;
        animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
        return el.getBoundingClientRect().height;
      });
      assert.ok(closing > 0 && closing < expandedHeight, `Expected an intermediate height, got ${closing} / ${expandedHeight}`);
      await page.waitForFunction(() => document.getElementById('settings-nav-connections-tabs')?.offsetHeight === 0);
      await link.click();
      await page.waitForFunction(() => document.getElementById('settings-search-target-remote-devices')
        ?.classList.contains('settings-search-target-highlight'));
      await remote.waitFor();
      assert.equal(await group.getAttribute('aria-expanded'), 'true');
      assert.equal(await remote.getAttribute('aria-selected'), 'true');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await group.click();
      assert.equal(await tabs.evaluate((el) => getComputedStyle(el).transitionDuration), '0s');
      await link.click();
      await remote.waitFor();
      assert.equal(await group.getAttribute('aria-expanded'), 'true');
      return;
    }
    if (ui.data.accountUsage) {
      // The normal account trigger is the entry point, including keyboard navigation.
      // Merely showing the main sidebar must not read usage or the billing ledger.
      const account = page.getByRole('button', { name: await ui.t('sidebar.user.moreLabel', { name: 'Preview' }) });
      const menu = page.getByRole('menu');
      const usage = menu.getByRole('menuitem').filter({ hasText: await ui.t('settings.tabs.usage') });
      const billing = menu.getByRole('menuitem').filter({ hasText: await ui.t('settings.tabs.billing') });
      const settings = menu.getByRole('menuitem', { name: await ui.t('sidebar.user.menuSettings'), exact: true });
      const cardBox = await account.locator('..').boundingBox();
      const accountLabel = await account.getByText('Preview', { exact: true }).boundingBox();
      const hasBilling = ui.data.cloud && !ui.data.organization;
      const checkMotion = ui.case === 'sidebar-usage';
      if (checkMotion) {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => {
          const frames = [];
          window.accountMenuFrames = frames;
          // Radix positions the panel before enabling its animation.
          new MutationObserver(() => {
            const menu = document.querySelector('[role="menu"]');
            if (menu) frames.push({ state: menu.getAttribute('data-state'), animation: getComputedStyle(menu).animationName,
              items: menu.querySelectorAll('[role="menuitem"]').length });
          }).observe(document.body, { attributes: true, attributeFilter: ['data-state', 'style'], childList: true, subtree: true });
        });
      }
      assert.deepEqual(await page.evaluate(() => window.usageReads), { history: 0, billing: 0, balance: 0 });
      await account.click();
      await usage.getByText(/24[.,]9k/i).waitFor();
      assert.ok((await usage.boundingBox()).y < (await settings.boundingBox()).y);
      if (hasBilling) {
        const balance = billing.getByText(ui.data.largeBalance ? /123\D?456[.,]78/ : /18[.,]42/);
        await balance.waitFor();
        assert.ok(await balance.evaluate(el => el.scrollWidth <= el.clientWidth), 'Available balance must fit in its column');
        assert.ok((await billing.boundingBox()).y < (await settings.boundingBox()).y);
        assert.equal(await page.evaluate(() => window.usageReads.balance), ui.data.legacyBalance ? 1 : 0);
      } else {
        assert.equal(await billing.count(), 0);
        assert.equal(await page.evaluate(() => window.usageReads.billing), 0);
        assert.equal(await page.evaluate(() => window.usageReads.balance), 0);
      }
      await menu.evaluate(el => Promise.allSettled(el.getAnimations().map(animation => animation.finished)));
      const menuBox = await menu.boundingBox();
      const menuLabel = await usage.getByText(await ui.t('settings.tabs.usage'), { exact: true }).boundingBox();
      assert.ok(Math.abs(menuBox.x - cardBox.x) <= 1 && Math.abs(menuBox.width - cardBox.width) <= 1,
        JSON.stringify({ menuBox, cardBox }));
      assert.ok(Math.abs(menuLabel.x - accountLabel.x) <= 1, JSON.stringify({ menuLabel, accountLabel }));
      const usageCaption = `${await ui.t('usageHistory.stats.todayTokens')} · ${await ui.t('usageHistory.device.self')}`;
      assert.ok(await usage.getByText(usageCaption, { exact: true }).evaluate(el => el.scrollWidth <= el.clientWidth));
      await ui.capture('account-usage');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      if (checkMotion) {
        const frames = await page.evaluate(() => window.accountMenuFrames);
        assert.ok(frames.some(frame => frame.state === 'open' && frame.animation === 'float-in'));
        assert.ok(frames.some(frame => frame.state === 'closed' && frame.animation === 'float-out'));
        assert.ok(frames.every(frame => frame.items === 3), JSON.stringify(frames));
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
      await account.press('Enter');
      if (checkMotion) {
        assert.equal(await menu.evaluate(el => getComputedStyle(el).animationDuration), '0s');
      }
      await usage.click();
      await page.locator('#settings-panel-usage').waitFor();
      await page.locator('#settings-nav-models').click();
      await page.waitForFunction(() => document.getElementById('settings-nav-models-tabs')?.getBoundingClientRect().height === 0);
      // A collapsed group must not remove the label of the still-open settings page.
      await page.getByRole('tabpanel', { name: await ui.t('settings.tabs.usage'), exact: true }).waitFor();
      assert.equal(await page.getByRole('tab', { name: await ui.t('settings.tabs.usage'), exact: true }).count(), 0);
      const back = page.getByRole('button', { name: await ui.t('settings.back'), exact: true });
      await back.click();
      await account.click();
      if (hasBilling) {
        await billing.click();
        await page.locator('#settings-panel-billing').waitFor();
        await back.click();
        await account.click();
      }
      await settings.click();
      await page.locator('#settings-panel-general').waitFor();
      return;
    }
    await panel.waitFor();
    assert.equal(await panel.getAttribute('id'), `settings-panel-${ui.data.tab}`);
    if (ui.data.layoutPreview) {
      const expected = ui.data.tab === 'general' ? 'settings.contentGroups.work' : 'settings.appearance.wallpaper.title';
      await panel.getByRole('heading', { name: await ui.t(expected), exact: true }).waitFor();
      if (ui.data.tab === 'general' && ui.platform === 'win32') {
        const startup = panel.getByRole('switch', { name: await ui.t('settings.windowBehavior.loginItem.label') });
        await startup.locator('xpath=self::*[not(@disabled)]').waitFor();
      }
      await ui.capture('settings-layout');
      if (ui.data.tab === 'general') {
        const away = panel.locator('section#settings-away-from-computer');
        const awayTitle = await ui.t('settings.sections.awayFromComputer');
        const heading = away.getByRole('heading', { name: awayTitle, exact: true });
        assert.equal(await away.evaluate(el => el.previousElementSibling?.id), 'settings-window-behavior');
        await page.getByRole('button', { name: await ui.t('settings.contentGroups.jump'), exact: true }).click();
        await page.getByRole('menuitem', { name: awayTitle, exact: true }).click();
        await heading.waitFor();
        await page.waitForFunction(() => document.activeElement ===
          document.querySelector('#settings-away-from-computer [data-settings-section-heading]'));

        const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
        await search.fill(await ui.t('settings.devices.keepAwake'));
        await page.locator('[id="settings-search-result-settings.devices.keepAwake"]').click();
        await away.locator('#settings-search-settings-devices-keepAwake.settings-search-target-highlight').waitFor();
        await ui.capture('away-from-computer');
      }
      return;
    }
    // Product regression: the opt-in must remain off until selected. Exercise the
    // real setting, search and local override; existing cases only read controls.
    if (ui.data.modelTokens) {
      const search = page.getByRole('combobox', { name: await ui.t('settings.search.ariaLabel') });
      await search.fill('token');
      const result = page.locator('#settings-search-result-settings\\.about\\.analyticsLabel');
      assert.ok((await result.innerText()).includes(await ui.t('settings.contentGroups.privacy')));
      await result.click();
      await page.waitForFunction(() => document.getElementById('settings-search-settings-about-analyticsLabel')
        ?.classList.contains('settings-search-target-highlight'));
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
    if (ui.data.tab === 'voice-input') {
      const breakdown = panel.getByText(await ui.t('settings.voiceInput.usage.costBreakdown', {
        asr: '$0.00', refine: '$0.00',
      }), { exact: true });
      assert.ok(await breakdown.evaluate(el => el.scrollWidth <= el.clientWidth), 'Voice input cost breakdown must fit');
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
