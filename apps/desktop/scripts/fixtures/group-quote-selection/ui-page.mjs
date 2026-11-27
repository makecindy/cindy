import assert from 'node:assert/strict';

export default {
  name: 'group-quote-selection',
  entry: './fixture.tsx',
  viewport: { width: 600, height: 360 },
  real: 'Sent quote block, group timeline copy handler, native selection and clipboard paste',
  notCovered: 'Group history loading; the fixture counts requests to locate the original.',
  cases: { default: { about: 'Select and paste part of a quote without following it' } },
  async check(page, ui) {
    const quote = page.getByTestId('bot-group-quote');
    const text = quote.getByText('周六早上 Android 发版');
    const paste = page.getByRole('textbox', { name: 'Paste' });
    const jumps = page.locator('output');
    // Derive caret positions from the rendered font in either theme.
    const caret = (locator, offset) => locator.evaluate((el, offset) => {
      const range = document.createRange();
      range.setStart(el.firstChild, offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return [rect.x, rect.y + rect.height / 2];
    }, offset);
    const start = await caret(text, 2);
    const end = await caret(text, 4);
    const word = await caret(text, 8);
    const author = await caret(quote.getByText('Ada'), 1);

    async function checkPaste(expected) {
      // Let a mistaken deferred single-click run before moving focus.
      await page.clock.runFor(1000);
      assert.equal(await jumps.textContent(), '0', 'selection must stay at the quote');
      assert.equal(await page.evaluate(() => getSelection().toString()), expected);
      await page.keyboard.press('ControlOrMeta+c');
      await paste.fill('');
      await paste.focus();
      await page.keyboard.press('ControlOrMeta+v');
      assert.equal(await paste.inputValue(), expected);
    }
    await page.clock.install();
    for (const [from, to, expected] of [
      [start, end, '早上'], [end, start, '早上'], [author, end, 'da\n周六早上'],
    ]) {
      await page.mouse.move(...from);
      await page.mouse.down();
      await page.mouse.move(...to, { steps: 8 });
      await page.mouse.up();
      await checkPaste(expected);
    }
    await page.mouse.dblclick(...word);
    await ui.capture('selected-word');
    await checkPaste('Android');
    await page.mouse.click(...word);
    await page.clock.runFor(1000);
    assert.equal(await jumps.textContent(), '1', 'single click locates the original once');
    await quote.press('Enter');
    await quote.press('Space');
    assert.equal(await jumps.textContent(), '3', 'keyboard activation is immediate');
  },
};
