import assert from 'node:assert/strict';
import companion from '../companion-message-actions/ui-page.mjs';
export default {
  name: 'pending-queue',
  entry: './fixture.tsx',
  viewport: { width: 880, height: 560 },
  real: 'PendingQueueBubble, UserMessage, shared queue action rules and dropdown menu',
  notCovered: 'Live host dispatch, remote reconnection, full MessageStream scrolling',
  stubs: companion.stubs,
  cases: {
    default: { about: 'Queue bubbles: reorder, edit lock and cancel from the status menu' },
  },
  async check(page, ui) {
    const row = (id) => page.locator(`[data-pending-queue-message="${id}"]`);
    const menu = () => page.getByRole('menu');
    const action = async (key) =>
      page.getByRole('menuitem', { name: await ui.t(`newChat.pendingQueue.${key}`), exact: true });
    await row('second')
      .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
      .click();
    await menu().waitFor();
    await ui.capture('menu');
    await (await action('moveUp')).click();
    assert.equal(
      await page
        .locator('[data-pending-queue-message]')
        .first()
        .getAttribute('data-pending-queue-message'),
      'second',
    );
    await row('second')
      .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
      .click();
    await (await action('editAction')).click();
    await row('second')
      .getByText(await ui.t('newChat.pendingQueue.editingInComposer'))
      .waitFor();
    await ui.capture('editing');
    await row('first')
      .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
      .click();
    await (await action('cancelSend')).click();
    assert.equal(await row('first').count(), 0);
  },
};
