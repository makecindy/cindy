import assert from 'node:assert/strict';

// Layout regression: a long source message used to be capped at 192px in a second
// scroller. jsdom cannot measure that failure; keep this in the Electron UI tier.
export default {
  name: 'thread-panels', entry: './fixture.tsx', viewport: { width: 960, height: 640 },
  real: 'BotDmThreadPanel, ChatThreadPanel, shared ThreadPanel/ThreadPanelRoot, BotGroupTimelineItem, Markdown, wallpaper, theme and translations',
  notCovered: 'Private ready-state task runtime, model execution, real media upload, server persistence and attachment IO; attachment selection and layout use scenario host data',
  stubs: {
    'src/renderer/features/cc-agent/CCAgentSessionView': 'export const CCAgentSessionView = () => { throw new Error("Use full Desktop for ready-state task verification"); };',
    'src/renderer/lib/makerChatStore': { partial: 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => window.__threadRoot };' },
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => { throw new Error("Voice is outside this layout fixture"); };',
  },
  cases: {
    group: { about: 'Group topic with a long source message and working follow switch, with and without wallpaper' },
    'group-attachments': { about: 'Thread + menu, image-only send and tray reset at narrow panel width' },
    'group-cache-pending': { about: 'Reopen a thread before its delayed image cache finishes; retain the image and newer text' },
    default: { about: 'Private topic opening with the same long source message' },
    failed: { about: 'Private topic failure keeps the entire source and retry reachable' },
    'group-narrow': { about: '2026-10-29: 320px topic preserves bubble width, readable table columns and bounded file chips', viewport: { width: 640, height: 800 } },
    'composer-attachments': { about: 'Review regression: multiline group draft and 分工 must not clip attachment removal', viewport: { width: 800, height: 650 } },
  },
  async ready(page) { await page.locator('textarea, aside [data-bot-group-message-id="root"], aside [data-dm-thread-root]').first().waitFor(); },
  async check(page, ui) {
    // Real DOM geometry (UI tier): older scenarios had no narrow table/file or draft attachment.
    if (ui.case === 'composer-attachments') {
      await page.locator('textarea').fill(Array(12).fill('Multiline draft with an attachment.').join('\n'));
      await page.getByRole('button', { name: await ui.t('bots.groupChat.composer.more'), exact: true }).click();
      await page.getByRole('menuitem').filter({ hasText: await ui.t('bots.groupChat.composer.division') }).click();
      const remove = page.getByRole('button', { name: /^Remove / });
      const bounds = await remove.evaluate(el => {
        const button = el.getBoundingClientRect(), strip = el.closest('.scrollbar-hide').getBoundingClientRect();
        return { top: button.top - strip.top, bottom: strip.bottom - button.bottom };
      });
      assert.ok(bounds.top >= 0 && bounds.bottom >= 0, 'attachment remove button remains fully visible');
      await remove.locator('..').hover();
      await ui.capture('attachment-remove');
      await remove.click();
      assert.equal(await remove.count(), 0, 'attachment removal still works');
      return;
    }
    const panel = page.locator('aside');
    if (ui.case === 'group-cache-pending') {
      await panel.locator('input[type="file"]').setInputFiles({
        name: 'late.png', mimeType: 'image/png', buffer: Buffer.from('fixture-image-bytes'),
      });
      await page.waitForFunction(() => typeof window.__threadImageCache.finish === 'function');
      await panel.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
      await page.locator('[data-closed]').waitFor({ state: 'attached' });
      await ui.capture('closed-during-cache');
      await page.getByRole('button', { name: 'Reopen thread', exact: true }).click();
      await panel.locator('textarea').fill('Keep this newer draft');
      assert.equal(await panel.locator('img[alt="late.png"]').count(), 0);
      await page.evaluate(() => window.__threadImageCache.finish());
      await panel.locator('img[alt="late.png"]').waitFor();
      assert.equal(await panel.locator('textarea').inputValue(), 'Keep this newer draft');
      await ui.capture('reopened-with-image');
      return;
    }
    if (ui.case === 'group-attachments') {
      const more = panel.getByRole('button', { name: await ui.t('bots.groupChat.composer.more'), exact: true });
      await more.click();
      await page.getByRole('menuitem', { name: await ui.t('extraDirs.addFiles'), exact: true }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: await ui.t('bots.groupChat.composer.division'), exact: false }).count(), 0);
      await ui.capture('attachment-menu');
      await page.keyboard.press('Escape');
      await panel.locator('input[type="file"]').setInputFiles({
        name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('fixture-image-bytes'),
      });
      const send = panel.getByRole('button', { name: await ui.t('bots.groupChat.server.sendReply'), exact: true });
      await page.waitForFunction(() => document.querySelector('aside input[type="file"]') &&
        window.__threadSends.length === 0 && document.querySelector('aside img[alt="photo.png"]'));
      assert.equal(await send.isEnabled(), true);
      await ui.capture('image-ready');
      await send.click();
      await page.waitForFunction(() => window.__threadSends.length === 1);
      const [sent] = await page.evaluate(() => window.__threadSends);
      assert.equal(sent.rootId, 'root');
      assert.equal(sent.text, '');
      assert.equal(sent.attachments[0].name, 'photo.png');
      await send.waitFor({ state: 'visible' });
      assert.equal(await send.isDisabled(), true);
      await ui.capture('sent');
      return;
    }
    if (ui.case === 'group-narrow') {
      const bubble = panel.getByTestId('bot-group-bubble');
      await bubble.waitFor();
      const layout = await bubble.evaluate(el => {
        const box = el.getBoundingClientRect();
        const column = el.parentElement.parentElement.getBoundingClientRect();
        const files = [...el.querySelectorAll('[data-testid="bot-group-message-attachments"] button, [data-testid="bot-group-message-attachments"] [role="status"]')];
        const table = el.querySelector('table'), cell = table.querySelector('tbody td');
        const toolbar = el.querySelector('[data-bot-group-message-actions]').getBoundingClientRect();
        return { unused: column.width - box.width,
          filesInside: files.length === 2 && files.every(file => file.getBoundingClientRect().right <= box.right - 10),
          cellWidth: cell.getBoundingClientRect().width,
          tableScrolls: table.parentElement.scrollWidth > table.parentElement.clientWidth,
          actionsInside: toolbar.left >= box.left && toolbar.right <= box.right };
      });
      assert.ok(layout.unused < 10, 'topic does not reserve a side toolbar rail');
      assert.ok(layout.filesInside, 'loaded and pending file chips stay inside the bubble');
      assert.ok(layout.cellWidth > 50 && layout.tableScrolls, 'table keeps readable columns and scrolls inside the bubble');
      assert.ok(layout.actionsInside, 'message actions remain inside the panel');
      assert.ok(await panel.locator('table').evaluate(table => {
        const scroller = table.parentElement;
        scroller.scrollLeft = scroller.scrollWidth;
        return scroller.scrollLeft > 0 && table.querySelector('tr:last-child td:last-child').getBoundingClientRect().right <= scroller.getBoundingClientRect().right + 1;
      }), 'the last table column can be reached without scrolling the panel sideways');
      await ui.capture('table-end');
      await panel.locator('table').evaluate(table => { table.parentElement.scrollLeft = 0; });
      await panel.getByRole('button', { name: await ui.t('chat.messageActionBar.moreActions'), exact: true }).click();
      await page.getByRole('menuitem', { name: await ui.t('chat.messageActionBar.copy'), exact: true }).waitFor();
      await page.keyboard.press('Escape');
      const follow = panel.locator('[data-thread-follow]');
      await follow.click();
      await panel.locator('[data-thread-follow][aria-pressed="true"]').waitFor();
      await page.getByRole('button', { name: 'Wallpaper', exact: true }).click();
      await page.locator('html[data-wallpaper-active="true"]').waitFor({ state: 'attached' });
      await ui.capture('narrow-wallpaper');
      return;
    }
    const follow = panel.locator('[data-thread-follow]');
    if (ui.case === 'group') {
      await follow.waitFor();
      assert.equal(await follow.getAttribute('aria-pressed'), 'false');
      assert.equal(await follow.textContent(), await ui.t('bots.groupChat.server.thread.follow'));
    }
    const root = ui.case === 'group' ? panel.locator('[data-bot-group-message-id="root"]') : panel.locator('[data-dm-thread-root]');
    const measurements = await root.evaluate(el => {
      const scrollers = [];
      for (let node = el; node && node.tagName !== 'ASIDE'; node = node.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) scrollers.push(node);
      }
      return { height: el.getBoundingClientRect().height, ownOverflow: el.scrollHeight - el.clientHeight,
        scrollers: scrollers.length, ownScroller: scrollers.includes(el) };
    });
    assert.ok(measurements.height > 192, 'long root is allowed its full natural height');
    assert.ok(measurements.ownOverflow <= 1, 'no content is hidden inside the root');
    assert.equal(measurements.scrollers, 1, 'one scroll owner for root and replies');
    assert.equal(measurements.ownScroller, false, 'root is not an independent scroll box');
    await panel.getByText('原消息开头 · Original message', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('root-top');
    await panel.getByText('原消息末尾 · End of original', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('root-end');
    const themeSurface = await panel.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(themeSurface, 'rgba(0, 0, 0, 0)', 'without wallpaper the panel keeps its theme surface');
    const wallpaperToggle = page.getByRole('button', { name: 'Wallpaper', exact: true });
    await wallpaperToggle.click();
    await page.locator('html[data-wallpaper-active="true"]').waitFor({ state: 'attached' });
    assert.equal(await panel.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)',
      'the topic panel lets the continuous wallpaper show through');
    await panel.getByText('原消息开头 · Original message', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('wallpaper-top');
    if (ui.case === 'group') {
      await follow.click();
      await panel.locator('[data-thread-follow][aria-pressed="true"]').waitFor();
      assert.equal(await follow.textContent(), await ui.t('bots.groupChat.server.thread.following'));
      await page.mouse.move(0, 0);
      await ui.capture('wallpaper-following');
      await follow.click();
      await panel.locator('[data-thread-follow][aria-pressed="false"]').waitFor();
      assert.equal(await follow.textContent(), await ui.t('bots.groupChat.server.thread.follow'));
    }
    await panel.getByText('原消息末尾 · End of original', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('wallpaper-end');
    await wallpaperToggle.click();
    await page.locator('html[data-wallpaper-active="true"]').waitFor({ state: 'detached' });
    assert.equal(await panel.evaluate(el => getComputedStyle(el).backgroundColor), themeSurface,
      'turning wallpaper off restores the theme surface');
    if (ui.case === 'failed') await panel.getByRole('button', { name: await ui.t('bots.retry'), exact: true }).click();
    await panel.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
    await page.locator('[data-closed]').waitFor({ state: 'attached' });
  },
};
