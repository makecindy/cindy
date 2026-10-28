import { describe, expect, it } from 'vitest';
import {
  botGroupBodyParts,
  botGroupComposerPlanState,
  botGroupErrorVariant,
  botGroupNoticeVariant,
  botGroupPlanFollowUp,
  isBotGroupDivisionBlocked,
  mergeBotGroupMessages,
  projectBotGroupExecutionFailures,
  botGroupExecutionFailureBatches,
  chatGroupMembership,
  botGroupNewMessageCount,
  botGroupActivityAt,
  latestBotGroupMessage,
} from '../botGroupPresentation.js';
import { chatGroupTalkRouteKey, groupLaneOfRouteKey, isChatOnlyGroupLane, BOT_GROUP_RUNTIME_FAILURE_CODES, readBotGroupExecutionFailure, type BotGroupErrorCode, type BotGroupExecutionFailureView, type BotGroupMemberView, type BotGroupMessageView, type BotGroupNoticeCode, type BotGroupPlanView } from '../botGroupChat.js';

describe('group list activity', () => {
  it('keeps creation as a floor without treating settings edits as activity', () => {
    const group = { createdAt: 20, updatedAt: 100, lastMessage: null };
    expect(botGroupActivityAt(group)).toBe(20);
    expect(botGroupActivityAt({ ...group, lastMessage: { createdAt: 10 } })).toBe(20);
    expect(botGroupActivityAt({ ...group, lastMessage: { createdAt: 30 } })).toBe(30);
    expect(botGroupActivityAt({ createdAt: NaN, lastMessage: { createdAt: 30 } })).toBe(30);
    expect(botGroupActivityAt({ createdAt: 20, lastMessage: { createdAt: NaN } })).toBe(20);
  });

  it('selects topics and shared notices by exact server position without mutating the snapshot', () => {
    const main = { seq: '9007199254740992', deleted: false, threadRootId: null };
    const topic = { ...main, seq: '9007199254740993', threadRootId: 'root' };
    const joined = { ...main, seq: '9007199254740994', origin: 'system' };
    const deleted = { ...main, seq: '9007199254740995', deleted: true };
    const messages = Object.freeze([main, deleted, topic]);
    expect(latestBotGroupMessage(messages)).toBe(topic);
    expect(latestBotGroupMessage([joined, ...messages])).toBe(joined);
    expect(latestBotGroupMessage([deleted])).toBeUndefined();
    expect(latestBotGroupMessage([])).toBeUndefined();
  });
});

// Unit: history browsing needs an actionable count; old-page loads and repeated pushes are not arrivals.
it('counts only new messages from other people and companions below the observed tail', () => {
  const message = { id: 'new', sequence: 11, kind: 'message', authorKind: 'bot' } as BotGroupMessageView;
  const messages = [message, message, { ...message, id: 'human', isSelf: false, authorKind: 'user' as const },
    { ...message, id: 'history', sequence: 2 }, { ...message, id: 'mine', isSelf: true },
    { ...message, id: 'removed', deleted: true }, { ...message, id: 'thread', threadRootId: 'root' },
    { ...message, id: 'system', authorKind: 'system' as const }];
  expect(botGroupNewMessageCount(messages, null)).toBe(0);
  expect(botGroupNewMessageCount(messages, 10)).toBe(2);
  expect(botGroupNewMessageCount(messages, 11)).toBe(0);
  expect(botGroupNewMessageCount(messages, 10, 'root')).toBe(1);
  // Mobile presentation indices shift when history is prepended; server positions do not.
  expect(botGroupNewMessageCount([
    { ...message, id: 'history', sequence: 1, serverSequence: '9007199254740991' },
    { ...message, id: 'read', sequence: 2, serverSequence: '9007199254740992' },
    { ...message, id: 'arrival', sequence: 3, serverSequence: '9007199254740993' },
  ], '9007199254740992')).toBe(1);
});

describe('server group membership affordances', () => {
  const self = { actorId: 'self', isSelf: true, isOwned: true, role: 'member' } as BotGroupMemberView;
  const ownBot = { actorId: 'own-bot', actorKind: 'bot', isOwned: true, role: 'owner' } as BotGroupMemberView;
  const otherOwner = { actorId: 'other-owner', isOwned: false, role: 'owner' } as BotGroupMemberView;
  it.each([
    { members: [self, otherOwner], owner: false, manager: false, canLeave: true },
    { members: [{ ...self, role: 'admin' as const }, otherOwner], owner: false, manager: true, canLeave: true },
    { members: [{ ...self, role: 'owner' as const }], owner: true, manager: true, canLeave: false },
    { members: [self, ownBot], owner: true, manager: true, canLeave: false },
    { members: [{ ...self, role: 'owner' as const }, ownBot], owner: true, manager: true, canLeave: false },
    { members: [self, ownBot, otherOwner], owner: true, manager: true, canLeave: true },
    { members: [self, ownBot, { ...otherOwner, isOwned: undefined }], owner: true, manager: true, canLeave: false },
    { members: [otherOwner], owner: false, manager: false, canLeave: false },
  ])('projects owner=$owner, manager=$manager, canLeave=$canLeave for $members', ({ members, ...expected }) => {
    expect(chatGroupMembership({ serverBacked: true, members })).toMatchObject(expected);
  });
  it('does not infer a server permission for a legacy local group', () => {
    expect(chatGroupMembership({ members: [self, ownBot] })).toMatchObject({ owner: false, manager: false, canLeave: false });
  });
});

describe('execution failures are a projection of the current snapshot', () => {
  it('reconciles all loaded sources in bounded deduplicated requests', () => {
    const ids = Array.from({ length: 251 }, (_, n) => `source-${n}`);
    const batches = botGroupExecutionFailureBatches([...ids, ids[0], ids[250]]);
    expect(batches.map(batch => batch.length)).toEqual([100, 100, 51]);
    expect(batches.flat()).toEqual(ids);
    expect(botGroupExecutionFailureBatches([])).toEqual([]);
  });

  const source = { id: 'source', sequence: 4, kind: 'message', authorKind: 'user', authorBotId: null,
    authorName: 'Owner', content: 'Question', mentions: { all: false, botIds: [] }, noticeCode: null,
    planId: null, files: [], attachments: [], createdAt: 1 } as BotGroupMessageView;
  const failure: BotGroupExecutionFailureView = { executionId: 'run', epoch: 1, sourceMessageId: source.id,
    botId: 'bot', botName: 'Bot', code: 'AUTH_REQUIRED', planId: null };

  it('generates all failures beside the source after merging real pages', () => {
    const pages = mergeBotGroupMessages([source], [{ ...source, id: 'latest', sequence: 100 }]);
    expect(projectBotGroupExecutionFailures(pages, [failure, { ...failure, executionId: 'other' }]).map(item => item.id))
      .toEqual(['source', 'execution-failure:run:1', 'execution-failure:other:1', 'latest']);
    expect(pages.map(item => item.id)).toEqual(['source', 'latest']);
  });

  it('removes an old-page failure when the authorized snapshot clears it', () => {
    const pages = mergeBotGroupMessages([source], [{ ...source, id: 'latest', sequence: 100 }]);
    expect(projectBotGroupExecutionFailures(pages, [failure])).toHaveLength(3);
    expect(projectBotGroupExecutionFailures(pages, []).map(item => item.id)).toEqual(['source', 'latest']);
  });

  it('does not anchor a notice on a tombstone even if an older server returns that execution', () => {
    const deleted = { ...source, deleted: true };
    expect(projectBotGroupExecutionFailures([deleted], [failure])).toEqual([deleted]);
  });

  it('shows a new epoch and newly failed old source without reloading that message page', () => {
    expect(projectBotGroupExecutionFailures([source], [])).toEqual([source]);
    expect(projectBotGroupExecutionFailures([source], [{ ...failure, epoch: 2, code: 'QUOTA_EXCEEDED' }])[1])
      .toMatchObject({ id: 'execution-failure:run:2', runtimeFailureCode: 'QUOTA_EXCEEDED' });
    expect(projectBotGroupExecutionFailures([], [failure])).toEqual([]);
  });
});

describe('public failure snapshot decoder', () => {
  const row = { id: 'run', conversation_id: 'room', source_message_id: 'source', bot_id: 'bot', epoch: 2,
    plan_id: 'plan', updated_at: '2026-10-10T00:00:00Z', detail: 'private diagnostic' };
  it.each(BOT_GROUP_RUNTIME_FAILURE_CODES)('reads a new server snapshot without requiring legacy status: %s', code => {
    const view = readBotGroupExecutionFailure({ ...row, failure_code: code }, 'room');
    expect(view).toEqual({ executionId: 'run', epoch: 2, sourceMessageId: 'source', botId: 'bot', botName: '',
      code, planId: 'plan', updatedAt: Date.parse(row.updated_at) });
    expect(JSON.stringify(view)).not.toContain(row.detail);
  });
  it.each([{ status: 'running' }, { conversation_id: 'foreign' }, { epoch: NaN }, { epoch: -1 }, { source_message_id: null }])
    ('rejects inapplicable or malformed execution rows: %j', invalid => {
      expect(readBotGroupExecutionFailure({ ...row, ...invalid }, 'room')).toBeNull();
    });
  it('uses a fixed fallback for unknown categories and drops invalid timestamps', () => {
    expect(readBotGroupExecutionFailure({ ...row, failure_code: 'private diagnostic', updated_at: 'bad-date' }, 'room'))
      .toEqual({ executionId: 'run', epoch: 2, sourceMessageId: 'source', botId: 'bot', botName: '', code: 'RUNTIME_ERROR', planId: 'plan' });
  });
});

const plan = (overrides: Partial<BotGroupPlanView> = {}): BotGroupPlanView => ({
  id: 'p1', status: 'waiting', organizerBotId: 'a', organizerName: 'A', currentStep: 0, workDir: null, branch: null,
  createdAt: 1, updatedAt: 1,
  steps: [
    { position: 0, botId: 'a', botName: 'A', task: 'one', status: 'done' },
    { position: 1, botId: 'b', botName: 'B', task: 'two', status: 'pending' },
  ],
  ...overrides,
});

describe('bot group copy variants (shared by desktop and phone)', () => {
  it('speaks about a step for member notices inside a plan', () => {
    expect(botGroupNoticeVariant('member-joined', false)).toBe('memberJoined');
    expect(botGroupNoticeVariant('member-failed', false)).toBe('memberFailed');
    expect(botGroupNoticeVariant('member-failed', true)).toBe('stepFailed');
    expect(botGroupNoticeVariant('plan-stopped', true)).toBe('planStopped');
    expect(botGroupNoticeVariant(null, true)).toBeNull();
    // Untrusted codes from a newer host fall back to the message text.
    expect(botGroupNoticeVariant('toString' as BotGroupNoticeCode, false)).toBeNull();
  });

  it('names only the refusals the user can act on', () => {
    expect(botGroupErrorVariant('PLAN_OPEN')).toBe('planOpen');
    expect(botGroupErrorVariant('MENTION_UNAVAILABLE')).toBe('mentionUnavailable');
    expect(botGroupErrorVariant('INTERNAL')).toBeNull();
    expect(botGroupErrorVariant('constructor' as BotGroupErrorCode)).toBeNull();
    expect(botGroupErrorVariant(undefined)).toBeNull();
  });
});

describe('plan follow-up and composer state', () => {
  it('offers the next step after a finished one and a retry after a failed one', () => {
    expect(botGroupPlanFollowUp(plan())).toEqual({ kind: 'continue', next: plan().steps[1] });
    const failed = plan({ steps: [{ ...plan().steps[0]!, status: 'failed' }, plan().steps[1]!] });
    expect(botGroupPlanFollowUp(failed)).toEqual({ kind: 'retry', failed: failed.steps[0] });
    expect(botGroupPlanFollowUp(plan({ status: 'running' }))).toBeNull();
  });

  it('blocks a new 安排分工 while a plan runs or waits', () => {
    expect(isBotGroupDivisionBlocked(botGroupComposerPlanState(plan()))).toBe(true);
    expect(isBotGroupDivisionBlocked(botGroupComposerPlanState(plan({ status: 'proposed' })))).toBe(false);
    expect(botGroupComposerPlanState(plan())).toEqual({ kind: 'waiting', botName: 'A', stepDone: true });
  });

  // bot-group-chat.md §4.0: only words that will reach the speaking teammate are promised to it.
  // Legacy work plans still block a new division even when ordinary text stays quiet (unit).
  it.each(['running', 'waiting'] as const)('keeps the %s work-plan gate without promising unmentioned delivery', status => {
    const state = botGroupComposerPlanState(plan({ kind: 'work', status }), 'mentioned');
    expect(state).toMatchObject({ kind: status, botName: '' });
    expect(isBotGroupDivisionBlocked(state)).toBe(true);
  });

  it.each([
    ['who may add to it', 'running', true, 'all', { kind: 'running', botName: 'A', talk: true }],
    ['who cannot add to it', 'running', false, 'all', null],
    ['waiting for 继续', 'waiting', true, 'all', null],
    ['requiring an explicit mention', 'running', true, 'mentioned', null],
  ] as const)('gives a queue %s the matching composer state', (_label, status, canAdd, replyMode, expected) => {
    expect(botGroupComposerPlanState(plan({ kind: 'talk', status, canAdd }), replyMode)).toEqual(expected);
  });
});

// A queue lane keeps the grant's boundary: a chat-only queue turn is chat-only (no tools, no owner
// files) and works in its group lane's place (bot-group-chat.md §7.0).
describe('queue lanes', () => {
  it.each([['chat', true], ['owner', false], ['tools', false]] as const)('a %s queue lane is chat-only: %s', (mode, chatOnly) => {
    const key = chatGroupTalkRouteKey('g1', { mode, revision: 2 }, 'q1');
    expect(isChatOnlyGroupLane(key)).toBe(chatOnly);
    expect(groupLaneOfRouteKey(key)).toBe(`group:g1:access:${mode}:2`);
  });
});

// #6550: display-only projection. Existing presentation tests had no component bodies.
describe('group body component display', () => {
  const rich = (...nodes: Array<Record<string, unknown>>) => '```cindy-ui\n' + nodes.map((node, i) => JSON.stringify({ version: 1, seq: i + 1, op: 'create', id: `n${i}`, ...node })).join('\n') + '\n```';
  it('preserves a code caption as literal text after the code', () => {
    const content = rich({ kind: 'code', props: { text: 'const x = 1;', language: 'js', caption: '<name> *literal*' } });
    expect(botGroupBodyParts(content, 'bot')).toEqual([
      { kind: 'markdown', content: '```js\nconst x = 1;\n```' },
      { kind: 'text', content: '<name> *literal*' },
    ]);
  });
  it('retains the source block when a chart has an unavailable item', () => {
    const block = rich({ kind: 'chart', props: { label: 'Totals', data: [
      { label: 'Known', value: 3 }, { label: 'Missing', value: { ref: 'missing' } },
    ] } });
    expect(botGroupBodyParts('Before\n\n' + block + '\nAfter', 'bot')).toEqual([
      { kind: 'markdown', content: 'Before\n\n' },
      { kind: 'markdown', content: block + '\n' },
      { kind: 'markdown', content: 'After' },
    ]);
  });
  it('still projects a fully resolved chart including zero', () => {
    const content = rich({ kind: 'chart', props: { label: 'Totals', data: [
      { label: 'Zero', value: 0 }, { label: 'Known', value: 3 },
    ] } });
    expect(botGroupBodyParts(content, 'bot')).toEqual([{ kind: 'text', content: 'Totals\nZero: 0\nKnown: 3' }]);
  });
  it('keeps literal text literal, Markdown authored formatting, and surrounding prose in order', () => {
    const content = 'Before\n\n' + rich({ kind: 'text', props: { text: '<name> *literal* & \n    indented' } }, { kind: 'markdown', props: { text: '**bold**' } }) + '\nAfter';
    expect(botGroupBodyParts(content, 'bot')).toEqual([
      { kind: 'markdown', content: 'Before\n\n' },
      { kind: 'text', content: '<name> *literal* & \n    indented' },
      { kind: 'markdown', content: '**bold**' },
      { kind: 'markdown', content: 'After' },
    ]);
  });
  it.each(['', 'Normal **text**', '```json\n{"op":"create"}\n```', '````md\n```cindy-ui\nexample\n```\n````'])('preserves ordinary or example body %s', content => {
    expect(botGroupBodyParts(content, 'bot')).toEqual(content ? [{ kind: 'markdown', content }] : []);
  });
  it.each(['user', 'system'] as const)('does not convert %s authors', authorKind => {
    const content = rich({ kind: 'text', props: { text: 'Example' } });
    expect(botGroupBodyParts(content, authorKind)).toEqual([{ kind: 'markdown', content }]);
  });
  it.each([rich({ kind: 'text', props: { text: '' } }), rich({ kind: 'range' }), '```cindy-ui\ninvalid\n```'])('retains unreadable source %s', content => {
    expect(botGroupBodyParts(content, 'bot')).toEqual([{ kind: 'markdown', content }]);
  });
  it.each(['image', 'video', 'audio', 'svg'])('keeps %s descriptions but never an internal source or an attachment promise', kind => {
    for (const src of ['cindy-media://blobs/example.png', 'file:///private/image.png', 'xdt-file:///image.png', '/private/image.png', 'javascript:alert(1)', 'data:image/png;base64,AA==']) {
      expect(botGroupBodyParts(rich({ kind, props: { label: 'Title', alt: 'Description', caption: 'Caption', src } }), 'bot'))
        .toEqual([{ kind: 'text', content: 'Title\nDescription\nCaption' }]);
    }
  });
  // #7492 review: public media are not uploaded as attachments. Removing their
  // source erases the only access path; keep descriptions literal and emit a web link.
  it.each(['image', 'video', 'audio'])('preserves a public %s link with and without a description', kind => {
    const src = `https://example.test/public-${kind}`;
    expect(botGroupBodyParts(rich({ kind, props: { src, caption: '*literal* [caption]' } }), 'bot')).toEqual([
      { kind: 'text', content: '*literal* [caption]' },
      { kind: 'markdown', content: `<${src}>` },
    ]);
    expect(botGroupBodyParts(rich({ kind, props: { src } }), 'bot').at(-1))
      .toEqual({ kind: 'markdown', content: `<${src}>` });
  });
  it('encodes public media URL delimiters without creating additional Markdown content', () => {
    const src = 'http://example.test/image>![fake](file:///private/image.png)';
    expect(botGroupBodyParts(rich({ kind: 'image', props: { src } }), 'bot')).toEqual([
      { kind: 'text', content: '🖼' },
      { kind: 'markdown', content: '<http://example.test/image%3E![fake](file:///private/image.png)>' },
    ]);
  });
  it('keeps an undescribed image visible as a placeholder without exposing protocol source', () => {
    expect(botGroupBodyParts(rich({ kind: 'image', props: { src: 'cindy-media://blobs/example.png' } }), 'bot'))
      .toEqual([{ kind: 'text', content: '🖼' }]);
  });
  it('uses final tree content and exposes media descriptions without requesting local media', () => {
    const content = rich({ kind: 'stack', props: { label: 'Summary' } }, { parent: 'n0', kind: 'text', props: { text: 'Old' } },
      { op: 'patch', id: 'n1', props: { text: 'Updated' } }, { kind: 'image', props: { alt: 'Diagram', src: 'cindy-media://blobs/example.png' } });
    expect(botGroupBodyParts(content, 'bot')).toEqual([
      { kind: 'text', content: 'Summary' }, { kind: 'text', content: 'Updated' },
      { kind: 'text', content: 'Diagram' },
    ]);
  });
});
