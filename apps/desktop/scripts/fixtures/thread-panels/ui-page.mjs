import assert from 'node:assert/strict';

// Layout regression: a long source message used to be capped at 192px in a second
// scroller. jsdom cannot measure that failure; keep this in the Electron UI tier.
export default {
  name: 'thread-panels', entry: './fixture.tsx', viewport: { width: 960, height: 640 },
  real: 'BotDmThreadHost, BotDmThreadPanel, ChatThreadPanel, useThreadPanelResize, shared ThreadPanel/ThreadPanelRoot, BotGroupTimelineItem, Markdown, theme and translations',
  notCovered: 'Private ready-state task runtime (checked separately in isolated Desktop), model execution, server persistence and attachments',
  stubs: {
    'src/renderer/features/cc-agent/CCAgentSessionView': 'export const CCAgentSessionView = () => { throw new Error("Use full Desktop for ready-state task verification"); };',
    'src/renderer/lib/makerChatStore': { partial: 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => window.__threadRoot, subscribeAll: () => () => {}, getRunningSnapshot: () => (window.__threadRunning ??= new Map()) };' },
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => { throw new Error("Voice is outside this layout fixture"); };',
  },
  cases: {
    group: { about: 'Group topic with a long source message' },
    default: { about: 'Private topic opening with the same long source message' },
    failed: { about: 'Private topic failure keeps the entire source and retry reachable' },
    resized: { about: 'Private chat widens its topic by dragging the divider' },
  },
  async ready(page) { await page.locator('aside [data-bot-group-message-id="root"], aside [data-dm-thread-root]').first().waitFor(); },
  async check(page, ui) {
    const panel = page.locator('aside');
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
    if (ui.case === 'resized') {
      // Private topics share the group divider: dragging it widens the panel within the chat's bounds.
      const before = (await panel.boundingBox()).width;
      const handle = (await panel.getByRole('separator').boundingBox());
      const y = handle.y + handle.height / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handle.x - 200, y, { steps: 8 });
      await page.mouse.up();
      const after = (await panel.boundingBox()).width;
      assert.ok(after >= before + 100, `topic panel widened (${before} → ${after})`);
      assert.ok(after <= 960 - 384, 'the private chat keeps its minimum width');
      await ui.capture('resized');
      return;
    }
    await panel.getByText('原消息开头 · Original message', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('root-top');
    await panel.getByText('原消息末尾 · End of original', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('root-end');
    if (ui.case === 'failed') await panel.getByRole('button', { name: await ui.t('bots.retry'), exact: true }).click();
    await panel.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
    await page.locator('[data-closed]').waitFor({ state: 'attached' });
  },
};
