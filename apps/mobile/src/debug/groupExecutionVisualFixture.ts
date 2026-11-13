/** Synthetic group execution states in the existing __DEV__ --mock host only.
 * /companions/groups/execution-qa?deviceId=cindy-visual-mock-mac
 * No server, model, real account or permission is contacted. */
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_CLIENT_ID, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';
import type { PendingInteraction } from '@/session/types';

const GROUP = 'execution-qa';
const NOW = Date.now();
const members = [
  { botId: 'qa-research', name: '资料伙伴', avatar: 'cindy://avatar/preset/cindy' },
  { botId: 'qa-design', name: '设计伙伴 · 很长的成员名称用于窄屏检查', avatar: 'cindy://avatar/preset/lizi' },
  { botId: 'qa-check', name: '核对伙伴', avatar: 'cindy://avatar/preset/dash' },
].map(member => ({ ...member, actorId: member.botId, actorKind: 'bot', isOwned: true, status: 'active' }));
const prompts: Record<string, PendingInteraction[]> = {
  'qa-permission': [{ request: { kind: 'permission', requestId: 'qa-permission-request', toolName: 'Bash',
    input: { command: 'pnpm --filter mobile typecheck', description: '核对移动端改动的类型；这是合成的权限卡，不会执行命令。' } } }],
  'qa-question': [{ request: { kind: 'ask_user_question', requestId: 'qa-question-request', questions: [
    { header: '验收顺序', question: '先核对哪个屏幕？选择只保存在模拟数据中，不会发给真实伙伴。', options: [
      { label: '群内执行', description: '先检查三位伙伴的进展与两个等待卡。' },
      { label: '分工步骤', description: '先检查长步骤、状态与继续操作。' },
    ] },
  ] } }],
};
let running = true;
export function groupExecutionVisualFixture(channel: string, args: unknown[]): unknown | undefined {
  const request = args[0] as { ref?: { id?: string }; resourceRef?: { id?: string }; actionId?: string } | undefined;
  if (channel === 'maker:resolve-interaction' && typeof args[0] === 'string' && args[0].startsWith('qa-')) {
    for (const [session, list] of Object.entries(prompts)) if (list.some(item => item.request.requestId === args[0])) prompts[session] = [];
    return { accepted: true };
  }
  if (channel === 'maker:get-pending-interactions' && typeof args[0] === 'string' && args[0].startsWith('qa-')) return prompts[args[0]] ?? [];
  if (channel === 'local-db:messages:around-client-id' && typeof args[0] === 'string' && args[0].startsWith('qa-')) {
    const bot = args[0] === 'qa-work' || args[0] === 'qa-permission' ? 'qa-design' : args[0] === 'qa-question' ? 'qa-check' : 'qa-research';
    const execution = args[0] === 'qa-work' ? 'qa-e2-work' : args[0] === 'qa-permission' ? 'qa-e2' : args[0] === 'qa-question' ? 'qa-e3' : 'qa-e1';
    return [{ clientId: BOT_GROUP_CLIENT_ID.memberTurn(args[0] === 'qa-work' ? `${GROUP}-work` : GROUP, execution, bot), role: 'user', type: 'text', content: '合成执行输入', createdAt: new Date(NOW - 30_000).toISOString() },
      { clientId: `note-${execution}`, role: 'assistant', type: 'text', content: '已核对现有信息，正在整理下一步。', createdAt: new Date(NOW - 25_000).toISOString() },
      ...(args[0] === 'qa-work' ? [
        { clientId: 'qa-full-input', role: 'tool_use', toolUseId: 'qa-full-input', content: { toolName: 'Bash', toolUseId: 'qa-full-input',
          input: { command: `printf "${'group process input '.repeat(15)}COMPLETE_INPUT_END"` } }, createdAt: new Date(NOW - 24_000).toISOString() },
        { clientId: 'qa-full-input-result', role: 'tool_result', toolUseId: 'qa-full-input', content: '合成工具结果，不会执行命令。', createdAt: new Date(NOW - 23_000).toISOString() },
      ] : [])];
  }
  const groupId = request?.ref?.id ?? request?.resourceRef?.id;
  if (!groupId || ![GROUP, `${GROUP}-work`, `${GROUP}-talk`, `${GROUP}-member`, `${GROUP}-legacy`, `${GROUP}-peer`].includes(groupId)) return undefined;
  if (channel === 'maker:remote-resources:invoke') { if (request?.actionId === 'stop') running = false; return { effects: [] }; }
  if (channel !== 'maker:remote-resources:get') return undefined;
  if (groupId.endsWith('-work') || groupId.endsWith('-talk')) {
    const talk = groupId.endsWith('-talk');
    const steps = members.map((member, index) => ({ position: index, botId: member.botId, botName: member.name,
      task: talk ? '说说看法' : ['整理完整的调研结果，保留每项结论及其依据，让长步骤在窄屏上也能完整阅读。',
        '核对三位伙伴的进展，确认权限卡与提问卡完整可操作，并检查 Light 与 Dark 两种模式。', '复核交付与恢复操作。'][index],
      status: index === 0 ? 'done' : talk || index > 1 ? 'pending' : 'running',
      ...(index === 0 ? { resultMessageId: 'qa-done' } : {}) }));
    const plan = { id: 'qa-plan', kind: talk ? 'talk' : 'work', status: talk ? 'waiting' : 'running', revision: 1,
      organizerBotId: members[0].botId, organizerName: members[0].name, steps, currentStep: talk ? 0 : 1,
      canManage: true, supportsPendingSkip: talk, createdAt: NOW - 90_000, updatedAt: NOW - 20_000 };
    return { ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: groupId }, revision: '1',
      display: { title: talk ? '讨论 · 模拟数据' : '分工 · 模拟数据' }, actions: [], links: [], blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: '', data: {
        id: groupId, name: talk ? '讨论 · 模拟数据' : '分工 · 模拟数据', serverBacked: true, replyMode: 'mentioned', speakingMode: 'auto',
        members, plans: [plan], openPlan: { ...plan, stepCount: 3 }, createdAt: NOW, updatedAt: NOW,
        messages: [{ id: 'qa-card', sequence: 1, kind: 'plan', planId: plan.id, authorKind: 'bot', authorBotId: members[0].botId,
          authorName: members[0].name, content: '', createdAt: NOW - 90_000 },
          { id: 'qa-done', sequence: 2, kind: 'message', planId: plan.id, authorKind: 'bot', authorBotId: members[0].botId,
          authorName: members[0].name, content: '调研结果已整理好，可以继续核对。', createdAt: NOW - 25_000 }],
        round: { status: talk ? 'idle' : 'running', canContinue: false, speakers: talk ? [] : [
          { botId: members[1].botId, sessionId: 'qa-work', activity: 'step', executionId: 'qa-e2-work', executionStatus: 'running', startedAt: NOW - 20_000 },
        ] },
      } }] };
  }
  const resource = { ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: groupId }, revision: String(running),
    display: { title: '群内执行 · 模拟数据' }, actions: [], links: [], blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: '', data: {
      id: groupId, name: '群内执行 · 模拟数据', serverBacked: true, replyMode: 'mentioned', speakingMode: 'auto',
      members, plans: [], supportsScopedStop: !groupId.endsWith('-legacy'), canStopAll: !groupId.endsWith('-member'), createdAt: NOW, updatedAt: NOW,
      messages: [{ id: 'qa-start', sequence: 1, kind: 'message', authorKind: 'user', isSelf: true,
        content: '请一起核对移动端群内执行，确认每位伙伴的进展与等待操作都可以完整阅读。', createdAt: NOW - 40_000 }],
      round: { status: running ? 'running' : 'idle', canContinue: false, othersActive: true, speakers: running ? [
        { botId: 'qa-research', sessionId: 'qa-research', activity: 'reply', executionId: 'qa-e1', executionStatus: 'running', startedAt: NOW - 30_000 },
        { botId: 'qa-design', sessionId: 'qa-permission', activity: 'reply', executionId: 'qa-e2', executionStatus: 'needs_input', startedAt: NOW - 20_000 },
        { botId: 'qa-check', sessionId: 'qa-question', activity: 'reply', executionId: 'qa-e3', executionStatus: 'needs_input', startedAt: NOW - 10_000 },
        { botId: 'qa-research', sessionId: null, activity: 'reply', executionId: 'qa-e4', executionStatus: 'queued' },
      ] : [] },
    } }] };
  if (groupId.endsWith('-peer')) {
    const data = resource.blocks[0].data;
    data.members = [{ ...members[0], botId: 'qa-cindy', actorId: 'qa-cindy', name: 'Cindy', isOwned: false }];
    data.canStopAll = false;
    Object.assign(data.round, { canStop: false, speakers: [
      { botId: 'qa-cindy', sessionId: null, activity: 'reply', executionId: 'qa-public-1', executionStatus: 'running' },
      { botId: 'qa-cindy', sessionId: null, activity: 'reply', executionId: 'qa-public-2', executionStatus: 'needs_input' },
    ] });
    data.messages = [{ id: 'qa-public-reply', sequence: 1, kind: 'message', authorKind: 'bot', isSelf: false,
      content: '已收到，我会把结果发到群里。', createdAt: NOW - 40_000,
      ...{ authorBotId: 'qa-cindy', authorName: 'Cindy' } }];
  }
  return resource;
}
