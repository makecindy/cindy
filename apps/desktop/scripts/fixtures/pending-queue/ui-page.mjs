import assert from 'node:assert/strict';
import companion from '../companion-message-actions/ui-page.mjs';
export default {
  name: 'pending-queue',
  entry: './fixture.tsx',
  viewport: { width: 880, height: 560 },
  real: 'appendPendingQueueItems, PendingQueueBubble, UserMessage, shared queue action rules and dropdown menu',
  notCovered: 'Live host dispatch, remote reconnection, full MessageStream scrolling',
  stubs: companion.stubs,
  cases: {
    default: { about: 'Queue bubbles: reorder, edit lock and cancel from the status menu' },
    'hold-none': { about: 'Queue with nothing paused: no standing marker, no dimmed rows', viewport: { width: 880, height: 620 } },
    'hold-menu': { about: 'Same queue without pausing: the status menu carries 暂停 and no standing row mark', viewport: { width: 880, height: 620 } },
    hold: { about: 'Queue after pausing from the menu: mark on the paused row, hover hint, dimmed tail and 继续 back in the menu', viewport: { width: 880, height: 620 } },
  },
  async check(page, ui) {
    const row = (id) => page.locator(`[data-pending-queue-message="${id}"]`);
    assert.equal(await row('question-reply:answered:fixture').count(), 0);
    const visibleOrder = () => page.locator('[data-pending-queue-message]')
      .evaluateAll((rows) => rows.map((item) => item.getAttribute('data-pending-queue-message')));
    const menu = () => page.getByRole('menu');
    const action = async (key) =>
      page.getByRole('menuitem', { name: await ui.t(`newChat.pendingQueue.${key}`), exact: true });
    const trigger = async (id) =>
      row(id)
        .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true });
    const openMenu = async (id) => {
      await (await trigger(id)).click();
      await menu().waitFor();
    };
    const holdAttr = (id) => row(id).getAttribute('data-queue-hold');
    // Nothing paused: no mark and no dimming, so the queue reads as before this feature.
    if (ui.case === 'hold-none') {
      assert.equal(await holdAttr('before-a'), null);
      assert.equal(await holdAttr('stop'), null);
      assert.equal(await holdAttr('after-a'), null);
      await ui.capture('none');
      return;
    }
    // Nothing paused: 暂停 is a menu item, so it adds no standing element to the row.
    if (ui.case === 'hold-menu') {
      assert.equal(await holdAttr('stop'), null);
      await ui.capture('hover');
      await openMenu('stop');
      assert.equal(await (await action('holdAction')).count(), 1);
      assert.equal(await (await action('steerAction')).count(), 1);
      assert.equal(await (await action('releaseHoldAction')).count(), 0);
      // 暂停 sits right after 插话, before edit / reorder / cancel.
      assert.deepEqual(
        (await menu().getByRole('menuitem').allTextContents())
          .slice(0, 3)
          .map((text) => text.trim()),
        [
          await ui.t('newChat.pendingQueue.steerAction'),
          await ui.t('newChat.pendingQueue.holdAction'),
          await ui.t('newChat.pendingQueue.editAction'),
        ],
      );
      await ui.capture('menu');
      return;
    }
    if (ui.case === 'hold') {
      // 1) Pausing is a menu item on the row's own status menu.
      assert.equal(await holdAttr('before-a'), null);
      assert.equal(await holdAttr('stop'), null);
      assert.equal(await holdAttr('after-a'), null);
      await openMenu('stop');
      await (await action('holdAction')).click();
      assert.equal(await holdAttr('before-a'), null);
      assert.equal(await holdAttr('stop'), 'stop');
      assert.equal(await holdAttr('after-a'), 'after-stop');
      const label = row('stop').getByText(await ui.t('newChat.pendingQueue.heldRowLabel'), { exact: true });
      await label.waitFor();
      // Long locales must wrap the label instead of running past the column edge.
      const bounds = await label.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, documentWidth: document.documentElement.clientWidth };
      });
      assert.ok(bounds.left >= 0, 'held label starts inside the column');
      assert.ok(
        bounds.right <= bounds.documentWidth,
        `held label ends inside the column (${bounds.right} > ${bounds.documentWidth})`,
      );
      await ui.capture('hold-held');
      // 4) The longer explanation only appears on hover, so the row itself stays one line.
      await label.hover();
      await page.getByRole('tooltip').waitFor();
      assert.equal(
        await page.getByRole('tooltip').innerText(),
        await ui.t('newChat.pendingQueue.heldHint'),
      );
      await ui.capture('hold-hint');
      // 5) The paused row offers exactly one way back: 继续 in the same menu.
      await ui.capture('hold-resume');
      await openMenu('stop');
      assert.equal(await (await action('releaseHoldAction')).count(), 1);
      assert.equal(await (await action('holdAction')).count(), 0);
      await ui.capture('hold-resume-menu');
      // 6) Resuming restores the normal row: steering back, no stale 继续.
      await (await action('releaseHoldAction')).click();
      assert.equal(await holdAttr('before-a'), null);
      assert.equal(await holdAttr('stop'), null);
      assert.equal(await holdAttr('after-a'), null);
      await openMenu('stop');
      assert.equal(await (await action('steerAction')).count(), 1);
      assert.equal(await (await action('releaseHoldAction')).count(), 0);
      await page.keyboard.press('Escape');
      // 7) Pause again so this case ends in the paused state its screenshots describe.
      await openMenu('stop');
      await (await action('holdAction')).click();
      assert.equal(await holdAttr('stop'), 'stop');
      assert.equal(await holdAttr('after-a'), 'after-stop');
      await ui.capture('hold-final');
      return;
    }
    // Worker messages must expose steering and both reorder directions, without editing.
    await row('worker')
      .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
      .click();
    await menu().waitFor();
    assert.equal(await (await action('editAction')).count(), 0);
    await ui.capture('worker-menu');
    await (await action('moveDown')).click();
    assert.deepEqual(await visibleOrder(), ['first', 'worker', 'second']);
    await row('worker')
      .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
      .click();
    await (await action('moveUp')).click();
    assert.deepEqual(await visibleOrder(), ['worker', 'first', 'second']);
    await row('worker')
      .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
      .click();
    await (await action('steerAction')).click();
    assert.equal(await row('worker').count(), 0);
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
