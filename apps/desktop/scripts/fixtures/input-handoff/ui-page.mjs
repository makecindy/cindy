import assert from 'node:assert/strict';

import QRCode from 'qrcode';
import sharp from 'sharp';

const url = 'https://example.test/verify/synthetic';
const jpeg = await sharp(await QRCode.toBuffer(url, { width: 448, margin: 4 })).jpeg({ quality: 94 }).toBuffer();

export default {
  name: 'input-handoff', entry: './fixture.tsx', viewport: { width: 720, height: 600 },
  real: 'InputHandoffCard, InputHandoffDialog, scan view, form, translations and themes',
  notCovered: 'Native target extraction, secure transport and mobile sheets',
  cases: {
    verification: { about: 'Provider verification opens a scannable card in the task', data: {
      picture: { mime: 'image/jpeg', width: 448, height: 448, data: jpeg.toString('base64'), qr: { text: url, url } },
    } },
    default: { about: 'Short account and password form', data: { count: 2 } },
    long: { about: 'Forty fields scroll without hiding the Continue button', data: { count: 40 } },
    description: { about: 'Maximum purpose and note leave fields and Continue reachable', data: { count: 2, description: true } },
  },
  async check(page, ui) {
    const dialog = page.getByTestId('input-handoff-dialog');
    await dialog.waitFor();
    if (ui.case === 'verification') {
      const image = dialog.getByRole('img');
      await image.waitFor();
      for (const target of [image, dialog.getByRole('button', { name: /example\.test/ })]) {
        const visible = await target.evaluate(element => new Promise(resolve => {
          const observer = new IntersectionObserver(([entry]) => { observer.disconnect(); resolve(entry.intersectionRatio); });
          observer.observe(element);
        }));
        assert(visible > 0.99, 'The complete QR code and verification link must be visible before any scroll');
      }
      await dialog.getByRole('button', { name: await ui.t('antigravityVerification.refresh') }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: await ui.t('inputHandoff.qr.copyLink') }).count(), 0);
      await ui.capture('scan');
      return;
    }
    const button = page.locator('[data-input-handoff-continue]');
    const before = await button.boundingBox();
    const inputs = page.locator('[data-input-handoff-field]');
    await inputs.last().focus();
    const after = await button.boundingBox();
    const last = await inputs.last().boundingBox();
    assert(before && after && last);
    assert(Math.abs(before.y - after.y) < 1, 'Continue stays fixed while the fields scroll');
    assert(last.y >= 0 && last.y + last.height <= after.y, 'Focused final field is visible above Continue');
    assert(after.y + after.height <= await page.evaluate(() => window.innerHeight), 'Continue stays inside the window');
    await dialog.getByRole('heading').scrollIntoViewIfNeeded();
    await ui.capture('details');
    const detailsButton = await button.boundingBox();
    assert(detailsButton && Math.abs(detailsButton.y - before.y) < 1, 'Continue stays fixed while reading the description');
    await inputs.first().focus();
  },
};
