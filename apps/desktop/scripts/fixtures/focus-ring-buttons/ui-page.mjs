import assert from 'node:assert/strict';

export default {
  name: 'focus-ring-buttons',
  entry: './fixture.tsx',
  viewport: { width: 520, height: 260 },
  real: 'Toast (persistent notice with its top-right close icon), PreviewButton from PreviewChrome, globals.css focus suppression and theme tokens',
  notCovered: 'Toast queue timing, the full attachment preview panel and other buttons that received the same focus-ring fix',
  cases: {
    default: { about: 'Tab onto the top-right × of a persistent Toast' },
    'preview-button': { about: 'Tab onto the attachment preview header icon button' },
  },
  async check(page, ui) {
    const target =
      ui.case === 'default'
        ? page.locator('button[aria-label="Later"].absolute')
        : page.getByRole('button', { name: 'Download' });
    // 用键盘 Tab 聚焦,才会命中 :focus-visible。
    for (let i = 0; i < 6 && !(await target.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    assert.equal(await target.evaluate((el) => el === document.activeElement), true, 'target receives keyboard focus');
    const style = await target.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { outline: computed.outlineStyle, shadow: computed.boxShadow, focusVisible: el.matches(':focus-visible') };
    });
    assert.equal(style.focusVisible, true);
    // globals.css 压掉 outline;焦点只能由 box-shadow 焦点圈画出来(DESIGN.md §14.2)。
    assert.equal(style.outline, 'none');
    assert.notEqual(style.shadow, 'none', 'keyboard focus draws a ring');
  },
};
