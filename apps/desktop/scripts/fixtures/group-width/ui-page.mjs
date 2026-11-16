import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';
import { checkSplit } from './split-check.mjs';

// UI regression (2026-11-16): the 914/720px caps wasted wide group panes, while
// a fixed 120px action gutter squeezed medium panes. Measure the production view
// at both sizes; the previous fixture only enforced those old caps.
const data = { name: '群聊自适应宽度检查', members: [{ botId: 'a', name: 'Aster' }], messages: 2, sidebar: false };
export default {
  ...group,
  name: 'group-width',
  entry: '../group-control/group-control-fixture.tsx',
  cases: { ...Object.fromEntries([1200, 800, 600, 559, 558, 520, 400].map(width => [width === 1200 ? 'default' : String(width), {
    about: 'Group content grows with the pane; medium and narrow panes recover the action gutter',
    viewport: { width, height: 900 }, data,
  }])), ...Object.fromEntries([1568, 1920, 2560].map(width => [`wide-${width}`, {
    about: 'Long messages from another human use wide desktop space with the sidebar expanded',
    viewport: { width, height: 900 }, data: { ...data, sidebar: true },
  }])), ...Object.fromEntries([1568, 960, 800, 660, 400].map(width => [`split-${width}`, {
    about: 'Sidebar and real topic splitter at both limits, with long content and independent drafts',
    viewport: { width, height: 900 }, data: { ...data, sidebar: width !== 400, bubbles: true, threadPanel: true },
  }])), private: {
    about: 'The shared group renderer keeps private conversations at their existing reading width',
    viewport: { width: 1920, height: 900 }, data: { ...data, direct: true },
  } },
  async ready(page) {
    await group.ready(page);
    await page.evaluate(async () => {
      const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
      group.messages = group.messages.slice(0, 2).map((message, i) => ({
        ...message, authorKind: i ? 'bot' : 'user', authorBotId: i ? 'a' : null,
        id: i ? 'width-bot' : 'width-user', quote: undefined, threadPreview: undefined, replyCount: 0,
        authorName: i ? 'Aster' : '',
        content: (i ? '群聊长消息应随可用空间变宽，小窗口里也要方便阅读。' : '请检查群聊在宽屏、中小窗口和话题分栏中的阅读效果。').repeat(18),
      }));
      window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
    });
    await page.getByTestId('bot-group-bubble').waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('split-')) return checkSplit(page, ui);
    if (ui.case.startsWith('wide-')) {
      await page.evaluate(async () => {
        const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
        group.messages = group.messages.map((message, i) => i ? {
          ...message, authorKind: 'user', authorBotId: null, authorName: '群成员 A', isSelf: false,
        } : message);
        window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
      });
      await page.getByText('群成员 A', { exact: true }).waitFor();
    }
    const measure = () => page.evaluate(() => {
      const timeline = document.querySelector('[data-testid="bot-group-timeline"]');
      const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, width: r.width }; };
      return {
        main: box(timeline.closest('main')), scrollWidth: timeline.clientWidth, column: box(timeline.firstElementChild),
        composer: box(document.querySelector('textarea').parentElement),
        user: box(document.querySelector('[data-testid="bot-group-self-bubble"]')),
        bot: box(document.querySelector('[data-testid="bot-group-bubble"]')),
      };
    });
    const check = async () => {
      const m = await measure();
      const privateChat = ui.case === 'private';
      const column = privateChat ? Math.min(914, m.main.width - (m.main.width < 700 ? 40 : 100)) : Math.min(1440, m.main.width - 40);
      const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1,
        `${label}: expected ${expected}px, got ${actual}px`);
      close(m.column.width, column, 'message column');
      close(m.column.x, m.main.x + (m.scrollWidth - column) / 2, 'centered messages');
      close(m.composer.width, column + 20, 'composer outset');
      close(m.composer.x, m.main.x + (m.main.width - column - 20) / 2, 'centered composer');
      for (const [name, bubble, available] of [['user', m.user, column], ['reply', m.bot, column - 38]]) {
        if (privateChat) {
          close(bubble.width, Math.min(720, available - (available <= 480 ? 0 : 120)), `${name}: private width unchanged`);
          continue;
        }
        assert.ok(bubble.width <= 1201 && bubble.width <= available + 1, `${name}: bubble stays inside column`);
        if (available <= 600) close(bubble.width, available, `${name}: narrow bubble uses full width`);
        else if (available >= 1320) close(bubble.width, 1200, `${name}: wide bubble expands to reading cap`);
        else assert.ok(bubble.width >= available * 0.88, `${name}: medium bubble uses at least 88% of its column`);
      }
      assert.ok(await page.locator('.chat-bubble-toolbar').evaluateAll(elements => elements.every(el => {
        const r = el.getBoundingClientRect(), pane = el.closest('main').getBoundingClientRect();
        return r.left >= pane.left && r.right <= pane.right;
      })), 'message actions stay inside their pane');
    };
    await check();
    await ui.capture('aligned');
    // Resize the mounted pane, as when opening a sidebar; drafts and layout stay live.
    await page.locator('[data-ui-page-subject]').evaluate(el => {
      el.style.height = `${el.getBoundingClientRect().height}px`;
      el.style.width = '600px'; el.style.maxWidth = '100%'; el.style.flex = 'none';
    });
    await page.waitForFunction(() => {
      const main = document.querySelector('[data-testid="bot-group-timeline"]').closest('main');
      const expected = Math.min(1440, main.getBoundingClientRect().width - 40);
      return Math.abs(parseFloat(main.style.getPropertyValue('--cindy-message-width')) - expected) < 1;
    });
    await check();
    await ui.capture('resized');
    if (ui.case === 'default') {
      await page.evaluate(async () => {
        const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
        group.messages = group.messages.map(message => ({ ...message, content: '收到' }));
        window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
      });
      await page.getByTestId('bot-group-bubble').getByText('收到', { exact: true }).waitFor();
      const short = await measure();
      assert.ok(short.user.width < 220 && short.bot.width < 220, 'short messages do not stretch to the reading cap');
      await ui.capture('short-messages');
    }
  },
};
