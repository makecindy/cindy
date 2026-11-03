/** Synthetic data for the existing __DEV__ visual-mock provider, never an account or a live bot. */
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND,
  type ChatMaskState, type ChatMaskMention, type ChatMaskAction } from '@cindy/maker-shared/botGroupChat';
const human = { id: 'mask-human', name: 'Alex', avatarUrl: '🙂' };
const companion = { id: 'mask-companion', name: 'Cindy', avatarUrl: 'cindy://avatar/preset/cindy' };
let state: ChatMaskState = { toolAccessSupported: true, revision: 1, status: 'enabled', manualRunning: false,
  self: human, companions: [companion], settings: { companionId: companion.id, enabled: true, access: 'chat', trigger: 'always', start: '09:00', end: '18:00', timeZone: 'Asia/Shanghai', resumeMinutes: 15, collectTodos: true, digest: 'manual' } };
let mentions: ChatMaskMention[] = [
  { messageId: 'mask-question', sequence: '1', authorName: 'Jamie', text: '@Alex 明天下午 3 点之前能确认交付时间吗？', reply: { companion, text: '已记下需要确认的时间，等 Alex 回来决定。' } },
  { messageId: 'mask-question-2', sequence: '3', authorName: 'Taylor', text: '@Alex 客户询问批量导入是否支持表格附件，麻烦确认一下。' },
];
export function groupMaskVisualFixture(channel: string, raw: unknown): unknown {
  const request = raw as { ref?: { id?: string }; resourceRef?: { id?: string }; actionId?: string; input?: { action?: ChatMaskAction; readIds?: string[] } };
  if ((request?.ref?.id ?? request?.resourceRef?.id) !== 'mask-qa') return undefined;
  if (channel === 'maker:remote-resources:get') return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: 'mask-qa' }, revision: String(state.revision),
    display: { title: 'Mask QA · Synthetic data' }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: mentions.map(m => m.text).join('\n'), data: {
      id: 'mask-qa', name: 'Mask QA · Synthetic data', serverBacked: true, supportsPersonalMask: true, selfActorId: human.id,
      members: [{ botId: human.id, actorId: human.id, actorKind: 'human', name: human.name, avatar: '🙂', isSelf: true, role: 'member', status: 'active' },
        { botId: 'peer', actorKind: 'human', name: 'Jamie', avatar: '👩', isSelf: false, status: 'active' }],
      messages: [
        { id: 'mask-question', sequence: 1, kind: 'message', authorKind: 'user', authorBotId: 'peer', authorName: 'Jamie', isSelf: false, content: '@Alex 明天下午 3 点之前能确认交付时间吗？', createdAt: 1793250000000 },
        { id: 'mask-answer', sequence: 2, kind: 'message', authorKind: 'user', authorBotId: human.id, authorName: human.name, isSelf: true, content: '已记下需要确认的时间，等 Alex 回来决定。', createdAt: 1793250001000, maskAttribution: { self: human, companion, sourceMessageId: 'mask-question' } },
        { id: 'mask-question-2', sequence: 3, kind: 'message', authorKind: 'user', authorBotId: 'peer', authorName: 'Taylor', isSelf: false, content: '@Alex 客户询问批量导入是否支持表格附件，麻烦确认一下。', createdAt: 1793250002000 },
      ], plans: [], createdAt: 1793250000000, updatedAt: 1793250002000,
    } }],
  };
  if (channel !== 'maker:remote-resources:invoke') return undefined;
  if (request.actionId === 'mask-mentions') {
    if (request.input?.readIds) mentions = mentions.filter(m => !request.input!.readIds!.includes(m.messageId));
    return { result: { mentions, hasMore: false }, effects: [] };
  }
  if (request.actionId === 'mask') {
    const action = request.input?.action;
    if (action?.type === 'save') state = { ...state, settings: action.settings, revision: state.revision + 1, status: action.settings.enabled ? 'enabled' : 'off' };
    if (action?.type === 'participate') state = { ...state, status: 'paused' };
    if (action?.type === 'resume') state = { ...state, status: 'enabled', manualRunning: true };
    if (action?.type === 'stop') state = { ...state, status: 'waiting', manualRunning: false };
    if (action?.type === 'digest') state = { ...state, digestStatus: 'done' };
    return { result: { state }, effects: [] };
  }
  return { effects: [] };
}
