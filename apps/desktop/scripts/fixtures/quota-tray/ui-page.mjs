export default {
  name: 'quota-tray',
  entry: './fixture.tsx',
  viewport: { width: 332, height: 700 },
  real: 'QuotaTray, its settings/detail/usage pages, shared presentation contract and buildMenubarView',
  notCovered: 'OS tray hover, native window positioning, persisted user settings and Swift rendering',
  cases: { default: { about: 'Eight unread tasks, default clipping, settings, provider details and usage navigation' } },
  async check(page, ui) {
    await page.locator('html[data-quota-painted=true]').waitFor();
    const natural = Number(await page.locator('html').getAttribute('data-quota-natural-height'));
    await page.setViewportSize({ width: 332, height: Math.ceil(natural) });
    const count = await page.locator('.task-row').count();
    if (count < 2 || count > 3) throw new Error('Default task limit was lost');
    if (!await page.locator('main').evaluate(element => element.scrollHeight <= element.clientHeight + 1)) {
      throw new Error('Default overview needs scrolling');
    }
    if (!await page.locator('.open-app svg').isVisible()) throw new Error('Missing footer brand mark');
    await ui.capture('overview');
    await page.locator('.more').click();
    if (await page.locator('.task-row').count() !== 8) throw new Error('All tasks did not expand');
    await page.locator('.more').click();
    await page.getByRole('button', { name: await ui.t('menubar.ui.settings'), exact: true }).click();
    await page.getByRole('switch', { name: await ui.t('menubar.ui.privacy'), exact: true }).check();
    await page.locator('select').selectOption('local');
    await ui.capture('manage');
    await page.getByRole('button', { name: await ui.t('menubar.ui.done'), exact: true }).click();
    await page.locator('.source').first().click();
    await page.locator('.rings').waitFor();
    await ui.capture('detail');
    await page.getByRole('button', { name: await ui.t('menubar.ui.back'), exact: true }).click();
    await page.getByRole('button', { name: await ui.t('menubar.ui.expandUsage'), exact: true }).click();
    await page.getByRole('button', { name: await ui.t('menubar.ui.range7'), exact: true }).click();
    await ui.capture('usage');
    await page.getByRole('button', { name: await ui.t('menubar.ui.listTasks'), exact: true }).click();
    await page.locator('.usage-page .task-row').click();
    if (await page.locator('html').getAttribute('data-opened-session') !== 'usage-task') {
      throw new Error('Usage task did not open its session');
    }
    // Reopening must already have a measured overview, with no loading flash.
    await page.evaluate(() => {
      delete document.documentElement.dataset.quotaPainted;
      window.dispatchEvent(new Event('fixture-tray-hide'));
    });
    await page.locator('html[data-quota-painted=true]').waitFor();
    if (!await page.locator('.open-app').isVisible() || await page.locator('progress').count()) {
      throw new Error('Hidden tray did not prewarm its overview');
    }
    const selected = page.locator('.tabs button[aria-pressed=true]');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-toggle-unread')));
    await page.locator('.tabs button:nth-child(2)[aria-pressed=true]').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-toggle-unread')));
    await page.locator('.tabs button:first-child[aria-pressed=true]').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-tray-show')));
    await page.locator('.tabs button:nth-child(3)').click();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-toggle-unread')));
    await page.locator('.tabs button:first-child small').waitFor({ state: 'detached' });
    if (await selected.textContent() !== await ui.t('menubar.ui.tabUsage')) throw new Error('Visible tray changed tabs');
  },
};
