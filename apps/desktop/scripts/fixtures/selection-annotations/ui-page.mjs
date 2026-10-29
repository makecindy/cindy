import assert from 'node:assert/strict';
import companion from '../companion-composer/ui-page.mjs';

export default {
  name: 'selection-annotations',
  entry: './selection-annotations-fixture.tsx',
  viewport: { width: 760, height: 640 },
  real: 'SelectionQuoteButton, QuoteCommentEditor, ChatInput, Tiptap quote nodes, draft store, quote serialization and history chips',
  notCovered: 'Real Agent delivery, native context menu, Mobile native selection and cross-device transport. Send success/failure is simulated by the fixture callback.',
  stubs: companion.stubs,
  cases: {
    default: { about: 'Collect, edit, cancel, delete, switch tasks, recover a failed send and inspect history' },
    narrow: { about: 'The same annotation workflow in a narrow window', viewport: { width: 360, height: 640 } },
  },
  async ready(page) { await page.locator('.ProseMirror').waitFor(); },
  async check(page, ui) {
    const editor = page.locator('.ProseMirror');
    const quoteNodes = () => editor.locator('[data-composer-quote]');
    const button = async (key) => page.getByRole('button', { name: await ui.t(`chat.quote.${key}`), exact: true });
    const select = async (id) => {
      await page.getByTestId(id).evaluate((node) => {
        const range = document.createRange(); range.selectNodeContents(node);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await (await button('addToChat')).click();
      await page.getByRole('textbox', { name: await ui.t('chat.quote.comment') }).waitFor();
    };
    const comment = () => page.locator('textarea');
    await select('first');
    await comment().fill('Clarify this.\n\n请补充例子。');
    assert.equal(await page.getByTestId('attempts').textContent(), '0');
    assert.equal(await quoteNodes().count(), 0);
    assert.equal(await page.evaluate(() => CSS.highlights.has('cindy-selection-quote')), true);
    await page.getByTestId('first').evaluate(node => { node.textContent += ' Streamed continuation.'; });
    await page.waitForFunction(() => [...CSS.highlights.get('cindy-selection-quote')][0]?.toString().includes('原文与意见一起保留。'));
    // Match the streaming-to-final Markdown subtree replacement while keeping
    // the outer message body mounted. The restored Range must use live nodes.
    await page.getByTestId('first').evaluate(node => { node.replaceWith(node.cloneNode(true)); });
    await page.waitForFunction(() => {
      const range = [...CSS.highlights.get('cindy-selection-quote')][0];
      return range?.startContainer.isConnected && range.toString().includes('原文与意见一起保留。');
    });
    assert.equal(await page.getByRole('dialog').textContent().then(text => text.includes('Streamed continuation.')), false);
    await ui.capture('selection-comment');
    await (await button('confirm')).click();
    assert.equal(await editor.evaluate((node) => node.contains(document.activeElement)), false);
    await select('second');
    await (await button('confirm')).click();
    assert.equal(await quoteNodes().count(), 2);
    await quoteNodes().first().getByRole('button').click();
    await comment().fill('discard this');
    await (await button('cancel')).click();
    await quoteNodes().first().getByRole('button').click();
    assert.equal(await comment().inputValue(), 'Clarify this.\n\n请补充例子。');
    await comment().fill('Edited comment\n');
    await (await button('save')).click();
    await quoteNodes().last().getByRole('button').click();
    await (await button('remove')).click();
    assert.equal(await quoteNodes().count(), 1);
    await select('second');
    await (await button('confirm')).click();
    await page.getByTestId('task-b').click();
    await page.waitForFunction(() => !document.querySelector('.ProseMirror [data-composer-quote]'));
    await page.getByTestId('task-a').click();
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror [data-composer-quote]').length === 2);
    await ui.capture('collected-draft');
    assert.equal(await page.getByTestId('attempts').textContent(), '0');
    await page.getByTestId('fail-next').click();
    const send = page.getByRole('button', { name: await ui.t('newChat.sendButton.send'), exact: true });
    await send.click();
    await page.waitForFunction(() => document.querySelector('[data-testid=attempts]')?.textContent === '1');
    assert.equal(await quoteNodes().count(), 2);
    await send.click();
    await page.waitForFunction(() => document.querySelector('[data-testid=attempts]')?.textContent === '2');
    await page.getByTestId('history').getByRole('button').first().click();
    assert.match(await page.getByRole('dialog').textContent(), /Edited comment/);
    await ui.capture('history-comment');
  },
};
