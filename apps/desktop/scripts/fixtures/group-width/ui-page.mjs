import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';
import { checkSplit } from './split-check.mjs';

// Regression for #10810: the production group view must keep the same responsive
// content column, 720px bubble cap and responsive padding as tasks/private chats.
// Exercise real DOM geometry, including narrow panes and topic splits.
const tables = [
  '| 项目 | 进展 | 负责人 | 依赖 | 时间 | 风险 | 下一步 |',
  '|---|---|---|---|---|---|---|',
  '| 任务布局 | 明暗均已检查 | Aster | 实际面板宽度 | 本轮 | 边界溢出 | 拖动分栏后复查 |',
  '', '| 项目 | 状态 |', '|---|---|', '| 验证 | 完成 |',
].join('\n');
const data = { name: '群聊统一宽度检查', members: [{ botId: 'a', name: 'Aster' }], messages: 2, sidebar: false };
const widePreference = ratio => ({ 'chat.layoutMode': 'wide', 'chat.layoutWidthPercent': String(ratio) });
export default {
  ...group,
  name: 'group-width',
  entry: '../group-control/group-control-fixture.tsx',
  cases: { ...Object.fromEntries([1200, 800, 700, 699, 600, 559, 558, 520, 400].map(width => [width === 1200 ? 'default' : String(width), {
    about: 'Group messages and composer share task/private-chat width and responsive padding',
    viewport: { width, height: 900 }, data,
  }])), ...Object.fromEntries([1568, 1920, 2560].map(width => [`wide-${width}`, {
    about: 'Long messages from another human retain the shared reading cap with the sidebar expanded',
    viewport: { width, height: 900 }, data: { ...data, sidebar: true },
  }])), ...Object.fromEntries([1860, 3440].map(width => [`table-${width}`, {
    about: 'Opt-in wide group conversation with long and short tables',
    viewport: { width, height: 1080 }, storage: widePreference(75), data: { ...data, sidebar: true, wideTables: tables, ratio: 75 },
  }])), 'table-width-55': {
    about: 'The group conversation uses the same 55% width as a task with either a long or short table',
    viewport: { width: 1860, height: 1080 }, storage: widePreference(55),
    data: { ...data, sidebar: true, wideTables: tables, ratio: 55 },
  }, ...Object.fromEntries([1568, 960, 800, 660, 400].map(width => [`split-${width}`, {
    about: 'Sidebar and real topic splitter at both limits, with long content and independent drafts',
    viewport: { width, height: 900 }, storage: widePreference(100),
    data: { ...data, sidebar: width !== 400, bubbles: true, threadPanel: true, ratio: 100 },
  }])), private: {
    about: 'The shared group renderer uses the same bounded reading column for direct conversations',
    viewport: { width: 1920, height: 900 }, data: { ...data, direct: true },
  }, 'self-thread-share': {
    about: 'A self-shared thread reply with a long quote keeps its 560px column alongside the shared 720px bubble cap',
    viewport: { width: 1920, height: 900 }, data: { ...data, sidebar: true },
  } },
  async ready(page) {
    await group.ready(page);
    await page.evaluate(async () => {
      const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
      group.messages = group.messages.slice(0, 2).map((message, i) => ({
        ...message, authorKind: i ? 'bot' : 'user', authorBotId: i ? 'a' : null,
        id: i ? 'width-bot' : 'width-user', quote: undefined, threadPreview: undefined, replyCount: 0,
        authorName: i ? 'Aster' : '',
        content: i && window.__uiPage.ctx.data.wideTables
          ? `请检查大屏里不同长度的表格。\n\n${window.__uiPage.ctx.data.wideTables}`
          : (i ? '群聊长消息与私聊共用阅读宽度，小窗口里也要方便阅读。' : '请检查群聊在宽屏、中小窗口和话题分栏中的阅读效果。').repeat(18),
      }));
      window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
    });
    const bubble = page.getByTestId('bot-group-bubble');
    await bubble.waitFor();
    if (await page.evaluate(() => Boolean(window.__uiPage.ctx.data.wideTables))) {
      await bubble.locator('table').nth(1).waitFor();
    }
  },
  async check(page, ui) {
    if (ui.case.startsWith('split-')) return checkSplit(page, ui);
    if (ui.case === 'self-thread-share') return checkSelfThreadShare(page, ui);
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
      const bubble = document.querySelector('[data-testid="bot-group-bubble"]');
      return {
        tables: [...bubble.querySelectorAll('table')].map(table => ({
          width: table.getBoundingClientRect().width,
          viewport: table.parentElement.clientWidth,
        })),
        main: box(timeline.closest('main')), column: box(timeline.firstElementChild),
        composer: box(document.querySelector('textarea').parentElement),
        user: box(document.querySelector('[data-testid="bot-group-self-bubble"]')),
        bot: box(document.querySelector('[data-testid="bot-group-bubble"]')),
      };
    });
    const check = async () => {
      const m = await measure();
      const available = m.main.width - 40 - Math.min(60, Math.max(0, (m.main.width - 700) / 2));
      const column = ui.data.ratio === undefined ? Math.min(914, available)
        : Math.min(available, Math.max(660, available * ui.data.ratio / 100));
      const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1,
        `${label}: expected ${expected}px, got ${actual}px`);
      close(m.column.width, column, 'message column');
      close(m.column.x + m.column.width / 2, m.main.x + m.main.width / 2, 'centered messages');
      close(m.composer.width, column + 20, 'composer outset');
      close(m.composer.x, m.main.x + (m.main.width - column - 20) / 2, 'centered composer');
      for (const [name, bubble, available] of [['user', m.user, column], ['reply', m.bot, column - 38]]) {
        const cap = Math.min(720, available - (available <= 480 ? 0 : 120));
        if (ui.data.wideTables && name === 'reply') assert.ok(bubble.width > 0 && bubble.width <= cap + 1);
        else close(bubble.width, cap, `${name}: shared bubble width`);
      }
      assert.ok(await page.locator('.chat-bubble-toolbar').evaluateAll(elements => elements.every(el => {
        const r = el.getBoundingClientRect(), pane = el.closest('main').getBoundingClientRect();
        return r.left >= pane.left && r.right <= pane.right;
      })), 'message actions stay inside their pane');
    };
    await check();
    if (ui.data.wideTables) {
      const { main, column, composer, tables } = await measure();
      assert.ok(main.width >= 1600);
      assert.ok(Math.abs(column.width - (main.width - 100) * ui.data.ratio / 100) <= 1);
      assert.ok(Math.abs(composer.width - column.width - 20) <= 1);
      assert.ok(tables.length === 2 && tables.every(table => table.width <= table.viewport + 1));
      assert.ok(tables[0].width > tables[1].width * 2 && tables[1].width < 240, JSON.stringify(tables));
      console.log('GROUP_WIDTH', JSON.stringify({ case: ui.case, theme: ui.theme, main, column, composer, tables }));
      await ui.capture('wide-tables');
    }
    await ui.capture('aligned');
    // Resize the mounted pane, as when opening a sidebar; drafts and layout stay live.
    await page.locator('[data-ui-page-subject]').evaluate(el => {
      el.style.height = `${el.getBoundingClientRect().height}px`;
      el.style.width = '600px'; el.style.maxWidth = '100%'; el.style.flex = 'none';
    });
    await page.waitForFunction(() => {
      const main = document.querySelector('[data-testid="bot-group-timeline"]').closest('main');
      const expected = Math.min(914, main.getBoundingClientRect().width - (main.getBoundingClientRect().width < 700 ? 40 : 100));
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

// UI integration regression for PR #10810: the generic column override also
// widened the non-bubble self thread-share column. Existing cases had no shares.
// A shared reply with a long quote in a wide group reproduces the wrong cap;
// resize the same mounted view to ensure the retained cap still fits small panes.
async function checkSelfThreadShare(page, ui) {
  await page.evaluate(async () => {
    const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
    group.messages = group.messages.map((message, i) => i ? message : {
      ...message, content: '', isSelf: true, reactions: [],
      quote: {
        messageId: 'width-bot', authorKind: 'bot', authorName: 'Aster',
        excerpt: group.messages[1].content, attachmentCount: 0, attachmentName: null,
        sequence: group.messages[1].sequence,
      },
      threadShare: {
        messageId: 'shared-reply', threadRootId: 'width-bot', status: 'available',
        authorKind: 'user', authorBotId: null, authorName: 'You', sharedByAuthor: true,
        content: '贴回的话题内容保留原有阅读宽度。'.repeat(20),
        attachments: [], createdAt: message.createdAt, edited: false, version: 1,
      },
    });
    window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
  });
  const row = page.locator('[data-bot-group-message-id="width-user"]');
  await row.locator('figure').waitFor();
  const check = async () => {
    const m = await row.evaluate(el => {
      const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; };
      return {
        pane: box(el.closest('main')), available: box(el.querySelector('.chat-bubble-layout')).width,
        column: box(el.querySelector('.chat-bubble-column')), card: box(el.querySelector('figure')),
        actions: box(el.querySelector('.chat-bubble-toolbar')),
      };
    });
    const expected = Math.min(560, m.available - (m.available <= 480 ? 0 : 120));
    assert.ok(Math.abs(m.column.width - expected) <= 1,
      `self thread-share column: expected ${expected}px, got ${m.column.width}px`);
    assert.ok(Math.abs(m.column.width - m.card.width) <= 1, 'share column and card keep the same width');
    for (const box of [m.column, m.card, m.actions]) {
      assert.ok(box.x >= m.pane.x && box.right <= m.pane.right, 'shared reply and actions stay inside the pane');
    }
  };
  await row.scrollIntoViewIfNeeded();
  await ui.capture('wide-share');
  await check();
  assert.ok(Math.abs((await page.getByTestId('bot-group-bubble').boundingBox()).width - 720) <= 1,
    'ordinary long group messages retain the shared 720px reading cap');
  await page.locator('[data-ui-page-subject]').evaluate(el => {
    el.style.height = `${el.getBoundingClientRect().height}px`;
    el.style.width = '400px'; el.style.maxWidth = '100%'; el.style.flex = 'none';
  });
  await page.waitForFunction(() => {
    const main = document.querySelector('[data-testid="bot-group-timeline"]').closest('main');
    return Math.abs(parseFloat(main.style.getPropertyValue('--cindy-message-width')) - 360) < 1;
  });
  await check();
  await row.scrollIntoViewIfNeeded();
  await ui.capture('narrow-share');
  // Restore the wide pane so the final before/after capture compares the same state.
  await page.locator('[data-ui-page-subject]').evaluate(el => {
    el.style.width = ''; el.style.flex = '';
  });
  await page.waitForFunction(() => {
    const column = document.querySelector('[data-bot-group-message-id="width-user"] .chat-bubble-column');
    return Math.abs(column.getBoundingClientRect().width - 560) < 1;
  });
  await check();
}
