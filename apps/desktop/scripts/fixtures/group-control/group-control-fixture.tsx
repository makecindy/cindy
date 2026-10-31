import { makerChatStore } from '../../../src/renderer/lib/makerChatStore';
import { useEffect, useRef } from 'react';
import { Route, Routes, useSearchParams } from 'react-router-dom';
import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotGroupChatView } from '../../../src/renderer/features/bots/BotGroupChatView';
import { BotGroupSettingsDrawer } from '../../../src/renderer/features/bots/BotGroupSettingsDrawer';
import { BOT_GROUP_SETTINGS_PARAM } from '../../../src/renderer/features/bots/botGroupPresentation';
import { refreshBotGroups } from '../../../src/renderer/features/bots/botGroupStore';
import { ControlledBanner } from '../../../src/renderer/features/remote-device/ControlledBanner';
import { applyRemoteSessionActivity } from '../../../src/renderer/features/device-link/remoteSessionActivityStore';

// The fixture's custom origin lacks secure-context randomUUID. Only correlation
// IDs in this isolated renderer use these tokens; production crypto is unchanged.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

interface GroupData {
  processRecord?: boolean;
  processOtherOwner?: boolean;
  /** Controlled receipts for the real renderer send/settle layout regression. */
  sendStatus?: boolean;
  sharePending?: boolean;
  workState?: 'thinking' | 'reading-file' | 'testing' | 'waiting' | 'stopping' | 'unknown';
  workRemote?: boolean;
  workParallel?: boolean;
  workLastStopping?: boolean;
  workNoStart?: boolean;
  bodyAnswer?: boolean;
  remoteLimits?: boolean;
  name: string;
  members: Array<{ botId: string; name: string }>;
  messages: number;
  sidebar: boolean;
  /** A server group with teammates' bubbles: quote, reactions, thread entry and a task card. */
  bubbles?: boolean;
  wrappedReactions?: boolean;
  /** A single-speaker server group: nobody was named, so everyone answers in turn (bot-group-chat.md §4.0/§7.0). */
  arrangement?: Queue;
  /** A preserved work plan whose ordinary messages must stay quiet. */
  workMentioned?: boolean;
  /** A 分工 you started (bot-group-chat.md §7.4): stopped after step 1 waiting for 继续, or going on by itself. */
  division?: Division;
  /** Open the group settings drawer as its owner. */
  settings?: boolean;
  /** Server read state: unread thread entries and the in-chat 话题 hint. */
  threadUnread?: boolean;
  /** The Thread panel answers reads and keeps the reader's follow switch. */
  threadPanel?: boolean;
}

const T0 = 1700000000000;
const MINUTE = 60_000;
const message = (fields: Record<string, unknown>) => ({
  kind: 'message',
  authorKind: 'user',
  authorBotId: null,
  authorName: '',
  mentions: { all: false, botIds: [] },
  noticeCode: null,
  planId: null,
  files: [],
  attachments: [],
  ...fields,
});

/** One of each piece a teammate's bubble carries, in a conversation order. */
function bodyMessages() {
  const component = '```cindy-ui\n' + [
    { seq: 1, version: 1, op: 'create', id: 'title', kind: 'heading', props: { text: '发布前检查' } },
    { seq: 2, op: 'create', id: 'literal', kind: 'text', props: { text: '保留 <name>、*literal* 和 & 符号' } },
    { seq: 3, op: 'create', id: 'list', kind: 'markdown', props: { text: '- 正文可以阅读\n- **重点**保持格式' } },
    { seq: 4, op: 'create', id: 'image', kind: 'image', props: { src: 'cindy-media://blobs/fixture-image.png', alt: '图片说明保留', caption: '图片标题保留' } },
    { seq: 5, op: 'create', id: 'unnamed-image', kind: 'image', props: { src: '/private/tmp/fixture-image.png' } },
    ...['image', 'video', 'audio'].map((kind, index) => ({ seq: index + 6, op: 'create', id: `public-${kind}`, kind, props: { src: `https://example.test/public-${kind}` } })),
  ].map(item => JSON.stringify(item)).join('\n') + '\n```';
  return [
    message({ id: 'body-user', sequence: 1, content: '请整理发布前检查', createdAt: T0 }),
    message({ id: 'body-bot', sequence: 2, authorKind: 'bot', authorBotId: 'a', authorName: 'Aster',
      content: '这是检查结果。\n\n' + component + '\n\n以上是本轮结论。', createdAt: T0 + MINUTE }),
    message({ id: 'body-plain', sequence: 3, authorKind: 'bot', authorBotId: 'b', authorName: 'Nova',
      content: '普通回复的 **加粗** 和段落保持原样。', createdAt: T0 + 2 * MINUTE }),
  ];
}

function bubbleMessages(wrappedReactions = false) {
  const manyReactions = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯']
    .map((emoji) => ({ emoji, count: 1, me: false }));
  const sharedReply = {
    messageId: 'source-reply', threadRootId: 'source-root', status: 'available',
    authorKind: 'user', authorBotId: null, authorName: 'You', sharedByAuthor: true,
    content: '好', attachments: [], createdAt: T0 + 12 * MINUTE, edited: false, version: 1,
  };
  const ask = '周四发版前，把 Android 更新卡和伙伴群聊两个 PR 收口';
  const crash = '昨晚的崩溃上报一共 2 条，都来自旧版 0.1.60，新版没有复现。两份堆栈都停在图片解码那一步，我对比了两个版本的差异，0.1.61 已经限制了解码尺寸。';
  return [
    message({ id: 'q1', sequence: 1, isSelf: true, content: ask, createdAt: T0 }),
    message({
      id: 'a1', sequence: 2, authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', createdAt: T0 + MINUTE,
      content: 'Android 更新卡那个 PR 的 review 已经处理完，现在等人审。',
      quote: { messageId: 'q1', authorName: 'You', authorKind: 'user', excerpt: ask, attachmentCount: 0, attachmentName: null, sequence: 1 },
      reactions: [{ emoji: '👍', count: 1, me: true }],
      replyCount: 5,
      threadPreview: { replies: [
        { id: 'r1', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '截图我看过了，没问题', attachments: [], createdAt: T0 + 3 * MINUTE },
        { id: 'r2', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '辛苦', attachments: [], createdAt: T0 + 4 * MINUTE },
      ], responders: [
        { id: 'r0a', authorKind: 'bot', authorBotId: 'a', authorName: 'Aster' },
        { id: 'r0b', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova' },
        { id: 'r2', authorKind: 'user', authorBotId: null, authorName: 'You' },
      ] },
    }),
    message({ id: 'b1', sequence: 3, authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', createdAt: T0 + 2 * MINUTE, content: crash }),
    message({
      id: 'b2', sequence: 4, authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', createdAt: T0 + 3 * MINUTE,
      content: '剩下的 3 条 review 我开了个后台任务去修，修完告诉大家。',
      task: { state: 'started', title: '处理 #6458 剩余 review', meta: { v: 1, role: 'delegation-request', delegationId: 'd1' } },
    }),
    message({
      id: 'q2', sequence: 5, isSelf: true, createdAt: T0 + 9 * MINUTE, content: '@Nova 旧版那两条也记一下，发版说明里提一句',
      mentions: { all: false, botIds: wrappedReactions ? [] : ['b'] },
      quote: { messageId: 'b1', authorName: 'Nova', authorKind: 'bot', excerpt: crash, attachmentCount: 0, attachmentName: null, sequence: 3 },
      replyCount: 1,
      threadPreview: { replies: [
        { id: 'r3', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', text: '已经记下了', attachments: [], createdAt: T0 + 10 * MINUTE },
      ] },
    }),
    // Short messages with more reactions than the text is wide: the bubble widens to carry them.
    message({
      id: 'a2', sequence: 6, authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', createdAt: T0 + 10 * MINUTE, content: '好',
      reactions: wrappedReactions ? manyReactions : ['👍', '🎉', '👀', '🙏'].map((emoji, i) => ({ emoji, count: i + 1, me: i === 0 })),
    }),
    message({
      id: 'q3', sequence: 7, isSelf: true, createdAt: T0 + 11 * MINUTE, content: '收到',
      replyCount: 3,
      threadPreview: { replies: [
        { id: 'r4', authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', text: '好', attachments: [], createdAt: T0 + 12 * MINUTE },
        { id: 'r5', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', text: '已更新', attachments: [], createdAt: T0 + 13 * MINUTE },
        { id: 'r6', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '谢谢', attachments: [], createdAt: T0 + 14 * MINUTE },
      ] },
      reactions: wrappedReactions ? manyReactions : ['❤️', '✅', '🚀'].map((emoji, i) => ({ emoji, count: i + 1, me: false })),
    }),
    message({
      id: 'q4', sequence: 8, isSelf: true, createdAt: T0 + 15 * MINUTE, content: '',
      threadShare: sharedReply, replyCount: 3,
      threadPreview: { replies: [
        { id: 'r7', authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', text: '已记录', attachments: [], createdAt: T0 + 16 * MINUTE },
        { id: 'r8', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', text: '收到', attachments: [], createdAt: T0 + 17 * MINUTE },
        { id: 'r9', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '谢谢', attachments: [], createdAt: T0 + 18 * MINUTE },
      ] },
    }),
    message({
      id: 'q5', sequence: 9, isSelf: true, createdAt: T0 + 19 * MINUTE, content: '',
      threadShare: sharedReply, reactions: manyReactions,
    }),
  ];
}

type Queue = 'running' | 'done' | 'long';
const QUEUE_ANSWERS = [
  '我倾向于改：群里会安静很多，也更省。',
  '同意。测试上要覆盖 @ 多位时按顺序回答，以及老群升级后只留一次说明。',
  '手机端也要跟上，不然两边看到的不一样。',
  '队列卡别太长，折起来就行。',
  '我没什么补充，按这个做。',
];
/** Who a queue lines up: the two-teammate group, or seven teammates for a long queue. */
const QUEUE_CROWD = ['Aster', 'Nova', 'Mira', 'Orin', 'Pax', 'Quill', 'Rhea'].map((name, i) => ({ botId: 'abcdefg'[i]!, name }));
const queueMembers = (state: Queue) => QUEUE_CROWD.slice(0, state === 'long' ? 7 : 2);
/** How many turns have answered: Nova still speaking, everyone, or the five that run by themselves. */
const queueAnswered = (state: Queue) => (state === 'running' ? 1 : state === 'done' ? 2 : 5);

/** Nobody named: the queue card, then each teammate's own answer in turn. */
function arrangementMessages(state: Queue) {
  const ask = '群聊改成每条只有一位回答，大家讨论下？';
  return [
    message({ id: 'q1', sequence: 1, isSelf: true, content: ask, createdAt: T0 }),
    message({ id: 'p1-card', sequence: 2, kind: 'plan', planId: 'p1', isSelf: true, content: '', createdAt: T0 }),
    ...queueMembers(state).slice(0, queueAnswered(state)).map((member, i) => message({
      id: `${member.botId}1`, sequence: 3 + i, authorKind: 'bot', authorBotId: member.botId, authorName: member.name, planId: 'p1',
      createdAt: T0 + (i + 1) * MINUTE, content: QUEUE_ANSWERS[i] })),
  ];
}
function arrangementPlan(state: Queue) {
  const answered = queueAnswered(state);
  const members = queueMembers(state);
  return {
    id: 'p1', status: state === 'done' ? 'done' : state === 'long' ? 'waiting' : 'running', organizerBotId: 'a', organizerName: 'Aster',
    currentStep: state === 'long' ? answered - 1 : state === 'done' ? 1 : answered,
    // A running turn is timed from the plan's last change: keep it recent so the clock reads sensibly.
    kind: 'talk', canManage: true, workDir: null, branch: null, createdAt: T0, updatedAt: state === 'running' ? Date.now() - 30_000 : T0 + answered * MINUTE,
    steps: members.map((member, position) => ({
      position, botId: member.botId, botName: member.name, task: '',
      status: position < answered ? 'done' : position === answered && state === 'running' ? 'running' : 'pending',
      resultMessageId: position < answered ? `${member.botId}1` : null,
    })),
  };
}
type Division = 'waiting' | 'auto';
const DIVISION_ASK = '把发版说明整理好：先列出这周合进去的改动，再写成给用户看的说明';
/** Your request, the organizer's card and Aster's finished first step. */
function divisionMessages() {
  return [
    message({ id: 'q1', sequence: 1, isSelf: true, content: DIVISION_ASK, createdAt: T0 }),
    message({ id: 'p2-card', sequence: 2, kind: 'plan', planId: 'p2', isSelf: true, content: '', createdAt: T0 }),
    message({ id: 'a1', sequence: 3, authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', planId: 'p2', createdAt: T0 + 4 * MINUTE,
      content: '这周合进去 6 个改动：群聊分工入口回来了、仅 @ 模式不再误叫醒伙伴、负责人显示修好，另有 3 个小修复。' }),
  ];
}
function divisionPlan(state: Division) {
  const auto = state === 'auto';
  return {
    id: 'p2', status: auto ? 'running' : 'waiting', organizerBotId: 'a', organizerName: 'Aster', currentStep: auto ? 1 : 0,
    kind: 'work', canManage: true, canAdd: true, autoContinue: auto, workDir: null, branch: null,
    createdAt: T0, updatedAt: auto ? Date.now() - 40_000 : T0 + 4 * MINUTE,
    steps: [
      { position: 0, botId: 'a', botName: 'Aster', task: '列出这周合进去的改动', status: 'done', resultMessageId: 'a1' },
      { position: 1, botId: 'b', botName: 'Nova', task: '写成给用户看的发版说明', status: auto ? 'running' : 'pending', resultMessageId: null },
    ],
  };
}

/**
 * Two Threads name the reader, one they follow is unread without naming them, one is read
 * (bot-group-chat.md §10「话题未读与提示」).
 */
const UNREAD = { a1: { count: 2, mentioned: true }, q3: { count: 1, mentioned: true }, q2: { count: 1, mentioned: false } } as Record<string, { count: number; mentioned: boolean }>;
const FOLLOWED = new Set(['q2']);
function threadSummaries() {
  const summary = (rootId: string, rootText: string, rootAuthorName: string, rootAuthorBotId: string | null, replyCount: number, last: [string, string, number]) => ({
    rootId, rootText, rootAuthorName, rootAuthorBotId, replyCount, unread: UNREAD[rootId] ?? { count: 0, mentioned: false }, following: FOLLOWED.has(rootId),
    lastReply: { authorName: last[0], text: last[1], createdAt: T0 + last[2] * MINUTE },
  });
  return [
    summary('a1', 'Android 更新卡那个 PR 的 review 已经处理完，现在等人审。', 'Aster', 'a', 5, ['Nova', '@You 周四上午 10 点前能合吗？', 20]),
    summary('q3', '收到', 'You', null, 3, ['Aster', '@You 发版清单里也补上了', 19]),
    summary('q2', '@Nova 旧版那两条也记一下，发版说明里提一句', 'You', null, 1, ['Nova', '已经记下了', 10]),
    summary('q4', '好', 'You', null, 3, ['You', '谢谢', 18]),
  ];
}

function groupFrom(data: GroupData) {
  const bubbles = data.bubbles ? bubbleMessages(data.wrappedReactions) : null;
  const planKind = data.workMentioned ? 'work' : 'talk';
  return {
    id: 'fixture-group',
    name: data.name,
    replyMode: data.workMentioned ? 'mentioned' : 'all',
    speakingMode: 'auto',
    members: [...(data.settings ? [{ botId: '', actorId: 'me', actorKind: 'user', name: 'You', isSelf: true, isOwned: true, role: 'owner', avatar: '', avatarColor: 'gray', status: 'active' }] : []),
      ...data.members.map((member) => ({
      ...member,
      ...(data.settings ? { actorId: `bot-${member.botId}`, actorKind: 'bot', isOwned: true, role: 'member' } : {}),
      avatar: '',
      avatarColor: 'gray',
      status: 'active',
    }))],
    ...(data.settings ? { revision: 1 } : {}),
    organizerBotId: data.members[0]?.botId ?? null,
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
    plans: data.arrangement ? [{ ...arrangementPlan(data.arrangement), kind: planKind }] : data.division ? [divisionPlan(data.division)] : [],
    ...(data.division ? { openPlan: { id: 'p2', status: data.division === 'auto' ? 'running' : 'waiting', currentStep: data.division === 'auto' ? 1 : 0,
      stepCount: 2, currentBotName: data.division === 'auto' ? 'Nova' : 'Aster', currentStepStatus: data.division === 'auto' ? 'running' : 'done', kind: 'work' },
      singleSpeaker: true, autoContinue: data.division === 'auto' } : {}),
    ...(data.arrangement ? { openPlan: data.arrangement === 'long'
      ? { id: 'p1', status: 'waiting', currentStep: 4, stepCount: 7, currentBotName: 'Pax', currentStepStatus: 'done', kind: planKind }
      : data.arrangement === 'running' ? { id: 'p1', status: 'running', currentStep: 1, stepCount: 2, currentBotName: 'Nova', currentStepStatus: 'running', kind: planKind } : null,
      singleSpeaker: true } : {}),
    ...(data.bubbles || data.arrangement || data.division ? { serverBacked: true } : {}),
    ...(data.settings ? { autoContinue: false } : {}),
    ...(data.threadUnread ? { threads: threadSummaries() } : {}),
    messages: data.remoteLimits ? ['REMOTE_DEVICE_LIMIT', 'REMOTE_TOTAL_LIMIT'].map((runtimeFailureCode, i) =>
      message({ id: `limit-${i}`, sequence: i + 1, kind: 'notice', authorKind: 'system',
        authorBotId: data.members[i].botId, authorName: data.members[i].name, content: '',
        noticeCode: 'member-unavailable', runtimeFailureCode, createdAt: T0 + i * MINUTE })) : data.bodyAnswer ? bodyMessages() : data.arrangement ? arrangementMessages(data.arrangement) : data.division ? divisionMessages()
      : bubbles ? bubbles.map(m => (data.threadUnread && UNREAD[m.id as string] ? { ...m, threadUnread: UNREAD[m.id as string] } : m))
      : Array.from({ length: data.messages }, (_, i) => ({
      id: `m${i}`,
      sequence: i + 1,
      kind: 'message',
      authorKind: 'user',
      authorBotId: null,
      authorName: '',
      content: data.workState ? ["帮我检查群聊里的工作状态和任务入口。", "过程放在下面的动态区，完成后告诉我结果。"][i % 2] : `Layout message ${i + 1}`,
      mentions: { all: false, botIds: [] },
      noticeCode: null,
      planId: null,
      attachments: [],
      createdAt: 1700000000000 + i,
    })),
    hasMoreBefore: false,
    round: data.workState ? { status: 'running', speakers: [{ botId: 'a', executionId: 'fixture-execution', sessionId: data.workRemote || data.workState === 'unknown' ? null : 'fixture-work', activity: 'reply', executionStatus: data.workState === 'waiting' ? 'needs_input' : 'running', startedAt: data.workNoStart ? undefined : Date.now() - 83_000, stopping: data.workState === 'stopping' },
      ...(data.workParallel ? [{ botId: 'b', executionId: 'fixture-second', sessionId: 'fixture-second-work', activity: 'reply', startedAt: Date.now() - 41_000, stopping: !!data.workLastStopping, executionStatus: data.workLastStopping ? 'stopping' : 'running' }] : [])], canContinue: false }
      : { status: 'idle', speakers: [], canContinue: false },
  };
}

void mountPage({
  route: '/bots/groups/fixture-group',
  host: (ctx) => {
    const data = ctx.data as unknown as GroupData;
    const group = groupFrom(data);
    if (data.processRecord) {
      Object.assign(group, { serverBacked: true, members: group.members.map(member => ({ ...member, isOwned: !data.processOtherOwner, homeDeviceId: 'fixture-mac' })),
        messages: [message({ id: 'process-answer', sequence: 1, authorKind: 'bot', authorBotId: 'a', authorName: 'Aster',
          content: '任务与 PR 的进展已整理，以下是需要跟进的事项。', createdAt: T0,
          process: { groupId: group.id, executionId: 'fixture-completed', sessionId: 'fixture-lane', clientId: 'fixture-source', durationMs: 47000 } })] });
    }
    if (data.workRemote) applyRemoteSessionActivity('fixture-mac', { sessionId: 'fixture-work', phase: 'running', workingPhase: 'testing', compactDetail: '正在运行群聊回归检查', attention: false });
    let following = false;
    const followThread = async (input: { following: boolean }) => {
      following = input.following;
      return { ok: true, following };
    };
    const thread = async (input: { rootId: string }) => {
      const root = group.messages.find(m => m.id === input.rootId);
      const replies = ((root?.threadPreview as { replies?: Array<Record<string, unknown>> } | undefined)?.replies ?? []).map((reply, index) => message({
        id: reply.id, sequence: 100 + index, threadRootId: input.rootId, authorKind: reply.authorKind, authorBotId: reply.authorBotId,
        authorName: reply.authorName, isSelf: reply.isSelf, content: reply.text, createdAt: reply.createdAt,
      }));
      return { ok: true, root, replies, hasMore: false, following };
    };
    return {
      agentIsland: { onSessionActivity: subscription('sessionActivity') },
      // The missing-card scenario follows the real history/interaction hydration path.
      localDb: {
        sessions: { get: async (id: string) => ({ id, agentKind: 'claude', sdkSessionId: null }) },
        messages: { list: async () => [] },
      },
      maker: {
        getPendingInteractions: async () => [],
        getCompanionCloudState: async () => ({ enabled: !!data.workRemote, selfDeviceId: null, humanActorId: null, actors: data.workRemote ? [{ id: 'a', externalId: 'a', name: 'Aster', avatar: null, homeDeviceId: 'fixture-mac', homeDevice: { deviceId: 'fixture-mac', name: 'Mac Studio', online: true, remoteControlEnabled: true, isSelf: false } }] : [], demotedBotIds: [] }),
        onCompanionCloudChanged: subscription('companionCloudChanged'),
        polishWorkingStatus: async () => null,
        listBotGroups: async () => ({ ok: true, groups: (ctx.data as unknown as GroupData).settings ? [group] : [] }),
        getBotGroup: async () => ({ ok: true, group }),
        onBotGroupChanged: subscription('botGroupChanged'),
        sendBotGroupMessage: data.sendStatus ? (input: { text: string; clientId: string }) => new Promise((resolve) => {
          window.addEventListener('fixture-send-receipt', (event) => {
            if ((event as CustomEvent).detail === 'failed') {
              resolve({ ok: false, errorCode: 'SEND_FAILED', message: 'Fixture send failed' });
              return;
            }
            const id = `sent-${input.clientId}`;
            group.messages = [...group.messages, message({ id, sequence: group.messages.length + 1,
              content: input.text, createdAt: Date.now(), isSelf: true }) as (typeof group.messages)[number]];
            resolve({ ok: true, messageId: id });
          }, { once: true });
        }) : forbid('maker.sendBotGroupMessage'),
        stopBotGroupRound: forbid('maker.stopBotGroupRound'),
        chatServer: {
          reactors: async () => ({ ok: true, reactors: [{ actorId: 'me', isSelf: true, name: 'You', formerMember: false }] }),
          react: forbid('maker.chatServer.react'),
          ownedBots: async () => ({ ok: true, bots: [] }),
          manage: forbid('maker.chatServer.manage'),
          ...(data.threadPanel ? { thread, followThread } : {}),
          ...(data.sharePending ? { shareToMain: () => new Promise(() => {}) } : {}),
        },
        updateBotGroup: forbid('maker.updateBotGroup'),
      },
      deviceLink: {
        invoke: async (_device: string, _channel: string, args: Array<{ ref?: { collectionId?: string } }>) => _channel === 'local-db:messages:around-client-id' ? [
          { clientId: 'fixture-source', role: 'user', content: 'Request' },
          { clientId: 'fixture-thought', role: 'thinking', content: 'Hidden reasoning' },
          { clientId: 'fixture-note', role: 'assistant', content: '我先核对任务的最近进展，再看未完成 PR 的阻塞点。', agentMeta: { assistantPhase: 'commentary' } },
          { clientId: 'fixture-tool', role: 'tool_use', content: { toolName: 'Read', toolUseId: 'fixture-tool', input: { file_path: '/repo/tasks.md' } } },
          { clientId: 'fixture-result', role: 'tool_result', toolUseId: 'fixture-tool', content: 'Task records' },
          { clientId: 'fixture-note2', role: 'assistant', content: '已经继续获取任务信息，接下来核对未完成 PR 的当前状态。', agentMeta: { assistantPhase: 'commentary' } },
          { clientId: 'fixture-end', role: 'assistant', content: 'Result', agentMeta: { turnCompleted: true } },
        ] : args[0]?.ref?.collectionId === 'bot-groups' ? {
          ref: { collectionId: 'bot-groups', kind: 'bot-group', id: group.id },
          blocks: [{ primitive: 'bot-group-chat', data: { ...group, round: { ...group.round, speakers: [{ ...group.round.speakers[0], sessionId: 'fixture-work' }] } } }],
        } : { blocks: [] },
        onRemotePush: subscription('remotePush'),
        getState: async () => ({ controlledBy: [] }),
        onControlledState: subscription('controlledState'),
        revoke: forbid('deviceLink.revoke'),
      },
    };
  },
  render: (ctx) => {
    const data = ctx.data as unknown as GroupData;
    const sidebar = data.sidebar ? <div className="p-5" /> : undefined;
    return (
      <>
        <AppFrame sidebar={sidebar}>
          <div className="min-h-0 flex-1" data-ui-page-subject>
            <Routes>
              <Route path="/bots/groups/:groupId" element={<BotGroupChatView />} />
            </Routes>
          </div>
        </AppFrame>
        <ControlledBanner />
        {data.workState && !data.workRemote ? <SeedProcessNotes /> : null}
        {data.settings ? <OpenSettings /> : null}
      </>
    );
  },
});

/** The drawer is route-owned: open it the way the header button does. */
function OpenSettings() {
  const [, setSearchParams] = useSearchParams();
  // The drawer reads the shared group list, which the sidebar normally loads. Open it once:
  // setSearchParams changes with every page the drawer opens.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    refreshBotGroups();
    setSearchParams({ [BOT_GROUP_SETTINGS_PARAM]: '1' }, { replace: true });
  }, [setSearchParams]);
  return <BotGroupSettingsDrawer />;
}

// Input events only; the real store and process renderer produce the journal.
function SeedProcessNotes() {
  useEffect(() => {
    // The HTTP-only screenshot harness lacks secure-context randomUUID.
    let id = 0;
    if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { configurable: true,
      value: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` });
    for (const text of ['我先核对任务的最近进展，再看未完成 PR 的阻塞点。', '已经找到需要跟进的两项工作，正在核对当前状态。']) {
      makerChatStore.__applyStreamEventForTest('fixture-work', { type: 'text', source: 'codex', data: { text, isFinal: true, phase: 'commentary' } });
    }
    return () => makerChatStore.purgeSession('fixture-work');
  }, []);
  return null;
}
