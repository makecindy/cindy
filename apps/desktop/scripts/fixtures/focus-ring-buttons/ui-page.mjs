import assert from 'node:assert/strict';

export default {
  name: 'focus-ring-buttons',
  entry: './fixture.tsx',
  viewport: { width: 520, height: 260 },
  real: 'Toast close icon, PreviewButton from PreviewChrome, MailConversationView message row, WebhookEventSelect choices, HookTaskCard context disclosure, globals.css focus suppression and theme tokens',
  notCovered: 'Toast queue timing, the full attachment preview panel, real mail reading and webhook saving, and the remaining buttons that received the same class change',
  cases: {
    default: { about: 'Tab onto the top-right × of a persistent Toast' },
    'preview-button': { about: 'Tab onto the attachment preview header icon button' },
    'mail-row': {
      about: 'Tab onto a full-width mail message row inside its overflow-hidden card',
      viewport: { width: 520, height: 420 },
    },
    'webhook-event': {
      about: 'Tab from the search field onto the first choice of the scrolling event list',
      viewport: { width: 520, height: 560 },
    },
    'hook-task-card': {
      about: 'Tab onto the attached-context disclosure of an IM task card',
      viewport: { width: 520, height: 320 },
    },
  },
  async check(page, ui) {
    let target;
    if (ui.case === 'default') target = page.locator('button[aria-label="Later"].absolute');
    else if (ui.case === 'preview-button') target = page.getByRole('button', { name: 'Download' });
    else if (ui.case === 'mail-row') target = page.locator('[data-mail-message-id] > button[aria-expanded]');
    else if (ui.case === 'hook-task-card') target = page.locator('button[aria-expanded]').first();
    else {
      await page.getByRole('button', { name: await ui.t('scheduler.editor.webhook.eventPicker.choose') }).click();
      await page.getByRole('dialog').waitFor();
      target = page.getByRole('dialog').getByRole('checkbox').first();
    }
    // 用键盘 Tab 聚焦,才会命中 :focus-visible。
    for (let i = 0; i < 12 && !(await target.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    assert.equal(await target.evaluate((el) => el === document.activeElement), true, 'target receives keyboard focus');
    const result = await target.evaluate((el) => {
      const computed = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      // 外侧焦点圈向外扩 2px;inset 焦点圈画在元素内部。
      const spread = computed.boxShadow.includes('inset') ? 0 : 2;
      const ring = { left: rect.left - spread, top: rect.top - spread, right: rect.right + spread, bottom: rect.bottom + spread };
      const clippedBy = [];
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const box = node.getBoundingClientRect();
        const left = box.left + node.clientLeft;
        const top = box.top + node.clientTop;
        if (ring.left < left - 0.5 || ring.top < top - 0.5 || ring.right > left + node.clientWidth + 0.5 || ring.bottom > top + node.clientHeight + 0.5) {
          clippedBy.push(`${node.tagName.toLowerCase()}.${String(node.className).split(' ').slice(0, 4).join('.')}`);
        }
      }
      return { outline: computed.outlineStyle, shadow: computed.boxShadow, focusVisible: el.matches(':focus-visible'), clippedBy };
    });
    assert.equal(result.focusVisible, true);
    // globals.css 压掉 outline;焦点只能由 box-shadow 焦点圈画出来(DESIGN.md §14.2)。
    assert.equal(result.outline, 'none');
    assert.notEqual(result.shadow, 'none', 'keyboard focus draws a ring');
    // 焦点圈要完整可见:不被任何 overflow 祖先裁掉。
    assert.deepEqual(result.clippedBy, [], 'focus ring is not clipped by an overflow ancestor');
  },
};
