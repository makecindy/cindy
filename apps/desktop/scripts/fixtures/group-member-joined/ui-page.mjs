import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';

const DAY_1 = Date.UTC(2026, 9, 2, 14, 20, 0);
const DAY_2 = Date.UTC(2026, 9, 3, 2, 10, 0);

const CROWD_NAMES = [
  '林青', 'Alex', '周宇', 'Chen', '陈默',
  'Mina', '许安', 'Sam', '苏禾', 'Kira',
  '沈舟', 'Liam', '顾言', 'Nora', '陆离', 'Owen',
];

export default {
  ...group,
  name: 'group-member-joined',
  entry: '../group-control/group-control-fixture.tsx',
  viewport: { width: 960, height: 760 },
  real: 'BotGroupChatView and BotGroupTimelineItem collapsing consecutive member-joined notices with inline expand in Light and Dark themes',
  notCovered: 'Server sync, push delivery, real IPC and native mobile UI',
  cases: {
    default: {
      about: 'Solo, pair, and mass cross-day member-joined notices before and after inline expansion',
      viewport: { width: 960, height: 760 },
      data: {
        name: '产品讨论群',
        members: [
          { botId: 'a', name: 'Cindy', assistant: true, isOwned: false },
          { botId: 'b', name: 'Nova', actorKind: 'human', isOwned: false },
        ],
        messages: 1,
        sidebar: false,
      },
    },
  },
  async check(page, ui) {
    await page.getByTestId('bot-group-timeline').waitFor();
    await page.evaluate(async ({ day1, day2, crowdNames }) => {
      const { group: detail } = await window.electronAPI.maker.getBotGroup('fixture-group');
      let seq = 1;
      const joined = (name, createdAt) => ({
        id: `join-${seq}`,
        sequence: seq++,
        kind: 'notice',
        authorKind: 'system',
        authorBotId: null,
        authorName: name,
        content: `${name}加入了群聊`,
        noticeCode: 'member-joined',
        planId: null,
        files: [],
        attachments: [],
        mentions: { all: false, botIds: [] },
        createdAt,
        threadRootId: null,
      });
      const msg = (authorKind, authorBotId, authorName, content, createdAt, isSelf = false) => ({
        id: `msg-${seq}`,
        sequence: seq++,
        kind: 'message',
        authorKind,
        authorBotId,
        authorName,
        isSelf,
        content,
        noticeCode: null,
        planId: null,
        files: [],
        attachments: [],
        mentions: { all: false, botIds: [] },
        createdAt,
        threadRootId: null,
      });
      detail.messages = [
        msg('bot', 'a', 'Cindy', 'IPTV 下个版本会优化，大家有其他建议也可以直接提。', day1),
        joined('Taylor', day1 + 60_000),
        msg('user', null, 'Me', '收到，先看看播放器的切换速度。', day1 + 120_000, true),
        joined('Alice', day1 + 180_000),
        joined('Bob', day1 + 210_000),
        msg('user', 'b', 'Nova', '拉了一批新朋友进群，欢迎大家！', day1 + 260_000, false),
        ...crowdNames.slice(0, 10).map((name, i) => joined(name, day1 + 300_000 + i * 30_000)),
        ...crowdNames.slice(10).map((name, i) => joined(name, day2 + i * 30_000)),
        msg('user', 'b', 'Nova', '大家先看置顶公告里的使用说明～', day2 + 600_000, false),
      ];
      window.__uiPage.emit('botGroupChanged', { groupId: detail.id, change: 'messages' });
    }, { day1: DAY_1, day2: DAY_2, crowdNames: CROWD_NAMES });

    const summary = page.getByTestId('bot-group-joined-summary');
    await summary.waitFor();
    assert.equal(await summary.getAttribute('aria-expanded'), 'false');
    await ui.capture('collapsed');

    await summary.click();
    assert.equal(await summary.getAttribute('aria-expanded'), 'true');
    await ui.capture('expanded');
  },
};
