import assert from 'node:assert/strict';
import mask from '../group-mask/ui-page.mjs';

// Runtime regression: jsdom's quote/highlight tests have no layout engine. Clicking
// a recent @ must reveal its message without scrolling the surrounding composer.
export default {
  ...mask,
  name: 'group-mention-scroll',
  entry: '../group-mask/group-mask-fixture.tsx',
  stubs: {
    ...mask.stubs,
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview': 'export const DrawioPreview = () => null;',
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview': 'export const PdfPreview = () => null;',
  },
  cases: {
    default: { about: 'Locate the newest @ in a short conversation without moving the composer', data: { maskEnabled: false, history: 0 } },
    history: { about: 'Locate a recent @ after scrolling history without moving the composer', data: { maskEnabled: false, history: 30 } },
  },
  async check(page, ui) {
    const timeline = page.getByTestId('bot-group-timeline');
    const composer = page.locator('[data-chat-composer-stack]').first();
    // A clipped ancestor can still be programmatically scrolled. Keep the chat's
    // geometry intact while exposing trailing overflow, as can happen in the shell.
    await page.locator('[data-ui-frame="content"]').evaluate(element => {
      const overflow = document.createElement('div');
      overflow.style.cssText = 'position:absolute;top:100%;height:400px;width:1px;pointer-events:none';
      element.append(overflow);
    });
    const initialComposer = await composer.boundingBox();
    const initialTimeline = await timeline.boundingBox();
    const outerScroll = () => timeline.evaluate(element => {
      const positions = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        positions.push({ top: parent.scrollTop, left: parent.scrollLeft });
      }
      return positions;
    });
    const initialScroll = await outerScroll();
    const sameGeometry = async () => {
      assert.deepEqual(await composer.boundingBox(), initialComposer, 'locating @ must not move the composer');
      assert.deepEqual(await timeline.boundingBox(), initialTimeline, 'locating @ must not move or resize the timeline');
      assert.deepEqual(await outerScroll(), initialScroll, 'only the message list may scroll');
    };
    const request = page.getByRole('button', { name: '模拟 @ 我', exact: true });
    for (let index = 0; index <= ui.data.history; index++) await request.click();
    const messageId = `incoming-${11 + ui.data.history}`;
    const target = page.locator(`[data-bot-group-message-id="${messageId}"]`);
    await target.waitFor();
    // Finish the tail read before entering history: the rapid fixture burst can
    // otherwise leave a throttled read pending, so new-message navigation correctly hides catch-up.
    await page.bringToFront();
    await timeline.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('focus'));
    });
    if (ui.data.history) await timeline.evaluate(element => { element.scrollTop = 0; });
    await page.getByTestId('group-attention-hint').click();
    await page.locator(`[data-mention-message="${messageId}"]`).click();
    await page.waitForFunction(id => document.activeElement?.getAttribute('data-bot-group-message-id') === id, messageId);
    await ui.capture('latest-mention-located');
    await sameGeometry();
    assert.equal(await target.evaluate(element => {
      const row = element.getBoundingClientRect();
      const view = element.closest('[data-testid="bot-group-timeline"]').getBoundingClientRect();
      return row.bottom > view.top && row.top < view.bottom;
    }), true, 'the located message must remain visible');
    // The @ entry shares its locator with quoted-message navigation.
    const original = page.locator('[data-bot-group-message-id="question"]');
    const originalVisible = () => original.evaluate(element => {
      const row = element.getBoundingClientRect();
      const view = element.closest('[data-testid="bot-group-timeline"]').getBoundingClientRect();
      return row.bottom > view.top && row.top < view.bottom;
    });
    await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; });
    if (ui.data.history) assert.equal(await originalVisible(), false, 'the original must start outside the timeline viewport');
    // Playwright's click would scroll this quote (beside the original) into view
    // before invoking the locator, concealing a broken application scroll.
    await page.getByTestId('bot-group-quote').evaluate(element => element.click());
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-bot-group-message-id') === 'question');
    await sameGeometry();
    assert.equal(await originalVisible(), true, 'the quoted original must become visible');
    await ui.capture('quoted-message-located');
  },
};
