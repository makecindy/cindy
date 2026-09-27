import { describe, expect, it } from 'vitest';

import {
  filterBotGroupMentionCandidates,
  findBotGroupMentionQuery,
  insertBotGroupMention,
  resolveBotGroupMentions,
  splitBotGroupMentionSegments,
} from '../botGroupMentions';
import {
  continuableRoundEndId,
  mergeBotGroupMessages,
  sortBotGroups,
} from '../botGroupPresentation';
import type { BotGroupMessageView, BotGroupSummary } from '../../../../shared/botGroupChat';

const members = [
  { botId: 'mimi', name: '咪咪' },
  { botId: 'xiaoman', name: '小满' },
  { botId: 'abu', name: '阿布' },
  { botId: 'ann', name: 'Ann' },
];

describe('resolveBotGroupMentions', () => {
  it('re-derives mentions from the text, in the order they were mentioned', () => {
    expect(
      resolveBotGroupMentions('@阿布 看下天气，@小满帮我查余票', { members, allLabels: ['所有人'] }),
    ).toEqual({ all: false, botIds: ['abu', 'xiaoman'] });
  });

  it('recognizes @everyone and plain text without mentions', () => {
    expect(resolveBotGroupMentions('@所有人 周六去哪？', { members, allLabels: ['所有人'] })).toEqual({
      all: true,
      botIds: [],
    });
    expect(resolveBotGroupMentions('大家好', { members, allLabels: ['所有人'] })).toEqual({
      all: false,
      botIds: [],
    });
  });

  it('keeps word boundaries for Latin names and ignores e-mail addresses', () => {
    expect(resolveBotGroupMentions('@Anna hi', { members, allLabels: [] }).botIds).toEqual([]);
    expect(resolveBotGroupMentions('@Ann, hi', { members, allLabels: [] }).botIds).toEqual(['ann']);
    expect(resolveBotGroupMentions('mail ann@Ann.com', { members, allLabels: [] }).botIds).toEqual([]);
  });

  it('prefers the longest name and uses tracked picks only to split duplicates', () => {
    const duplicates = [
      { botId: 'a', name: '小满' },
      { botId: 'b', name: '小满' },
      { botId: 'c', name: '小满满' },
    ];
    expect(resolveBotGroupMentions('@小满满 在吗', { members: duplicates, allLabels: [] }).botIds).toEqual(['c']);
    expect(resolveBotGroupMentions('@小满 在吗', { members: duplicates, allLabels: [] }).botIds).toEqual(['a', 'b']);
    expect(
      resolveBotGroupMentions('@小满 在吗', {
        members: duplicates,
        allLabels: [],
        tracked: [{ botId: 'b', label: '小满' }],
      }).botIds,
    ).toEqual(['b']);
  });
});

describe('mention picker helpers', () => {
  it('finds the query typed right before the caret', () => {
    expect(findBotGroupMentionQuery('帮我查一下 @小', 8)).toEqual({ start: 6, query: '小' });
    expect(findBotGroupMentionQuery('帮我查@', 4)).toEqual({ start: 3, query: '' });
    expect(findBotGroupMentionQuery('@小满 帮我', 6)).toBeNull();
    expect(findBotGroupMentionQuery('ann@example', 11)).toBeNull();
  });

  it('filters candidates with prefix matches first', () => {
    const candidates = [{ name: 'Planner' }, { name: 'Ann' }, { name: 'Anna' }];
    expect(filterBotGroupMentionCandidates('an', candidates).map((item) => item.name)).toEqual([
      'Ann',
      'Anna',
      'Planner',
    ]);
    expect(filterBotGroupMentionCandidates('', candidates)).toHaveLength(3);
  });

  it('inserts the picked name with one trailing space', () => {
    expect(insertBotGroupMention('查余票 @小', { start: 4, end: 6 }, '小满')).toEqual({
      text: '查余票 @小满 ',
      caret: 8,
    });
    expect(insertBotGroupMention('@小 在吗', { start: 0, end: 2 }, '小满')).toEqual({
      text: '@小满 在吗',
      caret: 4,
    });
  });

  it('splits message text into mention chips', () => {
    expect(splitBotGroupMentionSegments('@小满 帮我查余票', ['小满', '所有人'])).toEqual([
      { text: '@小满', mention: true },
      { text: ' 帮我查余票', mention: false },
    ]);
  });
});

function message(overrides: Partial<BotGroupMessageView>): BotGroupMessageView {
  return {
    id: 'm',
    sequence: 1,
    kind: 'message',
    authorKind: 'user',
    authorBotId: null,
    authorName: '',
    content: '',
    mentions: { all: false, botIds: [] },
    noticeCode: null,
    createdAt: 1,
    ...overrides,
  };
}

describe('group presentation', () => {
  it('offers 「继续讨论」 only on the newest round end of an idle, continuable round', () => {
    const messages = [
      message({ id: 'end-1', kind: 'round-end' }),
      message({ id: 'user-2' }),
      message({ id: 'end-2', kind: 'round-end' }),
    ];
    expect(continuableRoundEndId(messages, { status: 'idle', canContinue: true })).toBe('end-2');
    expect(continuableRoundEndId(messages, { status: 'idle', canContinue: false })).toBeNull();
    expect(continuableRoundEndId(messages, { status: 'running', canContinue: true })).toBeNull();
  });

  it('merges pages by sequence and sorts groups by latest activity', () => {
    const merged = mergeBotGroupMessages(
      [message({ id: 'a', sequence: 1 }), message({ id: 'b', sequence: 2 })],
      [message({ id: 'b2', sequence: 2 }), message({ id: 'c', sequence: 3 })],
    );
    expect(merged.map((item) => item.id)).toEqual(['a', 'b2', 'c']);

    const group = (id: string, updatedAt: number, lastAt?: number): BotGroupSummary => ({
      id,
      name: id,
      replyMode: 'all',
      speakingMode: 'auto',
      members: [],
      lastMessage: lastAt ? { authorKind: 'user', authorName: '', preview: '', createdAt: lastAt } : null,
      speakingBotIds: [],
      createdAt: 0,
      updatedAt,
    });
    expect(sortBotGroups([group('old', 1), group('new', 1, 9), group('mid', 5)]).map((item) => item.id)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });
});
