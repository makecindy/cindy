import assert from 'node:assert/strict';

export default {
  name: 'font-scale-notices',
  entry: './fixture.tsx',
  viewport: { width: 520, height: 1000 },
  real: 'ErrorNotice (message, description, expanded details), DownloadToast with its expanded transfer list, Toast, Popover, applyFontSettings and theme tokens',
  notCovered: 'Real transfers, error recovery actions, settings persistence and the full Desktop window; font size is applied through applyFontSettings',
  cases: {
    default: { about: 'Default UI font size (14): ratio line heights render the same 20px rows as before' },
    'ui-24': { about: 'Largest UI font size (24): multi-line text keeps its line spacing instead of packing into fixed 20px rows' },
  },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw') }).click();
    await page.locator('[data-download-toast] button[aria-haspopup="dialog"]').click();
    await page.getByRole('dialog').waitFor();
    const metrics = await page.evaluate(() => {
      const measure = (el) => {
        const style = getComputedStyle(el);
        return { fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
      };
      const notice = document.querySelector('[data-font-scale-error]');
      const [message, description] = notice.querySelectorAll('.min-w-0.flex-1 > div');
      const details = notice.querySelector('pre');
      const transfer = document.querySelector('[role="dialog"] li .break-words');
      return { message: measure(message), description: measure(description), details: measure(details), transfer: measure(transfer) };
    });
    // 默认字号下的字号(text-13 / text-12);UI 字号 24 时按 24 / 14 缩放并取整。
    const base = { message: 13, description: 12, details: 12, transfer: 13 };
    for (const [part, { fontSize, lineHeight }] of Object.entries(metrics)) {
      const expectedFont = ui.case === 'ui-24' ? Math.round((base[part] * 24) / 14) : base[part];
      assert.equal(fontSize, expectedFont, `${part} font size`);
      // 默认字号保持原来的 20px 行;放大后行高随字号等比增长,不再固定在 20px。
      const expectedLine = (20 * fontSize) / base[part];
      assert(Math.abs(lineHeight - expectedLine) <= 0.5, `${part}: ${lineHeight}px line for ${fontSize}px text, expected ≈${expectedLine.toFixed(1)}px`);
    }
  },
};
