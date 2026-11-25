import assert from 'node:assert/strict';
export default {
  name: 'message-annotations', entry: './fixture.tsx', viewport: { width: 780, height: 560 },
  real: 'SelectionQuoteButton, MessageAnnotations, rendered text anchors and CSS highlights',
  notCovered: 'SQLite persistence, real plugin installation, model sending, remote tasks and fork/export',
  cases: { default: { about: 'Select a repeated phrase, write a reply and reopen its numbered highlight' } },
  async ready(page) { await page.locator('[data-annotation-message]').waitFor(); },
  async check(page, ui) {
    await page.evaluate(() => {
      const node = document.querySelector('[data-test-second]').firstChild;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, node.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const add = page.getByRole('button', { name: await ui.t('chat.annotations.add'), exact: true });
    await add.waitFor();
    assert.equal(await add.count(), 1);
    await ui.capture('selection');
    await add.click();
    const input = page.getByRole('textbox');
    await input.fill('请展开第二处，说明这一步具体怎样验证。');
    await input.press('Alt+Enter');
    await input.press('End');
    await page.keyboard.insertText('也请说明失败时的处理方式。');
    assert.equal(await input.inputValue(), '请展开第二处，说明这一步具体怎样验证。\n也请说明失败时的处理方式。');
    // IME confirmation must not submit a draft.
    await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    assert.equal(await page.getByRole('dialog').count(), 1);
    await ui.capture('editing');
    await input.press('Enter');
    const badge = page.getByRole('button', { name: await ui.t('chat.annotations.open', { number: 1 }) });
    await badge.waitFor();
    await badge.click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByText('请展开第二处，说明这一步具体怎样验证。 也请说明失败时的处理方式。', { exact: true }).count(), 1);
  },
};
