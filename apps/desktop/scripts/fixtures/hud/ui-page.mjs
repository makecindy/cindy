export default {
  name: 'hud',
  entry: './hud-fixture.tsx',
  viewport: { width: 685, height: 1100 },
  real: 'HudChrome, HudSection, shared shortcut editor and HUD styles',
  notCovered:
    'Native window, system shortcuts, capture permissions, full LayoutRoot (nested pane DOM is a fixture)',
  cases: {
    default: { about: 'HUD settings', data: {} },
    entry: { about: 'Normal titlebar HUD entry and hover' },
    settings: { about: 'HUD settings' },
    chrome: { about: 'Localized screen controls, settings overlay and custom shortcut' },
    'chrome-no-quota': { about: 'Localized unavailable weekly quota beside screen control and truncated path' },
    'nested-panes': { about: 'Retain docked pane DOM while giving all space to chat' },
  },
  async check(page, ui) {
    if (ui.case === 'entry') {
      const button = page.getByRole('button', { name: await ui.t('hud.enter'), exact: true });
      await button.hover();
      await page.waitForTimeout(180);
      const color = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
      if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent')
        throw new Error('HUD hover must show the titlebar hover background');
      await ui.capture('hover');
    }
    if (ui.case.startsWith('chrome')) {
      await page
        .getByRole('checkbox', { name: await ui.t('hud.thisScreen'), exact: true })
        .waitFor();
      const controls = page.locator('.hud-screen-control');
      const quota = page.locator('.hud-weekly-quota');
      const path = page.locator('.hud-path-chip');
      const [screenBox, quotaBox, pathBox] = await Promise.all([
        controls.boundingBox(), quota.boundingBox(), path.boundingBox(),
      ]);
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      if (!screenBox || !quotaBox || !pathBox || pathBox.width < 24 ||
          screenBox.x + screenBox.width > quotaBox.x + 1 ||
          quotaBox.x + quotaBox.width > pathBox.x + 1 ||
          pathBox.x + pathBox.width > viewportWidth)
        throw new Error('Screen control, weekly quota and path must fit in order without overlap');
      // Compare rendered text rather than container centers: an inline child can
      // inherit a larger anonymous line box and drift even inside a centered row.
      const textTops = await page.locator('.hud-composer-meta-row').evaluate((row) => {
        return ['.hud-screen-control', '.hud-weekly-quota', '.hud-path-chip'].map((selector) => {
          const walker = document.createTreeWalker(row.querySelector(selector), NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            return range.getBoundingClientRect().top;
          }
          throw new Error(`Missing metadata text: ${selector}`);
        });
      });
      if (Math.max(...textTops) - Math.min(...textTops) > 0.5)
        throw new Error(`HUD metadata text must align vertically: ${textTops.join(', ')}`);
      const quotaText = await quota.innerText();
      if (ui.case === 'chrome-no-quota'
          ? quotaText !== await ui.t('hud.weeklyUnavailable')
          : !quotaText.includes('61%'))
        throw new Error('Inline weekly quota must be localized');
      const pointer = page.getByRole('button', {
        name: await ui.t('hud.passThrough'),
        exact: true,
      });
      await pointer.hover();
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      if (!(await tooltip.innerText()).includes('F12'))
        throw new Error('HUD tooltip must show the configured shortcut in every locale');
      await page.mouse.move(0, 100);
      await ui.capture('screen-controls');
      await page
        .getByRole('button', { name: await ui.t('hud.settingsAction'), exact: true })
        .click();
      await page
        .getByRole('region', { name: await ui.t('hud.settingsAction'), exact: true })
        .waitFor();
      const overlay = page.locator('.hud-settings-overlay');
      const text = await overlay.innerText();
      if (text.includes('{{screenAction}}') || !text.includes(await ui.t('hud.thisScreen')))
        throw new Error('Screen permission hint must use the localized checkbox label');
      await ui.capture('settings-overlay');
    }
    if (ui.case === 'nested-panes') {
      for (const kind of ['tab-group:top', 'tab-group:left']) {
        if (await page.locator(`[data-panel-drag-root="${kind}"]`).isVisible())
          throw new Error(`HUD still shows ${kind}`);
      }
      const chat = await page.getByTestId('hud-chat').boundingBox();
      const layout = await page.getByTestId('hud-layout').boundingBox();
      if (!chat || !layout || chat.height < layout.height - 40 || chat.width < layout.width - 2)
        throw new Error('HUD chat must fill the retained layout');
    }
  },
};
