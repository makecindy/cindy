import { describe, expect, it } from 'vitest';

import { collectBotTimelineDateDividers, formatBotTimelineDate } from '@cindy/maker-shared/botTimeline';
import type { BotGroupDetail, BotGroupMessageView, BotGroupPlanView } from '../../../../shared/botGroupChat';
import {
  BOT_GROUP_MERGE_WINDOW_MS,
  botGroupHandoffStepNumbers,
  botGroupMemberBaseName,
  botGroupMemberDisplayName,
  botGroupOwnedBotNames,
  layoutBotGroupTimeline,
  matchBotGroupPendingSends,
  mergeBotGroupLatestPage,
  pendingBotGroupMessage,
  pendingBotGroupMessageId,
  settleBotGroupPendingSends,
  stabilizeById,
  type BotGroupLoadedTimeline,
  type BotGroupPendingSend,
} from '../BotGroupTimelineModel';

const DAY = new Date(2026, 9, 15, 10, 0).getTime();

function msg(overrides: Partial<BotGroupMessageView>): BotGroupMessageView {
  return {
    id: 'm', sequence: 1, kind: 'message', authorKind: 'bot', authorBotId: 'mimi', authorName: '咪咪', content: '',
    mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [], attachments: [], createdAt: DAY,
    ...overrides,
  };
}

function detail(messages: BotGroupMessageView[], hasMoreBefore: boolean, plans: BotGroupPlanView[] = []): BotGroupDetail {
  return {
    id: 'g1', name: 'g', replyMode: 'all', speakingMode: 'auto', members: [], organizerBotId: null, projectDir: null,
    lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null, createdAt: 1, updatedAt: 1,
    messages, hasMoreBefore, plans, round: { status: 'idle', speakers: [], canContinue: false },
  };
}

const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) =>
  msg({ id: `m${from + index}`, sequence: from + index, content: `第 ${from + index} 条` }));

describe('push refresh merge', () => {
  it('keeps rows pushed out of the latest page instead of leaving a gap', () => {
    const first: BotGroupLoadedTimeline = { group: detail(page(1, 3), true), older: [], olderPlans: [], olderHasMore: false };
    // Two new messages arrive; a three-message page no longer covers 1 and 2.
    const merged = mergeBotGroupLatestPage(first, detail(page(3, 5), true));
    expect(merged.group.messages.map((message) => message.id)).toEqual(['m3', 'm4', 'm5']);
    expect(merged.older.map((message) => message.id)).toEqual(['m1', 'm2']);
    // What the old latest page said about earlier history moves with them.
    expect(merged.olderHasMore).toBe(true);
    // Unchanged rows keep their objects (memoized rows do not re-render).
    expect(merged.older[0]).toBe(first.group.messages[0]);
    expect(merged.group.messages[0]).toBe(first.group.messages[2]);
  });

  it('updates rows inside the page range in place and hands back the same state when nothing changed', () => {
    const first: BotGroupLoadedTimeline = { group: detail(page(1, 3), false), older: [], olderPlans: [], olderHasMore: false };
    expect(mergeBotGroupLatestPage(first, detail(page(1, 3), false))).toBe(first);
    const edited = page(1, 3).map((message) => (message.id === 'm2' ? { ...message, reactions: [{ emoji: '👍', count: 1, me: true }] } : message));
    const merged = mergeBotGroupLatestPage(first, detail(edited, false));
    expect(merged).not.toBe(first);
    expect(merged.group.messages[0]).toBe(first.group.messages[0]);
    expect(merged.group.messages[1]!.reactions).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it('never drops pages opened with 「查看更早」', () => {
    const first: BotGroupLoadedTimeline = { group: detail(page(10, 12), true), older: page(1, 3), olderPlans: [], olderHasMore: true };
    const merged = mergeBotGroupLatestPage(first, detail(page(11, 13), false));
    expect(merged.older.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged.older).toBe(first.older);
  });

  // bot-group-chat.md §10「话题未读与提示」: older pages are not re-read, yet a Thread read meanwhile must lose its badge.
  it('gives Thread roots on pages opened with 「查看更早」 the unread state of the latest Thread list', () => {
    const root = msg({ id: 'm2', sequence: 2, replyCount: 2, threadUnread: { count: 2, mentioned: true, latest: 21 } });
    const first: BotGroupLoadedTimeline = { group: detail(page(10, 12), true), older: [msg({ id: 'm1', sequence: 1 }), root], olderPlans: [], olderHasMore: true };
    const thread = { rootId: 'm2', rootAuthorName: '咪咪', rootAuthorBotId: 'mimi', rootText: '', replyCount: 2, lastReply: null };
    const read = mergeBotGroupLatestPage(first, { ...detail(page(10, 12), true), threads: [{ ...thread, unread: { count: 0, mentioned: false } }] });
    expect(read.older[1]!.threadUnread).toEqual({ count: 0, mentioned: false });
    expect(read.older[0]).toBe(first.older[0]);
    // The same list again changes nothing.
    expect(mergeBotGroupLatestPage(read, { ...detail(page(10, 12), true), threads: [{ ...thread, unread: { count: 0, mentioned: false } }] })).toBe(read);
  });

  it('retains loaded history when exactly one full latest page arrives with no missing sequence', () => {
    const first: BotGroupLoadedTimeline = { group: detail(page(101, 200), true), older: page(1, 100), olderPlans: [], olderHasMore: false };
    const merged = mergeBotGroupLatestPage(first, detail(page(201, 300), true));
    expect(merged.older).toEqual([...first.older, ...first.group.messages]);
    expect(merged.older[0]).toBe(first.older[0]);
    expect(merged.older[199]).toBe(first.group.messages[99]);
    expect(merged.olderHasMore).toBe(false);
    expect(merged.group.messages).toEqual(page(201, 300));
  });

  it('starts over from a latest page that no longer reaches the rows on screen, so no gap hides between them', () => {
    // Opened older pages and the old latest page; then more than a page arrives at once (4-6 never seen).
    const first: BotGroupLoadedTimeline = { group: detail(page(10, 12), true), older: page(1, 3), olderPlans: [], olderHasMore: true };
    const merged = mergeBotGroupLatestPage(first, detail(page(16, 18), true));
    expect(merged.group.messages.map((message) => message.id)).toEqual(['m16', 'm17', 'm18']);
    // As on first load: 「查看更早」 reads on from right below the new page (13-15 included).
    expect(merged.older).toEqual([]);
    expect(merged.olderHasMore).toBe(true);
    // A page that still reaches the one on screen keeps the rows below it.
    expect(mergeBotGroupLatestPage(first, detail(page(12, 14), true)).older.map((message) => message.id))
      .toEqual(['m1', 'm2', 'm3', 'm10', 'm11']);
  });

  it('reuses an unchanged array as is', () => {
    const items = page(1, 2);
    expect(stabilizeById(items, items.map((item) => ({ ...item })))).toBe(items);
  });
});

describe('optimistic sends', () => {
  const send = (clientId: string, text: string, afterSequence = 2, messageId?: string): BotGroupPendingSend => ({
    clientId, text, mentions: { all: false, botIds: [] }, attachments: [], quote: null, createdAt: DAY, afterSequence,
    ...(messageId ? { messageId } : {}),
  });
  const own = (id: string, sequence: number, content: string) => msg({ id, sequence, content, authorKind: 'user', authorBotId: null, isSelf: true });

  it('matches an accepted send by message id and an unanswered one by its echo after it', () => {
    const pending = [send('a', '好', 2, 'srv-a'), send('b', '好')];
    const displayed = [own('old', 1, '好'), own('srv-a', 3, '好'), own('srv-b', 4, '好')];
    expect([...matchBotGroupPendingSends(pending, displayed)]).toEqual([['a', 'srv-a'], ['b', 'srv-b']]);
    expect(settleBotGroupPendingSends(pending, displayed)).toEqual([]);
  });

  it('never lets a later send of the same words claim the message an earlier send already became', () => {
    // 'a' settled into srv-a and left the pending list; 'b' (same words) is still on its way.
    const adopted = new Map([['srv-a', pendingBotGroupMessageId('a')]]);
    const displayed = [own('srv-a', 3, '好')];
    expect(matchBotGroupPendingSends([send('b', '好')], displayed, adopted).size).toBe(0);
    // Its own echo still settles it, and so does a re-render while 'a' itself is still pending.
    expect([...matchBotGroupPendingSends([send('b', '好')], [...displayed, own('srv-b', 4, '好')], adopted)]).toEqual([['b', 'srv-b']]);
    expect([...matchBotGroupPendingSends([send('a', '好')], displayed, adopted)]).toEqual([['a', 'srv-a']]);
  });

  it('keeps a send whose message has not arrived, and the same array when nothing settled', () => {
    const pending = [send('a', '好')];
    expect(settleBotGroupPendingSends(pending, [own('old', 1, '好')])).toBe(pending);
  });

  it('shows the pending copy as the reader’s own message', () => {
    const row = pendingBotGroupMessage(send('a', '你好'));
    expect(row).toMatchObject({ id: 'pending:a', pending: true, isSelf: true, authorKind: 'user', content: '你好' });
  });
});

describe('Telegram-style layout', () => {
  it('merges consecutive messages by one author within five minutes', () => {
    const rows = [
      msg({ id: 'a', createdAt: DAY }),
      msg({ id: 'b', createdAt: DAY + 60_000 }),
      msg({ id: 'c', createdAt: DAY + 60_000 + BOT_GROUP_MERGE_WINDOW_MS }),
      msg({ id: 'd', createdAt: DAY + 70_000 + BOT_GROUP_MERGE_WINDOW_MS, authorBotId: 'xiaoman', authorName: '小满' }),
      msg({ id: 'e', kind: 'notice', authorKind: 'system', createdAt: DAY + 80_000 + BOT_GROUP_MERGE_WINDOW_MS }),
      msg({ id: 'f', createdAt: DAY + 90_000 + BOT_GROUP_MERGE_WINDOW_MS, authorBotId: 'xiaoman', authorName: '小满' }),
      msg({ id: 'g', createdAt: DAY + 95_000 + BOT_GROUP_MERGE_WINDOW_MS, authorBotId: 'xiaoman', authorName: '小满', planId: 'p1' }),
    ];
    const layout = layoutBotGroupTimeline(rows);
    expect(rows.map((row) => layout.get(row.id)!.continued)).toEqual([false, true, false, false, false, false, false]);
  });

  it('starts every local day with a date divider and never merges across it', () => {
    const late = new Date(2026, 9, 14, 23, 58).getTime();
    const rows = [msg({ id: 'a', createdAt: late }), msg({ id: 'b', createdAt: late + 4 * 60_000 })];
    const layout = layoutBotGroupTimeline(rows);
    expect(layout.get('a')!.dateDivider).toBe(late);
    expect(layout.get('b')!.dateDivider).toBe(late + 4 * 60_000);
    expect(layout.get('b')!.continued).toBe(false);
    expect([...collectBotTimelineDateDividers([{ clientId: 'x', createdAt: DAY }, { clientId: 'y', createdAt: DAY + 1 }]).keys()]).toEqual(['x']);
  });

  it('names today and yesterday, and dates other days', () => {
    expect(formatBotTimelineDate(DAY, 'en', DAY + 60_000)).toBe('Today');
    expect(formatBotTimelineDate(DAY - 86_400_000, 'zh-CN', DAY)).toBe('昨天');
    expect(formatBotTimelineDate(DAY - 5 * 86_400_000, 'en', DAY)).toContain('10');
  });
});

describe('names in multi-owner groups', () => {
  const human = { botId: 'h', actorId: 'h', actorKind: 'human' as const, name: 'Chris', avatar: '', avatarColor: '', status: 'active' as const };
  const theirs = { botId: 'c', actorId: 'c', actorKind: 'bot' as const, name: 'Cindy (Chris)', ownerName: 'Chris', ownerActorId: 'h', isOwned: false, avatar: '', avatarColor: '', status: 'active' as const };
  const plain = { ...theirs, name: 'Dash', ownerName: 'Chris', isOwned: false };
  const mine = { ...theirs, name: 'LiZi', ownerName: 'Me', isOwned: true };

  it('shows another owner’s teammate as 伙伴名 (主人昵称), once', () => {
    expect(botGroupMemberDisplayName(theirs)).toBe('Cindy (Chris)');
    expect(botGroupMemberDisplayName(plain)).toBe('Dash (Chris)');
    expect(botGroupMemberDisplayName(mine)).toBe('LiZi');
    expect(botGroupMemberDisplayName(human)).toBe('Chris');
    expect(botGroupMemberBaseName(theirs)).toBe('Cindy');
  });

  it('lists the teammates a human brought in', () => {
    expect(botGroupOwnedBotNames(human, [human, theirs, mine])).toEqual(['Cindy', 'LiZi']);
    expect(botGroupOwnedBotNames(theirs, [human, theirs])).toEqual([]);
  });
});

describe('plan hand-offs', () => {
  it('tags each hand-off with its step, in order for a teammate with several steps', () => {
    const plan: BotGroupPlanView = {
      id: 'p1', status: 'running', organizerBotId: 'mimi', organizerName: '咪咪', currentStep: 2, workDir: null, branch: null, createdAt: 1, updatedAt: 1,
      steps: [
        { position: 0, botId: 'mimi', botName: '咪咪', task: 'a', status: 'done' },
        { position: 1, botId: 'xiaoman', botName: '小满', task: 'b', status: 'done' },
        { position: 2, botId: 'mimi', botName: '咪咪', task: 'c', status: 'running' },
      ],
    };
    const numbers = botGroupHandoffStepNumbers([
      msg({ id: 'h1', planId: 'p1' }),
      msg({ id: 'h2', planId: 'p1', authorBotId: 'xiaoman' }),
      msg({ id: 'h3', planId: 'p1' }),
      msg({ id: 'chat' }),
    ], new Map([['p1', plan]]));
    expect([...numbers]).toEqual([['h1', 1], ['h2', 2], ['h3', 3]]);
  });

  it('numbers hand-offs by the step they finished, through a redo and with earlier pages not loaded', () => {
    const plan: BotGroupPlanView = {
      id: 'p1', status: 'running', organizerBotId: 'mimi', organizerName: '咪咪', currentStep: 2, workDir: null, branch: null, createdAt: 1, updatedAt: 1,
      steps: [
        { position: 0, botId: 'mimi', botName: '咪咪', task: 'a', status: 'done', resultMessageId: 'h1-redo' },
        { position: 1, botId: 'xiaoman', botName: '小满', task: 'b', status: 'done', resultMessageId: 'h2' },
        { position: 2, botId: 'mimi', botName: '咪咪', task: 'c', status: 'done', resultMessageId: 'h3' },
      ],
    };
    const plans = new Map([['p1', plan]]);
    // Step 1 was redone after the user asked: its first hand-off is replaced, still step 1.
    const numbers = botGroupHandoffStepNumbers([
      msg({ id: 'h1', planId: 'p1' }),
      msg({ id: 'h1-redo', planId: 'p1' }),
      msg({ id: 'h2', planId: 'p1', authorBotId: 'xiaoman' }),
      msg({ id: 'h3', planId: 'p1' }),
    ], plans);
    expect(Object.fromEntries(numbers)).toEqual({ h1: 1, 'h1-redo': 1, h2: 2, h3: 3 });
    // Only the newest page is loaded: the third step is still the third step.
    expect(Object.fromEntries(botGroupHandoffStepNumbers([msg({ id: 'h3', planId: 'p1' })], plans))).toEqual({ h3: 3 });
  });
});
