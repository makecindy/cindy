import assert from 'node:assert/strict';

// SVG files formerly opened as XML. Browser integration checks real decoding,
// default visibility and source switching, which jsdom cannot establish.
export default {
  name: 'svg-file-preview',
  entry: './fixture.tsx',
  cases: { default: { about: 'SVG defaults to an image and retains source access' } },
  viewport: { width: 800, height: 600 },
  real: 'FileBodyView, ImagePreview, PlaintextEditor, translations and theme',
  notCovered: 'Electron filesystem reads, remote transport and native mobile decoding',
  async ready(page) {
    await page.locator('.cm-editor').waitFor({ state: 'attached' });
  },
  async check(page, ui) {
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
