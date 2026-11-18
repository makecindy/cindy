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
    // #11277 review: the last visible source cannot be hidden (Swift panel parity); its switch shakes.
    const sourceSwitches = page.locator('.manage-source input[type=checkbox]');
    const sourceCount = await sourceSwitches.count();
    for (let i = 0; i < sourceCount - 1; i++) await sourceSwitches.nth(i).uncheck();
    await sourceSwitches.nth(sourceCount - 1).click();
    if (!await sourceSwitches.nth(sourceCount - 1).isChecked()) throw new Error('The last visible source was hidden');
    if (await page.locator('.manage-source input[data-shake=true]').count() !== 1) throw new Error('The last source did not refuse with a shake');
    for (let i = 0; i < sourceCount - 1; i++) await sourceSwitches.nth(i).check();
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
    // A window reloaded while hidden never paints, so image decoding never settles there; the
    // card must still report itself ready, or hovering cannot open it.
    await page.evaluate(() => {
      window.__decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = () => new Promise(() => {});
      delete document.documentElement.dataset.quotaPainted;
      window.dispatchEvent(new Event('fixture-tray-show'));
      window.dispatchEvent(new Event('fixture-tray-hide'));
    });
    await page.locator('html[data-quota-painted=true]').waitFor({ timeout: 3000 })
      .catch(() => { throw new Error('Card never became ready while images could not decode'); });
    await page.evaluate(() => { HTMLImageElement.prototype.decode = window.__decode; });
    const selected = page.locator('.tabs button[aria-pressed=true]');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-toggle-unread')));
    await page.locator('.tabs button:nth-child(2)[aria-pressed=true]').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-toggle-unread')));
    await page.locator('.tabs button:first-child[aria-pressed=true]').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-tray-show')));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const liquid = page.locator('.tube i').first();
    const animation = () => liquid.evaluate(el => getComputedStyle(el).animationName);
    // The surface is drawn per frame like the Swift panel's: flat while hidden, sloshing on opening.
    const surfaceIs = (flat, same, failure) => page.waitForFunction(
      ([flat, same]) => (document.querySelector('.tube path')?.getAttribute('d') === flat) === same,
      [flat, same], { timeout: 3000 }).catch(() => { throw new Error(failure); });
    let flat = '';
    for (let opening = 0; opening < 2; opening++) {
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-tray-hide')));
      await page.locator('.panel[data-visible=false]').waitFor();
      if (await animation() !== 'none') throw new Error('Hidden liquid started animating');
      flat = await page.locator('.tube path').first().getAttribute('d');
      if (!flat) throw new Error('Hidden liquid has no surface');
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-tray-show')));
      await page.locator('.panel[data-visible=true]').waitFor();
      if (await animation() !== 'quota-rise') throw new Error('Liquid entrance missing');
      await surfaceIs(flat, false, 'Liquid surface stayed flat while opening');
    }
    // Pages slide like the Swift panel's: the one being left stays until it has moved out.
    await page.locator('.source').first().click();
    await page.locator('.page[data-leaving][data-kind=main]').waitFor().catch(() => { throw new Error('Overview did not slide out'); });
    // A fifth of the way in, the page being left must already be mostly gone, or the two overlap.
    const lingering = await page.locator('.page[data-leaving]').evaluate(el => {
      const [slide] = el.getAnimations();
      slide.pause();
      slide.currentTime = 100;
      const opacity = Number(getComputedStyle(el).opacity);
      slide.play();
      return opacity;
    });
    if (!(lingering < 0.5)) throw new Error('Overview lingers over the detail page: opacity ' + lingering);
    await page.locator('.page[data-leaving]').waitFor({ state: 'detached' });
    if (!await page.locator('.rings').isVisible()) throw new Error('Detail did not replace the overview');
    await page.getByRole('button', { name: await ui.t('menubar.ui.back'), exact: true }).click();
    await page.locator('.page[data-leaving][data-kind=sub]').waitFor().catch(() => { throw new Error('Detail did not slide out'); });
    await page.locator('.page[data-leaving]').waitFor({ state: 'detached' });
    if (await page.locator('.page').count() !== 1 || !await liquid.isVisible()) throw new Error('Overview did not return');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (await animation() !== 'none') throw new Error('Reduced motion still animates liquid');
    await surfaceIs(flat, true, 'Reduced motion still waves the liquid');
    await page.locator('.tabs button:nth-child(3)').click();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-toggle-unread')));
    await page.locator('.tabs button:first-child small').waitFor({ state: 'detached' });
    if (await selected.textContent() !== await ui.t('menubar.ui.tabUsage')) throw new Error('Visible tray changed tabs');
  },
};
