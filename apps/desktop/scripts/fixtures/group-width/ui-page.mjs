import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';
import { checkSplit } from './split-check.mjs';

// Regression: the group column used to stop at 760px while private chats use
// 914px and a wider composer. Measure the production page, not CSS strings.
const data = { name: '宽度对齐检查', members: [{ botId: 'a', name: 'Aster' }], messages: 2, sidebar: false };
export default {
  ...group,
  name: 'group-width',
  entry: '../group-control/group-control-fixture.tsx',
  cases: { ...Object.fromEntries([1200, 800, 600, 559, 558, 520, 400].map(width => [width === 1200 ? 'default' : String(width), {
    about: 'Group message and composer geometry follows the private chat at this viewport width',
    viewport: { width, height: 900 }, data,
  }])), ...Object.fromEntries([1568, 960, 800, 660, 400].map(width => [`split-${width}`, {
    about: 'Sidebar and real topic splitter at both limits, with long content and independent drafts',
    viewport: { width, height: 900 }, data: { ...data, sidebar: width !== 400, bubbles: true, threadPanel: true },
  }])) },
  async ready(page) {
    await group.ready(page);
    await page.evaluate(async () => {
      const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
      group.messages = group.messages.slice(0, 2).map((message, i) => ({
        ...message, authorKind: i ? 'bot' : 'user', authorBotId: i ? 'a' : null,
        id: i ? 'width-bot' : 'width-user', quote: undefined, threadPreview: undefined, replyCount: 0,
        authorName: i ? 'Aster' : '',
        content: (i ? '伙伴回复需要与私聊保持一致的阅读宽度。' : '请将群聊的主界面和消息气泡按私聊统一。').repeat(18),
      }));
      window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
    });
    await page.getByTestId('bot-group-bubble').waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('split-')) return checkSplit(page, ui);
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
      const column = Math.min(914, m.main.width - (m.main.width < 700 ? 40 : 100));
      const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1,
        `${label}: expected ${expected}px, got ${actual}px`);
      close(m.column.width, column, 'message column');
      close(m.column.x, m.main.x + (m.scrollWidth - column) / 2, 'centered messages');
      close(m.composer.width, column + 20, 'composer outset');
      close(m.composer.x, m.main.x + (m.main.width - column - 20) / 2, 'centered composer');
      close(m.user.width, Math.min(720, column - (column <= 480 ? 0 : 120)), 'user bubble cap');
      close(m.bot.width, Math.min(720, column - 38 - (column - 38 <= 480 ? 0 : 120)), 'reply bubble cap');
    };
    await check();
    await ui.capture('aligned');
    // Exercise the same mounted hook across the compact breakpoint, like opening a side panel.
    await page.locator('[data-ui-page-subject]').evaluate(el => {
      el.style.height = `${el.getBoundingClientRect().height}px`;
      el.style.width = '600px'; el.style.maxWidth = '100%'; el.style.flex = 'none';
    });
    await page.waitForFunction(() => {
      const main = document.querySelector('[data-testid="bot-group-timeline"]').closest('main');
      const expected = Math.min(914, main.getBoundingClientRect().width - 40);
      return Math.abs(parseFloat(main.style.getPropertyValue('--cindy-message-width')) - expected) < 1;
    });
    await check();
    await ui.capture('resized');
  },
};
