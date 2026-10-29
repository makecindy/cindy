import { describe, expect, it } from 'vitest';

import {
  filterBotGroupMentionCandidates,
  findBotGroupMentionQuery,
  insertBotGroupMention,
  resolveBotGroupMentions,
  retainBotGroupTrackedMentions,
  splitBotGroupMentionSegments,
  splitBotGroupRelaySteps,
} from '../botGroupMentions';
import {
  continuableRoundEndId,
  mergeBotGroupMessages,
} from '../botGroupPresentation';
import type { BotGroupMessageView } from '../../../../shared/botGroupChat';

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

  it('routes a picked owner-qualified name to only that companion and keeps short-name mentions', () => {
    const sameName = [
      { botId: 'chris-cindy', name: 'Cindy (Chris)', displayName: 'Cindy' },
      { botId: 'alex-cindy', name: 'Cindy (Alex Chen)', displayName: 'Cindy' },
    ];
    const picked = insertBotGroupMention('@Ci', { start: 0, end: 3 }, sameName[1].name);
    expect(resolveBotGroupMentions(picked.text, { members: sameName, allLabels: [] }).botIds).toEqual(['alex-cindy']);
    expect(resolveBotGroupMentions('@Cindy hi', { members: sameName.slice(0, 1), allLabels: [] }).botIds).toEqual(['chris-cindy']);
    const renamed = [{ ...sameName[0], name: '小辛 (Chris)', nickname: '小辛' }];
    expect(resolveBotGroupMentions('@小辛帮我看看', { members: renamed, allLabels: [] }).botIds).toEqual(['chris-cindy']);
    expect(resolveBotGroupMentions('@Cindy hi', { members: renamed, allLabels: [] }).botIds).toEqual([]);
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
        tracked: [{ botId: 'b', label: '小满', start: 0 }],
      }).botIds,
    ).toEqual(['b']);
  });
});

describe('stale explicit picks', () => {
  it('routes each same-name token independently and clears only the deleted picked occurrence', () => {
    const tracked = [{ botId: 'departed', label: 'Ann', start: 0 }];
    const input = { members: [{ botId: 'current', name: 'Ann' }], allLabels: [], tracked };
    expect(resolveBotGroupMentions('@Ann @Ann', input).botIds).toEqual(['departed', 'current']);
    const firstRemoved = retainBotGroupTrackedMentions('@Ann @Ann', '@Ann', { ...input, editStart: 0 });
    expect(firstRemoved).toEqual([]);
    expect(resolveBotGroupMentions('@Ann', { ...input, tracked: firstRemoved }).botIds).toEqual(['current']);
    const secondRemoved = retainBotGroupTrackedMentions('@Ann @Ann', '@Ann', { ...input, editStart: 4 });
    expect(secondRemoved).toEqual(tracked);
    expect(resolveBotGroupMentions('@Ann', { ...input, tracked: secondRemoved }).botIds).toEqual(['departed']);
    // Pasting the same characters over the picked token creates a manual token.
    expect(retainBotGroupTrackedMentions('@Ann @Ann', '@Ann @Ann', { ...input, editStart: 0, editEnd: 4 })).toEqual([]);
  });

  it('moves a picked identity with edits before it and discards edits inside its token', () => {
    const input = { members: [], allLabels: [], tracked: [{ botId: 'departed', label: 'Ann', start: 3 }] };
    const shifted = retainBotGroupTrackedMentions('hi @Ann', 'hello @Ann', { ...input, editStart: 1 });
    expect(shifted).toEqual([{ botId: 'departed', label: 'Ann', start: 6 }]);
    expect(resolveBotGroupMentions('hello @Ann', { ...input, tracked: shifted }).botIds).toEqual(['departed']);
    expect(retainBotGroupTrackedMentions('hi @Ann', 'hi @Anna', { ...input, editStart: 7 })).toEqual([]);
    expect(retainBotGroupTrackedMentions('hi @Ann', 'hi @An', { ...input, editStart: 6 })).toEqual([]);
  });

  it('retains only picked labels that still form mention tokens after a text edit', () => {
    const tracked = [{ botId: 'departed', label: 'Ann', start: 0 }, { botId: 'picked', label: '小满', start: 11 }];
    const input = { members: [{ botId: 'longer', name: '小满满' }], allLabels: ['所有人'], tracked };
    const draft = '@Ann hello @小满';
    expect(retainBotGroupTrackedMentions(draft, draft, input)).toEqual(tracked);
    expect(retainBotGroupTrackedMentions(draft, '@所有人 @Anna ann@Ann.com @小满满', input)).toEqual([]);
    expect(retainBotGroupTrackedMentions(draft, '@Ann hello', input)).toEqual([tracked[0]]);
  });

  it('retains a selected target after roster removal rather than making it unaddressed or retargeting a namesake', () => {
    const tracked = [{ botId: 'departed', label: 'Ann', start: 0 }];
    for (const current of [[], [{ botId: 'namesake', name: 'Ann' }]]) {
      expect(resolveBotGroupMentions('@Ann hello', { members: current, allLabels: [], tracked })).toEqual({ all: false, botIds: ['departed'] });
    }
    expect(resolveBotGroupMentions('hello', { members: [], allLabels: [], tracked })).toEqual({ all: false, botIds: [] });
    expect(resolveBotGroupMentions('@Anna hello', { members: [], allLabels: [], tracked })).toEqual({ all: false, botIds: [] });
  });

  it('keeps a picked companion named like a 「所有人」 label through edits; typing the word still means everyone', () => {
    const allLabels = ['所有人', 'all', 'everyone'];
    for (const name of allLabels) {
      const members = [{ botId: 'namesake', name }, { botId: 'xiaoman', name: '小满' }];
      const tracked = [{ botId: 'namesake', label: name, start: 0 }];
      const draft = `@${name} 看下`;
      const input = { members, allLabels, tracked };
      expect(resolveBotGroupMentions(draft, input)).toEqual({ all: false, botIds: ['namesake'] });
      // An edit elsewhere keeps the pick; resolving alone is not enough if retaining drops it.
      const edited = `${draft} @小满`;
      const kept = retainBotGroupTrackedMentions(draft, edited, { ...input, editStart: draft.length });
      expect(kept).toEqual(tracked);
      expect(resolveBotGroupMentions(edited, { ...input, tracked: kept })).toEqual({ all: false, botIds: ['namesake', 'xiaoman'] });
      // Retyping the token forgets the pick, and a typed reserved word addresses everyone.
      const retyped = retainBotGroupTrackedMentions(draft, draft, { ...input, editStart: 0, editEnd: name.length + 1 });
      expect(retyped).toEqual([]);
      expect(resolveBotGroupMentions(draft, { ...input, tracked: retyped })).toEqual({ all: true, botIds: [] });
      // A departed pick stays an explicit target for the host to reject, never everyone.
      expect(resolveBotGroupMentions(draft, { members: [], allLabels, tracked })).toEqual({ all: false, botIds: ['namesake'] });
    }
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

// bot-group-chat.md §7.0: a 分工 request that writes out its steps becomes the card as written;
// anything else must stay with the organizer, so a mention inside a sentence never splits work.
describe('splitBotGroupRelaySteps', () => {
  const split = (text: string) => splitBotGroupRelaySteps(text, { members, allLabels: ['所有人'] });

  it.each([
    ['one line per step', '@阿布 出方案\n@小满 按方案实现', [['abu', '出方案'], ['xiaoman', '按方案实现']]],
    ['punctuation and connectors', '做登录页：@阿布 出方案，然后 @小满 实现；最后 @咪咪 测一遍。',
      [['abu', '出方案'], ['xiaoman', '实现'], ['mimi', '测一遍']]],
    ['one teammate', '@Ann review the diff', [['ann', 'review the diff']]],
    // A connector only leads into the next step: the last step keeps it, and words merely ending in one keep theirs.
    ['a last step ending like a connector', '@阿布 出方案，then @Ann decide what to do next', [['abu', '出方案'], ['ann', 'decide what to do next']]],
    ['a word ending like a connector', '@Ann add context\n@阿布 实现', [['ann', 'add context'], ['abu', '实现']]],
  ] as const)('reads %s', (_label, text, expected) => {
    expect(split(text)).toEqual(expected.map(([botId, task]) => ({ botId, task })));
  });

  it.each([
    ['a mention inside a sentence', '@阿布 和 @小满 一起做登录页'],
    ['a step without a task', '@阿布，@小满 实现'],
    ['everyone', '@所有人 出方案，@小满 实现'],
    ['no mention', '做一个登录页'],
    // A teammate renamed after being picked no longer reads as one: its step must not vanish.
    ['an @ that is no longer a teammate', '@Old 出方案，@小满 实现，@阿布 测一遍'],
    ['an @ inside a task', '@小满 实现，@Old 测一遍'],
  ])('leaves %s to the organizer', (_label, text) => {
    expect(split(text)).toBeNull();
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
    planId: null,
    files: [],
    attachments: [],
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

  it('merges pages by sequence', () => {
    const merged = mergeBotGroupMessages(
      [message({ id: 'a', sequence: 1 }), message({ id: 'b', sequence: 2 })],
      [message({ id: 'b2', sequence: 2 }), message({ id: 'c', sequence: 3 })],
    );
    expect(merged.map((item) => item.id)).toEqual(['a', 'b2', 'c']);
  });
});
