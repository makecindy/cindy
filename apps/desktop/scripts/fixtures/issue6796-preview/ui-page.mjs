import assert from 'node:assert/strict';
export default {
  name: 'issue6796-preview',
  entry: './preview.tsx',
  viewport: { width: 720, height: 1100 },
  real: 'UserMessage, BotGroupMessageAttachments, ChatImageView, ChatLoadingImage and ImageLightbox; no fixture CSS overrides',
  notCovered:
    'Live sending/storage, remote media transport, native copy/reveal, mobile and Windows',
  cases: {
    default: { about: 'Companion mixed and image-only long attachments' },
    boundaries: { about: 'Ratio above/equal 3, portrait, landscape and unchanged tool output' },
    shared: { about: 'Task and group attachment, including 180px container' },
    replacement: { about: 'Replace long image with ordinary portrait after loading' },
  },
  async ready(page) {
    await page.waitForFunction(
      () =>
        document.querySelectorAll('img[data-gallery-src]').length > 0 &&
        [...document.querySelectorAll('img[data-gallery-src]')].every(
          (i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().height > 0,
        ),
    );
  },
  async check(page, ui) {
    const imgs = page.locator('img[data-gallery-src]');
    for (const image of await imgs.all()) {
      const data = await image.evaluate((i) => ({
        w: i.getBoundingClientRect().width,
        h: i.getBoundingClientRect().height,
        nw: i.naturalWidth,
        nh: i.naturalHeight,
        fit: getComputedStyle(i).objectFit,
        hint: i.getAttribute('aria-describedby'),
        alt: i.alt,
      }));
      const long = data.nh / data.nw > 3 && data.alt !== 'tool.png';
      assert.equal(Boolean(data.hint), long);
      if (long) {
        assert.equal(data.fit, 'cover');
        assert(data.w <= 240);
        assert(Math.abs(data.w - data.h) < 1);
      } else assert.equal(data.fit, 'contain');
    }
    if (ui.case === 'replacement') {
      await page.getByRole('button', { name: 'Switch sample' }).click();
      await page.waitForFunction(
        () => document.querySelector('img[data-gallery-src]').naturalHeight === 2400,
      );
      assert.equal(await imgs.first().getAttribute('aria-describedby'), null);
      await ui.capture('ordinary-replacement');
      return;
    }
    if (ui.case !== 'default') return;
    const trigger = imgs.first();
    const src = await trigger.getAttribute('src');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('img:not([data-gallery-src])')].some(
        (i) => i.naturalHeight === 6000,
      ),
    );
    const original = page.locator('img:not([data-gallery-src])').filter({ visible: true }).first();
    assert.equal(await original.getAttribute('src'), src);
    assert.equal(await original.evaluate((i) => i.naturalHeight), 6000);
    await ui.capture('full-original');
    await page.keyboard.press('+');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('img:not([data-gallery-src])')].some(
        (i) =>
          i.parentElement.style.transform.includes('scale(') &&
          !i.parentElement.style.transform.includes('scale(1)'),
      ),
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-gallery-src'));
  },
};
