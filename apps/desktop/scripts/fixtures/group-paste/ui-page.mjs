import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';

const text = Array.from({ length: 66 }, (_, i) => `line ${i + 1}: preserve the complete pasted text`).join('\n');
export default {
  ...group,
  name: 'group-paste',
  entry: '../group-control/group-control-fixture.tsx',
  cases: {
    default: { about: 'Group long paste uses the private chat chip and editable preview', data: { name: 'Long paste', members: [{ botId: 'a', name: 'Aster' }], messages: 0, sidebar: false } },
    'paste-narrow': { about: 'Long paste remains usable at 400px', viewport: { width: 400, height: 800 }, data: { name: 'Long paste', members: [{ botId: 'a', name: 'Aster' }], messages: 0, sidebar: false } },
    'paste-reply': { about: 'Topic reply uses the same long-paste chip', viewport: { width: 420, height: 800 }, data: { name: 'Long paste', members: [{ botId: 'a', name: 'Aster' }], messages: 0, sidebar: false, replyComposer: true } },
  },
  async ready(page) {
    await group.ready(page);
    await page.locator('textarea').evaluate((input, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      input.focus();
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    await page.locator('[data-pasted-text-chip]').waitFor();
  },
  async check(page, ui) {
    const editor = page.locator('[contenteditable="true"]');
    assert.equal((await editor.innerText()).trim(), await ui.t('newChat.pastedText.chipLabel', { lines: 66 }));
    await ui.capture('folded');
    await page.locator('[data-pasted-text-chip]').click();
    const preview = page.getByRole('textbox', { name: await ui.t('newChat.pastedText.editTitle') });
    await preview.waitFor();
    assert.equal(await preview.inputValue(), text);
    await ui.capture('preview');
    await preview.fill(text + '\nlast line');
    await page.getByRole('button', { name: await ui.t('newChat.pastedText.saveEdit'), exact: true }).click();
    await page.locator('[data-pasted-text-chip]').getByText(await ui.t('newChat.pastedText.chipLabel', { lines: 67 })).waitFor();
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' suffix');
    assert.ok((await editor.innerText()).includes('suffix'), 'Typing beside the chip remains visible');
    if (ui.case !== 'paste-reply') {
      await page.keyboard.type(' @Ast');
      await page.getByRole('option', { name: /Aster/ }).waitFor();
      await page.keyboard.press('Enter');
      assert.ok((await editor.innerText()).includes('@Aster'), 'The mention picker uses full-text offsets beside the chip');
    }
    await editor.evaluate((input) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'z'.repeat(4000));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator('[data-pasted-text-chip]').count(), 2, 'A second long paste becomes its own chip');
    await ui.capture('edited');
  },
};
