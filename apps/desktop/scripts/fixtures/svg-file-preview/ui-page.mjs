import assert from 'node:assert/strict';

// SVG files formerly opened as XML. Browser integration checks real decoding,
// default visibility and source switching, which jsdom cannot establish.
export default {
  name: 'svg-file-preview',
  entry: './fixture.tsx',
  cases: { default: { about: 'SVG defaults to an image and retains source access' }, 'source-scroll': { about: 'Reopening a rendered SVG retains the source reading position' } },
  viewport: { width: 800, height: 600 },
  real: 'FileBodyView, ImagePreview, PlaintextEditor, translations and theme',
  notCovered: 'Electron filesystem reads, remote transport and native mobile decoding',
  async ready(page) {
    await page.locator('.cm-editor').waitFor({ state: 'attached' });
  },
  async check(page, ui) {
    if (ui.case === 'source-scroll') {
      const uiSource = await ui.t('attachmentPreview.source');
      const sourceButton = () => page.getByRole('button', { name: uiSource, exact: true });
      await sourceButton().click();
      const scroller = page.locator('.cm-scroller');
      await scroller.evaluate(el => { el.scrollTop = 1500; el.dispatchEvent(new Event('scroll')); });
      await page.waitForFunction(() => document.querySelector('.cm-scroller')?.scrollTop > 1400);
      await page.getByRole('button', { name: 'Reopen SVG', exact: true }).click();
      // Restoration completes after eight animation frames. Stay in image mode
      // longer than that before revealing the editor, as a reader would.
      await page.evaluate(() => new Promise(resolve => {
        let frames = 16;
        const tick = () => --frames ? requestAnimationFrame(tick) : resolve();
        requestAnimationFrame(tick);
      }));
      await sourceButton().click();
      assert(await scroller.evaluate(el => el.scrollTop > 1400), 'source reading position survived image-mode reopen');
      await page.getByRole('button', { name: await ui.t('attachmentPreview.rendered'), exact: true }).click();
      await sourceButton().click();
      assert(await scroller.evaluate(el => el.scrollTop > 1400), 'source reading position survived preview toggle');
      return;
    }
    const image = page.getByRole('img', { name: 'sample.svg', exact: true });
    assert(await image.isVisible());
    await page.waitForFunction(() => [...document.images].some((img) => img.naturalWidth === 480));
    await page.getByRole('button', { name: await ui.t('attachmentPreview.source'), exact: true }).click();
    assert(await page.locator('.cm-editor').isVisible());
    assert.equal(await image.count(), 0);
    await page.getByRole('button', { name: await ui.t('attachmentPreview.rendered'), exact: true }).click();
    await image.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.cm-editor').isVisible(), false);
  },
};
