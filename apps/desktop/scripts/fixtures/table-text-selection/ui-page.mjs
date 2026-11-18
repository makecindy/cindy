import assert from 'node:assert/strict';

// Batfree feedback: distinguish native selection truncation from clipboard
// truncation through the real Desktop renderer/handlers. Unit DOM ranges cannot
// reproduce Chromium mouse selection across table/overflow boundaries. E2E:
// prose + a 2x3 table + trailing prose is the smallest complete copy scenario.
const content = 'Before the table\n\n| Name | Value | Note |\n| --- | --- | --- |\n| Alpha | 42 | First |\n| Beta | 7 | Final |\n\nAfter the table';

export default {
  name: 'table-text-selection',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 520 },
  real: 'MarkdownRenderer, native mouse selection, assistant/chat clipboard handlers, MessageActionBar and SelectionQuoteButton',
  notCovered: 'Full application, platform-specific native window menus and mobile native text views. Range copy uses OS paste; whole-message writes are captured at navigator.clipboard because hidden windows cannot obtain clipboard-write permission.',
  cases: { default: { about: 'Copy and quote text across every table cell and both surrounding paragraphs', data: { content } } },
  async check(page, ui) {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const paste = page.getByRole('textbox', { name: 'Paste target' });
    const point = async (text, end) => page.getByText(text, { exact: true }).evaluate((node, end) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const leaves = [];
      while (walker.nextNode()) leaves.push(walker.currentNode);
      const leaf = end ? leaves.at(-1) : leaves[0];
      const range = document.createRange();
      range.selectNodeContents(leaf);
      const rects = [...range.getClientRects()];
      const rect = end ? rects.at(-1) : rects[0];
      return { x: end ? rect.right - 0.1 : rect.left + 0.1, y: rect.top + rect.height / 2 };
    }, end);
    const select = async (from, to) => {
      const start = await point(from, false);
      const end = await point(to, true);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 16 });
      await page.mouse.up();
      return page.evaluate(() => getSelection().toString());
    };
    const copyAndPaste = async () => {
      await page.keyboard.press(`${modifier}+c`);
      await paste.fill('');
      await paste.focus();
      await page.keyboard.press(`${modifier}+v`);
      return paste.inputValue();
    };

    const selected = await select('Before the table', 'After the table');
    for (const text of ['Before the table', 'Name', 'Alpha', '42', 'First', 'Beta', '7', 'Final', 'After the table']) {
      assert.ok(selected.includes(text), `Native selection must include ${text}`);
    }
    await ui.capture('cross-table-selection');
    assert.equal(await copyAndPaste(), selected, 'Clipboard must retain the complete cross-table selection');

    const cells = await select('Alpha', 'Final');
    for (const text of ['Alpha', '42', 'First', 'Beta', '7', 'Final']) assert.ok(cells.includes(text));
    assert.equal(await copyAndPaste(), cells, 'Cross-cell clipboard must match the native range');

    const word = await point('Alpha', false);
    await page.mouse.dblclick(word.x + 4, word.y);
    assert.equal(await page.evaluate(() => getSelection().toString()), 'Alpha');
    assert.equal(await copyAndPaste(), 'Alpha', 'Local cell selection must still copy just that word');

    await select('Before the table', 'After the table');
    await page.getByRole('button', { name: await ui.t('chat.quote.addToChat'), exact: true }).click();
    const draft = await page.locator('[data-quote-draft]').textContent();
    for (const text of ['Before the table', 'Alpha', 'Final', 'After the table']) assert.ok(draft.includes(text));

    // Whole-message Copy writes Markdown directly, independent of native ranges.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { document.documentElement.dataset.copiedMessage = text; } },
    }));
    await page.getByRole('button', { name: await ui.t('chat.messageActionBar.copy'), exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.copiedMessage), content);
  },
};
