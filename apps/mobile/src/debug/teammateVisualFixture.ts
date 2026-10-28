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
import { UI_MOCK_ID_PREFIX } from '@cindy/maker-shared/ui-mock';
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';

/**
 * `--mock` teammates (docs/dev-rules/ui-mock-data.md): the roster the teammate home and the task
 * home's teammate section read. Invented names and previews only; the three presets ship with the app.
 */
const TEAMMATES = 'teammates';
export const VISUAL_TEAMMATE_SESSION_ID = 'visual-teammate-session';
const MINUTE = 60_000;
const teammates: ReadonlyArray<{ id: string; name: string; preview: string; minutesAgo: number; avatar: RemoteCollectionItem['display']['avatar']; working?: boolean; following?: string[] }> = [
  { id: 'cindy-default', name: 'Cindy', preview: '登录页窄窗口的错位已经修好，截图放在任务里了。', minutesAgo: 2,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/cindy', fallbackText: 'C' }, working: true,
    // Task rows show the follow mark (`ui-mock` tasks): one shared with LiZi, so the mark picks by name.
    following: ['visual-running', `${UI_MOCK_ID_PREFIX}rich-answer`] },
  { id: 'visual-bot-dash', name: 'Dash', preview: 'Weekly numbers are in: sign-ups up 12%, churn flat.', minutesAgo: 25,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/dash', fallbackText: 'D' } },
  { id: 'visual-bot-lizi', name: 'LiZi', preview: '这个 PR 我看完了，留了两条建议。', minutesAgo: 90,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/lizi', fallbackText: 'L' },
    following: ['visual-running', `${UI_MOCK_ID_PREFIX}english`] },
  { id: 'visual-bot-xiaoman', name: '小满', preview: '明天上午十点的会已经帮你约好。', minutesAgo: 60 * 20,
    avatar: { kind: 'emoji', value: '🌾', fallbackText: '小' } },
  { id: 'visual-bot-research', name: 'Research Assistant', preview: 'Three sources disagree on the release date; details inside.', minutesAgo: 60 * 30,
    avatar: { kind: 'text', value: 'R', fallbackText: 'R' } },
  { id: 'visual-bot-tuantuan', name: '团团', preview: '开始对话', minutesAgo: 60 * 72,
    avatar: { kind: 'emoji', value: '🐼', fallbackText: '团' } },
];

// Fixed per process: a moving clock would make every row look unread again on each read.
const FIXTURE_NOW = Date.now();

export function teammateVisualFixture(channel: string, args: unknown[], now = FIXTURE_NOW): unknown {
  if (channel === 'maker:bot-delegations:list') {
    const bot = teammates.find(item => args[0] === `${VISUAL_TEAMMATE_SESSION_ID}:${item.id}`);
    const ids = bot?.id === 'cindy-default' ? ['visual-running', `${UI_MOCK_ID_PREFIX}rich-answer`]
      : bot?.id === 'visual-bot-lizi' ? [`${UI_MOCK_ID_PREFIX}english`, `${UI_MOCK_ID_PREFIX}archived`] : [];
    return { ok: true, delegations: ids.map(childSessionId => ({ requestingBotId: bot!.id, childSessionId })) };
  }
  if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) return {
    protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
    collections: [{ id: TEAMMATES, resourceKind: 'bot', title: 'Teammates', placement: 'home-scope',
      actions: [{ id: 'open-create', label: 'New teammate' }] }],
  } satisfies RemoteResourceManifestResponse;
  const request = args[0] as { collectionId?: string; ref?: { collectionId?: string; id?: string }; resourceRef?: { id?: string }; input?: { op?: string; args?: { id?: string } } } | undefined;
  // Nine members from three accounts: the header shows a member count, not every name.
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
      display: { title: bot.name, avatar: bot.avatar },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: VISUAL_TEAMMATE_SESSION_ID } }],
      actions: [], blocks: [{ id: 'profile', primitive: 'markdown', fallbackMarkdown: bot.preview }],
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
