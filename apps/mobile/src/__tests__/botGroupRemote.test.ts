import { describe, expect, it } from 'vitest';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import {
  botGroupChatDataFromResource,
  botGroupErrorCode,
  botGroupMemberAvatar,
  botGroupMemberLinks,
  createdBotGroupId,
  hasBotGroupCollection,
  nextBotGroupSendAttempt,
  orderedBotGroups,
  parseBotGroupChatData,
} from '@/session/botGroupRemote';

function chatData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g1', name: '官网介绍页', replyMode: 'all', speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '🐱', avatarColor: 'red', status: 'active' },
      { botId: 'abu', name: '阿布', avatar: 'cindy://avatar/preset/dash', avatarColor: 'blue', status: 'paused' },
    ],
    organizerBotId: 'mimi', projectDir: '/Users/me/site', projectDirName: 'site',
    lastMessage: { authorKind: 'bot', authorName: '阿布', preview: '写好了', createdAt: 50 },
    speakingBotIds: [], planningBotId: null, openPlan: { id: 'p1', status: 'waiting', currentStep: 0, stepCount: 2, currentBotName: '咪咪', currentStepStatus: 'done' },
    createdAt: 1, updatedAt: 40,
    messages: [
      { id: 'm2', sequence: 2, kind: 'plan', authorKind: 'bot', authorBotId: 'mimi', authorName: '咪咪', content: '', mentions: { all: false, botIds: [] }, noticeCode: null, planId: 'p1', files: [], createdAt: 20 },
      { id: 'm1', sequence: 1, kind: 'message', authorKind: 'user', authorBotId: null, authorName: '', content: '做个页面', mentions: { all: true, botIds: ['mimi', 7] }, noticeCode: null, planId: null, files: [], createdAt: 10 },
      { id: 'm3', sequence: 3, kind: 'future-kind', authorKind: 'bot', authorBotId: 'abu', authorName: '阿布', content: 'x', createdAt: 30 },
      { id: 'm4', sequence: 4, kind: 'notice', authorKind: 'system', authorBotId: 'abu', authorName: '阿布', content: 'fallback', noticeCode: 'something-new', planId: null, files: 'nope', createdAt: 40 },
      'garbage',
    ],
    hasMoreBefore: true,
    round: { status: 'running', speakers: [{ botId: 'abu', sessionId: 's1', activity: 'step' }, { botId: 5 }], canContinue: false },
    plans: [
      { id: 'p1', status: 'waiting', organizerBotId: 'mimi', organizerName: '咪咪', currentStep: 0, workDir: '/Users/me/site/.cindy-worktrees/x', branch: 'cindy/x', createdAt: 1, updatedAt: 2,
        steps: [
          { position: 0, botId: 'mimi', botName: '咪咪', task: '想清楚', status: 'done' },
          { position: 1, botId: 'abu', botName: '阿布', task: '写代码', status: 'pending' },
        ] },
      { id: 'p0', status: 'done', organizerBotId: 'mimi', organizerName: '咪咪', currentStep: 0, steps: [{ position: 0, botId: 'mimi', task: 'x', status: 'weird' }] },
    ],
    ...overrides,
  };
}

describe('parseBotGroupChatData', () => {
  it('validates the host projection field by field and keeps host paths off the phone', () => {
    const parsed = parseBotGroupChatData(chatData())!;
    expect(parsed.messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm4']);
    expect(parsed.messages[0]!.mentions).toEqual({ all: true, botIds: ['mimi'] });
    // Unknown notice codes keep the message and fall back to its text.
    expect(parsed.messages[2]).toMatchObject({ kind: 'notice', noticeCode: null, content: 'fallback', files: [] });
    expect(parsed.members[1]!.status).toBe('paused');
    expect(parsed.projectDir).toBeNull();
    expect(parsed.projectDirName).toBe('site');
    expect(parsed.plans.map((plan) => plan.id)).toEqual(['p1']);
    expect(parsed.plans[0]!.workDir).toBeNull();
    expect(parsed.round).toEqual({ status: 'running', speakers: [{ botId: 'abu', sessionId: 's1', activity: 'step' }], canContinue: false });
    expect(parsed.openPlan).toMatchObject({ id: 'p1', status: 'waiting', currentStepStatus: 'done' });
    expect(parsed.hasMoreBefore).toBe(true);
  });

  it('rejects data without the essentials', () => {
    expect(parseBotGroupChatData(null)).toBeNull();
    expect(parseBotGroupChatData(chatData({ id: '' }))).toBeNull();
    expect(parseBotGroupChatData(chatData({ members: 'x' }))).toBeNull();
    expect(parseBotGroupChatData(chatData({ messages: undefined }))).toBeNull();
  });

  it('reads only the declared chat block of a resource', () => {
    expect(botGroupChatDataFromResource({ blocks: [{ id: 'chat', primitive: 'markdown', fallbackMarkdown: 'x' }] })).toBeNull();
    expect(botGroupChatDataFromResource({ blocks: [{ id: 'chat', primitive: 'bot-group-chat', fallbackMarkdown: '', data: chatData() }] })?.id).toBe('g1');
  });
});

describe('group rows', () => {
  const row = (deviceId: string, id: string, timestamp: number, title = id): HostedRemoteCollectionItem => ({
    key: `${deviceId}:${id}`, host: { deviceId, deviceName: deviceId },
    item: {
      ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: '1',
      display: { title, subtitle: '咪咪、阿布', timestamp },
      links: [
        { rel: 'member', target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'mimi' } }, label: '咪咪' },
        { rel: 'member', target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'mimi' } }, label: '咪咪' },
        { rel: 'member', target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'abu' } }, label: { fallback: 'Abu', translations: { 'zh-CN': '阿布' } } },
        { rel: 'conversation', target: { kind: 'session', sessionId: 's' } },
      ],
    },
  });

  it('lists members in order from the member links, once each', () => {
    expect(botGroupMemberLinks(row('mac', 'g1', 1).item, 'zh-CN')).toEqual([
      { botId: 'mimi', label: '咪咪' },
      { botId: 'abu', label: '阿布' },
    ]);
  });

  it('orders by latest activity and filters by group or member name', () => {
    const rows = [row('mac', 'old', 1, '周末'), row('mac', 'new', 5, '官网'), row('pc', 'new', 3, '官网')];
    expect(orderedBotGroups(rows, '', 'zh-CN').map((entry) => entry.key)).toEqual(['mac:new', 'pc:new', 'mac:old']);
    expect(orderedBotGroups(rows, '周末', 'zh-CN').map((entry) => entry.key)).toEqual(['mac:old']);
    expect(orderedBotGroups(rows, '阿布', 'zh-CN')).toHaveLength(3);
    expect(orderedBotGroups(rows, 'nobody', 'zh-CN')).toEqual([]);
  });

  it('detects hosts that advertise group chats', () => {
    expect(hasBotGroupCollection({ collections: [{ id: 'bot-groups', resourceKind: 'bot-group' }] })).toBe(true);
    expect(hasBotGroupCollection({ collections: [{ id: 'teammates', resourceKind: 'bot' }] })).toBe(false);
    expect(hasBotGroupCollection(null)).toBe(false);
  });
});

describe('actions', () => {
  it.each([
    [Object.assign(new Error('PLAN_OPEN'), { code: 'INVALID_PARAMS' }), 'PLAN_OPEN'],
    ['[INVALID_PARAMS] MEMBER_LIMIT', 'MEMBER_LIMIT'],
    [new Error('[NOT_FOUND] NOT_FOUND'), 'NOT_FOUND'],
    [new Error('[INVALID_PARAMS] MEMBER_UNAVAILABLE'), 'MEMBER_UNAVAILABLE'],
    [new Error('[NOT_CONNECTED] not online within 1500ms'), null],
    [new Error('XPLAN_OPEN'), null],
  ])('reads the group error code of %s', (error, code) => {
    expect(botGroupErrorCode(error)).toBe(code);
  });

  it('finds the new group in the create receipt', () => {
    expect(createdBotGroupId([
      { kind: 'refresh-collection', collectionId: 'bot-groups' },
      { kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g9' } } },
    ])).toBe('g9');
    expect(createdBotGroupId([{ kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'x' } } }])).toBeNull();
    expect(createdBotGroupId(undefined)).toBeNull();
  });

  it('projects a member avatar like the teammates collection', () => {
    expect(botGroupMemberAvatar({ name: '咪咪', avatar: '🐱', avatarColor: 'red' })).toEqual({ kind: 'emoji', value: '🐱', fallbackText: '咪', color: 'red' });
    expect(botGroupMemberAvatar({ name: 'A', avatar: 'cindy://avatar/preset/cindy', avatarColor: '' }).kind).toBe('asset');
    expect(botGroupMemberAvatar({ name: 'A', avatar: 'cindy-media://avatar/x.png', avatarColor: '' }).kind).toBe('media');
    expect(botGroupMemberAvatar({ name: 'A', avatar: '', avatarColor: '' }).kind).toBe('text');
  });

  it('reuses the clientId only for the same text and the same 分工 tag', () => {
    let serial = 0;
    const next = () => `c${++serial}`;
    const first = nextBotGroupSendAttempt(null, 'hi', false, next);
    expect(nextBotGroupSendAttempt(first, 'hi', false, next)).toBe(first);
    expect(nextBotGroupSendAttempt(first, 'hi', true, next).clientId).toBe('c2');
    expect(nextBotGroupSendAttempt(first, 'hello', false, next).clientId).toBe('c3');
  });
});
