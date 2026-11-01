import {
  REMOTE_RESOURCE_LIST_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
  type RemoteCollectionItem,
  type RemoteCollectionListResponse,
  type RemoteResourceManifestResponse,
} from '@cindy/device-link';
import { UI_MOCK_ID_PREFIX, UI_MOCK_TASKS } from '@cindy/maker-shared/ui-mock';
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_MEMBER_LINK_REL, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';

/**
 * `--mock` teammates (docs/dev-rules/ui-mock-data.md): the roster the teammate home and the task
 * home's teammate section read. Invented names and previews only; the three presets ship with the app.
 */
const TEAMMATES = 'teammates';
export const VISUAL_TEAMMATE_SESSION_ID = 'visual-teammate-session';
export const VISUAL_TEAMMATE_THREAD_ROOT_ID = 'visual-teammate-topic-root';
export const visualTeammateThreads = new Map([[VISUAL_TEAMMATE_THREAD_ROOT_ID, { sessionId: 'visual-teammate-topic', replyCount: 2 }]]);
const MINUTE = 60_000;
const teammates: ReadonlyArray<{ id: string; name: string; preview: string; minutesAgo: number; avatar: RemoteCollectionItem['display']['avatar']; working?: boolean; phase?: string; following?: string[] }> = [
  { id: 'cindy-default', name: 'Cindy', preview: '登录页窄窗口的错位已经修好，截图放在任务里了。', minutesAgo: 2,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/cindy', fallbackText: 'C' }, working: true,
    // Task rows show the follow mark (`ui-mock` tasks): one shared with LiZi, so the mark picks by name.
    following: ['visual-running', `${UI_MOCK_ID_PREFIX}rich-answer`] },
  { id: 'visual-bot-dash', phase: 'needs-interaction', working: true, name: 'Dash', preview: 'Weekly numbers are in: sign-ups up 12%, churn flat.', minutesAgo: 25,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/dash', fallbackText: 'D' } },
  { id: 'visual-bot-lizi', phase: 'completed', name: 'LiZi', preview: '这个 PR 我看完了，留了两条建议。', minutesAgo: 90,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/lizi', fallbackText: 'L' },
    following: ['visual-running', `${UI_MOCK_ID_PREFIX}english`] },
  { id: 'visual-bot-xiaoman', name: '小满', preview: '明天上午十点的会已经帮你约好。', minutesAgo: 60 * 20,
    avatar: { kind: 'emoji', value: '🌾', fallbackText: '小' } },
  { id: 'visual-bot-research', phase: 'error', name: 'Research Assistant', preview: 'Three sources disagree on the release date; details inside.', minutesAgo: 60 * 30,
    avatar: { kind: 'text', value: 'R', fallbackText: 'R' } },
  { id: 'visual-bot-tuantuan', name: '团团', preview: '开始对话', minutesAgo: 60 * 72,
    avatar: { kind: 'emoji', value: '🐼', fallbackText: '团' } },
];

// Fixed per process: a moving clock would make every row look unread again on each read.
const FIXTURE_NOW = Date.now();
export function teammateVisualReplyAt(sessionId: string): number {
  const bot = teammates.find(item => sessionId === `${VISUAL_TEAMMATE_SESSION_ID}:${item.id}`);
  return FIXTURE_NOW - (bot?.minutesAgo ?? 0) * MINUTE;
}
// In-memory mock state only: exercises the real glance actions without a host or automation.
let dailyTodoCheck = true;
let todoDeleted = false;
const glanceTodo = {
  id: 'visual-glance-todo', revision: 1, key: 'visual-review', origin: 'assigned',
  title: '确认登录页的验收截图', progress: '', outcome: '', value: '', next: null,
  sources: [], associations: [], status: 'open', createdAt: new Date(FIXTURE_NOW).toISOString(),
  updatedAt: new Date(FIXTURE_NOW).toISOString(),
  sourceDeadline: { kind: 'instant', date: new Date(FIXTURE_NOW + 60 * MINUTE).toISOString().slice(0, 10), timeZone: 'UTC', at: new Date(FIXTURE_NOW + 60 * MINUTE).toISOString() },
  deadlineCandidate: null,
  suggestedDate: null, decision: null, history: [], action: null,
};
const COMPARISON_GROUP_ID = 'visual-comparison-group';
const COMPARISON_GROUP_NAME = '界面对比演示群';

function comparisonGroup(now: number) {
  const task = UI_MOCK_TASKS.find(task => task.id === `${UI_MOCK_ID_PREFIX}rich-answer`)!;
  const messages = task.messages.filter(message => message.role === 'user' || message.role === 'assistant')
    .map((message, index) => ({ id: `visual-comparison-${index}`, sequence: index + 1, kind: 'message',
      authorKind: message.role === 'user' ? 'user' : 'bot', isSelf: message.role === 'user',
      authorBotId: message.role === 'user' ? null : 'cindy-default',
      authorName: message.role === 'user' ? '我' : 'Cindy', content: message.text, createdAt: now - (3 - index) * MINUTE }));
  return {
    id: COMPARISON_GROUP_ID, name: COMPARISON_GROUP_NAME,
    members: teammates.slice(0, 3).map(bot => ({ botId: bot.id, name: bot.name, status: 'active' })),
    messages, plans: [], round: { status: 'idle', speakers: [], canContinue: false },
    createdAt: now - 5 * MINUTE, updatedAt: now - MINUTE,
  };
}

const systemSkillsOn: Record<string, boolean> = { todo: false, routine: true, follow: true };
let learnedSkillOn = true;
const SYSTEM_SKILLS: ReadonlyArray<[string, string, string]> = [
  ['todo', '待办', '记下你交代的事和它留意到的事，到期提醒你。'],
  ['routine', '例行任务', '设置并维护按时运行的例行任务。'],
  ['follow', '工作台与跟进', '留意你所有任务的进展，跟进你交给它的任务。'],
];
function visualSkillsPage(id: string, section: string | undefined) {
  const page = (title: string, blocks: unknown[], actions: unknown[] = []) => ({
    ref: { collectionId: TEAMMATES, kind: 'bot', id }, revision: `visual-${JSON.stringify([systemSkillsOn, learnedSkillOn])}`,
    display: { title }, links: [], blocks, actions,
  });
  const toggle = (title: string, help: string, enabled: boolean) => page(title, [
    { id: 'capability', title: '使用这个技能', primitive: 'form', fallbackMarkdown: help, data: { actionId: 'capability', values: { enabled } } },
  ], [{ id: 'capability', label: '使用这个技能', fields: [{ id: 'enabled', label: '使用这个技能', kind: 'toggle' }] }]);
  if (!section) return page('技能', [
    { id: 'core', primitive: 'list', fallbackMarkdown: '', data: { entries: [
      { id: 'core', title: '核心技能', subtitle: '所有伙伴共用 · 始终开启 · 随 Cindy 更新', resourceId: `${id}/_core` }] } },
    { id: 'system', title: '系统技能', primitive: 'list', fallbackMarkdown: '', data: { entries: SYSTEM_SKILLS.map(([skill, title]) => ({
      id: skill, title, ...(systemSkillsOn[skill] ? {} : { subtitle: '已关闭' }), resourceId: `${id}/_${skill}` })) } },
    { id: 'skills', title: '学会的技能', primitive: 'list', fallbackMarkdown: '', data: { entries: [
      { id: 'release-notes', title: '发布说明写法', ...(learnedSkillOn ? {} : { subtitle: '已关闭' }), resourceId: `${id}/release-notes` }] } },
  ]);
  if (section === '_core') return page('核心技能', [
    { id: 'core', primitive: 'markdown', fallbackMarkdown: '所有伙伴共用 · 始终开启 · 随 Cindy 更新\n\n每位伙伴都以这项技能为基础，内容包括：\n· 任务：在对话里完成工作，需要时开启后台任务。\n· 伙伴：给其他伙伴发消息，一起协作。\n· 模型与工具：按你的要求更换模型，查找工作需要的工具和插件。\n· 记忆：记住你的偏好和纠正，按你的要求保存技能。\n· 了解自己：知道自己能做什么，按你的要求开关自己的能力。' },
    { id: 'core-original', title: '原文', primitive: 'markdown', fallbackMarkdown: '# Cindy teammate guide\n\nYou are a teammate inside Cindy…' },
  ]);
  const system = SYSTEM_SKILLS.find(([skill]) => `_${skill}` === section);
  if (system) return toggle(system[1], system[2], systemSkillsOn[system[0]]);
  return toggle('发布说明写法', '按团队格式整理每次发布的说明。', learnedSkillOn);
}

export function teammateVisualFixture(channel: string, args: unknown[], now = FIXTURE_NOW): unknown {
  if (channel === 'local-db:bots:get' && args[0] === 'visual-bot-b2b') return {
    id: 'visual-bot-b2b', canonicalSessionId: 'visual-teammate-b2b',
    sessions: [{ id: 'visual-teammate-b2b', role: 'canonical', status: 'active' }],
  };
  if (channel === REMOTE_RESOURCE_GET_CHANNEL
    && (args[0] as { ref?: { id?: string } })?.ref?.id === 'visual-bot-b2b') return {
    ref: { collectionId: TEAMMATES, kind: 'bot', id: 'visual-bot-b2b' }, revision: 'b2b-1',
    display: { title: 'Cindy · 内部通讯', avatar: teammates[0]!.avatar }, actions: [], blocks: [],
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'visual-teammate-b2b' } }],
  };
  if (channel === 'maker:bot-direct-message-thread:get' && args[0] === 'visual-b2b-thread') return {
    ok: true, thread: {
      id: 'visual-b2b-thread', botAId: 'visual-bot-b2b', botAName: 'Cindy', botBId: 'visual-bot-lizi', botBName: 'LiZi',
      status: 'active', closeReason: null, messageCount: 2, maxMessages: 12,
      createdAt: now - 90000, updatedAt: now - 70000, closedAt: null,
      messages: [
        { id: 'b2b-in', sequence: 1, senderBotId: 'visual-bot-lizi', senderBotName: 'LiZi', recipientBotId: 'visual-bot-b2b', recipientBotName: 'Cindy', content: '请核对版式。', createdAt: now - 90000 },
        { id: 'b2b-out', sequence: 2, senderBotId: 'visual-bot-b2b', senderBotName: 'Cindy', recipientBotId: 'visual-bot-lizi', recipientBotName: 'LiZi', content: '已核对，入口左对齐。', createdAt: now - 70000 },
      ],
    },
  };
  if (channel === 'git-context:pr-refs:list') return args[0] === `${UI_MOCK_ID_PREFIX}rich-answer`
    ? [{ id: 'visual-pr', sessionId: args[0], owner: 'example', repo: 'demo', prNumber: 7, lastSeenAt: now }] : [];
  if (channel === 'git-context:pr-status') return [{ owner: 'example', repo: 'demo', prNumber: 7, ok: true,
    status: 'merged', title: '修复登录页在窄窗口下的布局' }];
  if (channel === 'maker:bot-delegations:list') {
    const bot = teammates.find(item => args[0] === `${VISUAL_TEAMMATE_SESSION_ID}:${item.id}`);
    const ids = bot?.id === 'cindy-default' ? ['visual-running', `${UI_MOCK_ID_PREFIX}rich-answer`]
      : bot?.id === 'visual-bot-lizi' ? [`${UI_MOCK_ID_PREFIX}english`, `${UI_MOCK_ID_PREFIX}archived`] : [];
    return { ok: true, delegations: ids.map(childSessionId => ({ requestingBotId: bot!.id, childSessionId })) };
  }
  if (channel === 'local-db:bots:get' && teammates.some(bot => bot.id === args[0])) return {
    id: args[0], canonicalSessionId: VISUAL_TEAMMATE_SESSION_ID, dmThreadsSupported: true,
    sessions: [{ id: VISUAL_TEAMMATE_SESSION_ID, role: 'canonical', status: 'active' },
      ...[...visualTeammateThreads].map(([rootClientId, thread]) => ({ id: thread.sessionId, role: 'thread', status: 'active',
        threadRoot: { rootSessionId: VISUAL_TEAMMATE_SESSION_ID, rootClientId } }))],
  };
  if (channel === 'local-db:bots:dm-thread:list') return [...visualTeammateThreads].filter(([, thread]) => thread.replyCount).map(([rootClientId, thread]) => ({
    ...thread, rootSessionId: VISUAL_TEAMMATE_SESSION_ID, rootClientId, lastReplyAt: now - MINUTE * 2, lastAssistantAt: now - MINUTE * 2, createdAt: now - MINUTE * 5,
  }));
  if (channel === 'local-db:bots:dm-thread:ensure') {
    const root = (args[0] as { rootClientId: string }).rootClientId;
    const previous = visualTeammateThreads.get(root);
    const thread = previous ?? { sessionId: `visual-teammate-topic-${visualTeammateThreads.size}`, replyCount: 0 };
    visualTeammateThreads.set(root, thread);
    return { ok: true, sessionId: thread.sessionId, created: !previous };
  }
  if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) return {
    protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
    collections: [{ id: TEAMMATES, resourceKind: 'bot', title: 'Teammates', placement: 'home-scope',
      actions: [{ id: 'open-create', label: 'New teammate' }] },
      { id: BOT_GROUP_REMOTE_COLLECTION_ID, resourceKind: BOT_GROUP_REMOTE_RESOURCE_KIND,
        title: '伙伴群聊', placement: 'home-scope', actions: [] }],
  } satisfies RemoteResourceManifestResponse;
  const request = args[0] as { collectionId?: string; ref?: { collectionId?: string; id?: string }; resourceRef?: { id?: string }; actionId?: string; query?: string; input?: { enabled?: boolean; operation?: string; op?: string; args?: { id?: string } } } | undefined;
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.id === 'todos:cindy-default') {
    const query = JSON.parse(request.query ?? '{}');
    const items = query.view === 'done' || todoDeleted ? [] : [glanceTodo];
    return { ref: { collectionId: TEAMMATES, kind: 'bot', id: request.ref.id }, revision: 'visual-1',
      display: { title: 'Todos' }, actions: [], links: [],
      blocks: [{ id: 'todos', primitive: 'teammate-todos', fallbackMarkdown: glanceTodo.title, data: { items, total: items.length, dailyCheck: dailyTodoCheck } }] };
  }
  if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL && request?.resourceRef?.id === 'todos:cindy-default' && request.actionId === 'todo-daily-check') {
    dailyTodoCheck = request.input?.enabled === true;
    return { effects: [], dailyCheck: dailyTodoCheck };
  }
  if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL && request?.resourceRef?.id === 'todos:cindy-default' && request.actionId === 'todo-update') {
    if (request.input?.operation === 'delete') todoDeleted = true;
    if (request.input?.operation === 'restore') todoDeleted = false;
    return { effects: [], todo: glanceTodo };
  }
  if (channel === REMOTE_RESOURCE_LIST_CHANNEL && request?.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID) return {
    collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, revision: 'visual-comparison-1',
    items: [{ ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: COMPARISON_GROUP_ID },
      display: { title: COMPARISON_GROUP_NAME, preview: '与 Cindy 单聊使用同一份示例，比较消息气泡和正文。', timestamp: now - MINUTE },
      links: teammates.slice(0, 3).map(bot => ({ rel: BOT_GROUP_MEMBER_LINK_REL, label: bot.name,
        target: { kind: 'resource', ref: { collectionId: TEAMMATES, kind: 'bot', id: bot.id } } })), revision: 'visual-comparison-1' }],
  };
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID
    && request.ref.id === COMPARISON_GROUP_ID) return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: COMPARISON_GROUP_ID },
    revision: 'visual-comparison-1', display: { title: COMPARISON_GROUP_NAME }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: COMPARISON_GROUP_NAME, data: comparisonGroup(now) }],
  };
  // Skill layers (cindy-bots-runtime.md §6「伙伴技能分层」): Cindy's Skills page as the host draws it.
  // Open the teammate's settings → Skills in --mock.
  const skillsPage = /^settings:cindy-default\/skills(?:\/(.+))?$/.exec(request?.ref?.id ?? request?.resourceRef?.id ?? '');
  if (skillsPage && channel === REMOTE_RESOURCE_INVOKE_CHANNEL) {
    const section = skillsPage[1] ?? '';
    if (typeof request?.input?.enabled === 'boolean') {
      if (section.startsWith('_')) systemSkillsOn[section.slice(1)] = request.input.enabled;
      else learnedSkillOn = request.input.enabled;
    }
    return { effects: [{ kind: 'refresh-resource', ref: { collectionId: TEAMMATES, kind: 'bot', id: request!.resourceRef!.id } }] };
  }
  if (skillsPage && channel === REMOTE_RESOURCE_GET_CHANNEL) return visualSkillsPage(request!.ref!.id!, skillsPage[1]);
  // PR #7899: synthetic content for native partial selection and mention screenshots.
  // Open /companions/groups/visual-group-text-selection?deviceId=cindy-visual-mock-mac in --mock.
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID
    && request.ref.id === 'visual-group-text-selection') return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: request.ref.id },
    revision: 'visual-1', display: { title: '文字选择 · 模拟数据' }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: '文字选择 · 模拟数据', data: {
      id: request.ref.id, name: '文字选择 · 模拟数据',
      members: [{ botId: 'cindy-default', name: 'Cindy', status: 'active' }, { botId: 'visual-bot-dash', name: 'Dash', status: 'active' }],
      messages: [
        { id: 'selection-user', sequence: 1, kind: 'message', authorKind: 'user', authorName: '演示用户',
          content: '@Cindy @Dash 请看这段示例，只选中需要的几个字再复制。', createdAt: now - MINUTE },
        { id: 'selection-reply', sequence: 2, kind: 'message', authorKind: 'bot', authorBotId: 'cindy-default', authorName: 'Cindy',
          content: [
            '这是一段用于局部文字选择的长回复。长按正文，拖动两端手柄，只选中需要的几个字，再复制到输入框。其余文字应继续保留原来的排版。',
            '', '下面是代码块，可以选择其中的一小段：', '',
            '~~~typescript', 'const greeting = "Hello Cindy";', 'console.log(greeting);', '~~~', '',
            '| 项目 | 说明 |', '| --- | --- |', '| 文字选择 | 只复制需要的几个字 |', '| 表格单元格 | 拖动手柄调整选区 |',
          ].join('\n'), createdAt: now },
      ], plans: [], createdAt: now, updatedAt: now,
    } }],
  };
  // Nine members from three accounts: the header shows a member count, not every name.
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID
    && request.ref.id === 'visual-process-history') return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: request.ref.id },
    revision: 'process-1', display: { title: 'Design review' }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: 'Design review', data: {
      id: request.ref.id, name: 'Design review', members: [{ botId: 'cindy-default', name: 'Cindy', status: 'active', isOwned: true, homeDeviceId: 'cindy-visual-mock-mac' }],
      messages: [{ id: 'fixture-group-answer', sequence: 1, kind: 'message', authorKind: 'bot', authorBotId: 'cindy-default', authorName: 'Cindy',
        content: '任务与 PR 的进展已整理，需要跟进的两项工作已列出。', createdAt: now,
        process: { groupId: request.ref.id, executionId: 'fixture-process-execution', sessionId: 'visual-teammate-process', clientId: 'fixture-process-source', durationMs: 60000 } }],
      plans: [], createdAt: now, updatedAt: now, round: { status: 'idle', canContinue: false, speakers: [] },
    } }],
  };
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID
    && request.ref.id === 'visual-crowded-group') return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: request.ref.id },
    revision: 'visual-1', display: { title: 'Design review' }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: 'Design review', data: {
      id: request.ref.id, name: 'Design review',
      members: ['Aster (Ada)', 'Nova (Leo)', 'Leo', 'Mira (Ada)', 'Orin (Kai)', 'Quill', 'Ada', 'Kai', 'Rhea (Ada)']
        .map((name, index) => ({ botId: `visual-crowd-${index}`, name, status: 'active' })),
      messages: [{ id: 'visual-crowd-message', sequence: 1, kind: 'message', authorKind: 'bot', authorBotId: 'visual-crowd-0',
        authorName: 'Aster (Ada)', content: '首页改版的稿子我放在群文件夹里了，大家看一下。', createdAt: now }],
      plans: [], createdAt: now, updatedAt: now,
    } }],
  };
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID
    && request.ref.id === 'visual-session-process') return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: request.ref.id },
    revision: 'visual-1', display: { title: '任务入口演示群' }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: 'Cindy 正在工作', data: {
      id: request.ref.id, name: '任务入口演示群', members: [{ botId: 'cindy-default', name: 'Cindy', status: 'active' }],
      messages: [], plans: [], createdAt: now, updatedAt: now,
      round: { status: 'running', canContinue: false, speakers: [{ botId: 'cindy-default', activity: 'reply', sessionId: VISUAL_TEAMMATE_SESSION_ID }] },
    } }],
  };
  // Existing connection/session records for exercising both native settings entries.
  if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL && request?.collectionId === TEAMMATES) {
    const op = request.input?.op;
    const botId = request.resourceRef?.id;
    const value = op === 'caps' ? { version: 1, ops: ['channels.im.list', 'channels.im.listLanes'] }
      : op === 'channels.im.list' ? { connections: [{ id: 'visual-im', botId, channel: 'telegram', identity: { username: 'demo_partner' } }] }
      : op === 'channels.im.listLanes' && request.input?.args?.id === 'visual-im'
        ? { connectionId: 'visual-im', lanes: [{ sessionId: VISUAL_TEAMMATE_SESSION_ID, kind: 'group', name: '演示群任务', chatId: 'demo-group', state: 'idle', lastActivityAt: now, contextMessageCount: 2 }] }
        : undefined;
    if (value !== undefined) return { result: { ok: true, value }, effects: [] };
  }
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.collectionId === TEAMMATES) {
    const id = request.ref.id?.replace(/^settings:/, '');
    const bot = teammates.find(item => item.id === id);
    if (bot) return {
      ref: { collectionId: TEAMMATES, kind: 'bot', id: request.ref.id }, revision: 'visual-1',
      display: { title: bot.name, avatar: bot.avatar, lastReplyAt: teammateVisualReplyAt(`${VISUAL_TEAMMATE_SESSION_ID}:${bot.id}`) },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: `${VISUAL_TEAMMATE_SESSION_ID}:${bot.id}` } },
        ...(id === 'cindy-default' ? [{ rel: 'todos', target: { kind: 'resource', ref: { collectionId: TEAMMATES, kind: 'bot', id: 'todos:cindy-default' } } }] : [])],
      actions: [], blocks: [{ id: 'profile', primitive: 'markdown', fallbackMarkdown: bot.preview },
        ...(id === 'cindy-default' ? [{ id: 'skills', primitive: 'list', fallbackMarkdown: '',
          data: { entries: [{ id: 'skills', title: '技能', resourceId: 'settings:cindy-default/skills' }] } }] : [])],
    };
  }
  if (channel !== REMOTE_RESOURCE_LIST_CHANNEL || request?.collectionId !== TEAMMATES) return undefined;
  return {
    collectionId: TEAMMATES,
    revision: 'visual-teammates-1',
    items: teammates.map((bot) => ({
      ref: { collectionId: TEAMMATES, kind: 'bot', id: bot.id },
      display: {
        title: bot.name,
        preview: bot.preview,
        timestamp: now - bot.minutesAgo * MINUTE,
        lastReplyAt: now - bot.minutesAgo * MINUTE,
        avatar: bot.avatar,
        ...(bot.phase ? { teammateActivity: { phase: bot.phase } } : {}),
        ...(bot.working ? { generation: { phase: 'replying', startedAt: now - MINUTE } } : {}),
      },
      links: [
        { rel: 'conversation', target: { kind: 'session' as const, sessionId: `${VISUAL_TEAMMATE_SESSION_ID}:${bot.id}` } },
        ...(bot.following ?? []).map((sessionId) => ({ rel: 'following', target: { kind: 'session' as const, sessionId } })),
      ],
      revision: 'visual-1',
    })),
  } satisfies RemoteCollectionListResponse;
}
