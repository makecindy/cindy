import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';

export default {
  ...group,
  name: 'group-jump-bottom',
  entry: '../group-control/group-control-fixture.tsx',
  stubs: {
    ...group.stubs,
    // Unrelated ?url asset imports are unsupported by the single-page builder.
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview': 'export const DrawioPreview = () => null;',
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview': 'export const PdfPreview = () => null;',
  },
  notCovered: 'PDF/Drawio previews, real network, sending and native input; actual group layout and wheel navigation use synthetic host data.',
  cases: {
    'short-growth': { about: 'A located short chat keeps its reading position and reveals unread navigation when content grows',
      data: { ...group.cases['long-thread'].data, messages: 2, sidebar: false, shortGrowth: true, controlled: true } },
    default: { about: 'History navigation temporarily replaces topic hints without changing scroll geometry',
      data: { ...group.cases['long-thread'].data, sidebar: false, threadUnread: true } },
    'with-control': { about: 'Navigation replaces both topic and connection bubbles; idle/return restores them unchanged',
      data: { ...group.cases['long-thread'].data, sidebar: false, threadUnread: true, controlled: true } },
  },
  async ready(page) {
    await group.ready(page);
    if (await page.evaluate(() => window.__uiPage.ctx.data.controlled)) {
      await page.evaluate(() => window.__uiPage.emit('controlledState', {
        controllers: [{ deviceId: 'fixture', name: 'Mac Studio' }],
      }));
      await page.locator('[data-controlled-banner-chip]').waitFor();
    }
  },
  async check(page, ui) {
    const timeline = page.getByTestId('bot-group-timeline');
    const composer = page.locator('[data-chat-composer-stack]');
    const bubbles = page.locator('[data-group-bottom-bubbles]');
    const hint = page.locator('[data-thread-hint]');
    const banner = page.locator('[data-controlled-banner-chip]');
    if (ui.data.shortGrowth) {
      await page.evaluate(async () => {
        const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
        group.serverBacked = true;
        group.messages = group.messages.map((message, index) => index === 1 ? { ...message,
          quote: { messageId: 'm0', authorName: 'You', authorKind: 'user', excerpt: 'Layout message 1',
            attachmentCount: 0, attachmentName: null, sequence: 1 },
        } : message);
        window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
      });
      await page.getByTestId('bot-group-quote').click();
      assert.equal(await timeline.evaluate(el => el.scrollHeight - el.clientHeight), 0, 'located chat initially fits');
      await page.evaluate(async () => {
        const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
        group.messages = [...group.messages, { ...group.messages[0], id: 'new-reply', sequence: 3,
          authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', content: 'New reply after locating',
          createdAt: Date.now() }];
        window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
      });
      await page.getByText('New reply after locating', { exact: true }).waitFor();
      await page.locator('[data-bot-group-message-id="new-reply"]').evaluate(el => { el.style.minHeight = '1000px'; });
      await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
      assert.equal(await timeline.evaluate(el => el.scrollTop), 0, 'content growth must preserve the historical position');
      const unread = page.getByRole('button', { name: await ui.t('chat.newMessageIndicator.aria', { count: 1 }), exact: true });
      assert.equal(await unread.evaluate(el => el.parentElement.classList.contains('opacity-100')), true);
      await ui.capture('short-group-unread');
      await unread.click();
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="bot-group-timeline"]');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      });
      await page.waitForFunction(() => !document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
      await ui.capture('short-group-returned');
      return;
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el && el.scrollHeight > el.clientHeight && el.scrollTop > 0;
    });
    const initialTimeline = await timeline.boundingBox();
    const initialComposer = await composer.boundingBox();
    const sameGeometry = async () => {
      assert.deepEqual(await timeline.boundingBox(), initialTimeline, 'navigation must not resize the timeline');
      assert.deepEqual(await composer.boundingBox(), initialComposer, 'navigation must not move the composer');
    };
    await page.mouse.move(initialTimeline.x + 24, initialTimeline.y + initialTimeline.height / 2);
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el.scrollHeight - el.scrollTop - el.clientHeight > 500;
    });
    await page.getByTestId('group-attention-hint').click();
    await page.getByRole('dialog').waitFor();
    await page.mouse.move(initialTimeline.x + 24, initialTimeline.y + initialTimeline.height / 2);
    await page.mouse.wheel(0, 150);
    const jump = page.getByRole('button', { name: await ui.t('chat.jumpToBottom'), exact: true });
    await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
    assert.equal(await page.getByRole('dialog').count(), 0, 'open topic portal also yields to navigation');
    assert.equal(await hint.isVisible(), false, 'topic yields to navigation');
    if (ui.data.controlled) assert.equal(await banner.isVisible(), false, 'connection bubble also yields');
    assert.equal(await bubbles.getAttribute('inert'), '', 'hidden bubble actions cannot receive input');
    await sameGeometry();
    await ui.capture('navigation-replaces-bubbles');
    await hint.waitFor({ state: 'visible', timeout: 3500 });
    if (ui.data.controlled) assert.equal(await banner.isVisible(), true, 'connection bubble returns on idle');
    await sameGeometry();
    await ui.capture('bubbles-restored-after-idle');
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
    await jump.click();
    await timeline.evaluate(el => { el.querySelector('article:last-of-type').style.minHeight = '500px'; });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    });
    await hint.waitFor({ state: 'visible' });
    if (ui.data.controlled) assert.equal(await banner.isVisible(), true, 'connection bubble returns at the tail');
    await timeline.evaluate(el => { el.querySelector('article:last-of-type').style.minHeight = ''; });
    await sameGeometry();
    await ui.capture('returned-to-bottom');
  },
};
