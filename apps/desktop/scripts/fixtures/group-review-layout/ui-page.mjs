import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';

const data = { name: 'Layout review', members: [{ botId: 'a', name: 'Aster' }], sidebar: false };

export default {
  ...group,
  name: 'group-review-layout',
  entry: '../group-control/group-control-fixture.tsx',
  cases: {
    ...Object.fromEntries([400, 520, 521, 1200].map(width => [`short-${width}`, {
      about: 'A one-character server message keeps its bubble and full toolbar dimensions until acknowledged',
      viewport: { width, height: 760 }, data: { ...data, bubbles: true, sendStatus: true },
    }])),
    ...Object.fromEntries([400, 520, 521, 1200].map(width => [`send-${width}`, {
      about: 'Pending, slow and acknowledged messages retain identical geometry across the narrow-toolbar breakpoint',
      viewport: { width, height: 760 }, data: { ...data, messages: 40, sendStatus: true },
    }])),
    'send-sidebar': {
      about: 'A narrow message pane in a wider window retains its height when the send receipt arrives',
      viewport: { width: 760, height: 760 }, data: { ...data, sidebar: true, messages: 40, sendStatus: true },
    },
    ...Object.fromEntries([400, 1200].map(width => [width === 1200 ? 'default' : `share-${width}`, {
      about: 'Entering and leaving image sharing preserves the composer horizontal alignment',
      viewport: { width, height: 760 }, data: { ...data, bubbles: true },
    }])),
  },
  async check(page, ui) {
    if (ui.case.startsWith('short-')) {
      const input = page.locator('textarea');
      const outbox = page.getByTestId('bot-group-outbox');
      const row = page.locator('[data-bot-group-message-id^="pending:"], [data-bot-group-message-id^="sent-"]');
      const geometry = () => row.evaluate(el => {
        const bounds = target => {
          const { x, width, height } = target.getBoundingClientRect();
          return { x, width, height };
        };
        return {
          row: bounds(el),
          bubble: bounds(el.querySelector('[data-testid="bot-group-self-bubble"]')),
          toolbar: bounds(el.querySelector('[data-bot-group-message-actions]')),
        };
      });
      await input.fill('好');
      await input.press('Enter');
      await outbox.waitFor();
      const pending = await geometry();
      assert.equal(await outbox.getByRole('button').count(), 0, 'pending actions stay inaccessible');
      await ui.capture('pending');
      await outbox.getByRole('status').waitFor({ state: 'attached' });
      assert.deepEqual(await geometry(), pending, 'slow feedback preserves the short bubble');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-send-receipt', { detail: 'ok' })));
      await outbox.waitFor({ state: 'detached' });
      const sent = await geometry();
      await ui.capture('sent');
      console.log('SHORT_SEND_GEOMETRY', JSON.stringify({ pending, sent }));
      assert.deepEqual(sent, pending, 'receipt preserves the short bubble and all toolbar slots');
      assert.equal(await row.locator('[data-bot-group-message-actions]').getByRole('button').count(), 4);
      return;
    }
    if (ui.case.startsWith('send-')) return group.check.call(group, page, {
      ...ui, case: 'send-status',
      async capture(label) {
        if (label === 'pending' || label === 'slow') {
          assert.equal(await page.getByTestId('bot-group-outbox').getByRole('button').count(), 0,
            'pending messages do not expose actions before they have a server id');
        }
        await ui.capture(label);
      },
    });
    const bounds = locator => locator.evaluate(el => {
      const { x, width } = el.getBoundingClientRect();
      return { x, width };
    });
    const composer = page.locator('textarea').locator('..');
    const before = await bounds(composer);
    const message = page.locator('[data-bot-group-message-id]').filter({ has: page.getByTestId('bot-group-self-bubble') }).first();
    await message.hover();
    await message.getByRole('button', { name: await ui.t('chat.messageActionBar.moreActions'), exact: true }).click();
    await page.getByRole('menuitem', { name: await ui.t('chat.shareImage.entry'), exact: true }).click();
    const bar = page.getByRole('checkbox', { name: await ui.t('chat.shareImage.selectAll'), exact: true }).locator('..');
    const during = await bounds(bar);
    await ui.capture('sharing');
    assert.deepEqual(during, before, 'image sharing stays aligned with the composer');
    await page.getByRole('button', { name: await ui.t('chat.shareImage.cancel'), exact: true }).click();
    assert.deepEqual(await bounds(composer), before, 'cancel restores the same composer bounds');
  },
};
