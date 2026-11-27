import type { Schedule } from '@cindy/maker-scheduler';
import { ctx, forbid, mountPage, subscription } from '../../ui-page/harness';
import { ScheduleFormDialog } from '../../../src/renderer/features/scheduler/components/ScheduleFormDialog';

const time = Date.now() - 90_000;
const source = { preset: 'plugin' as const, sources: [
  { plugin: 'org.xd/xd-feishu', events: ['message.direct'],
    filters: [{ field: 'fromSelf', operator: 'not-equals' as const, value: 'true' }] },
  { plugin: 'public/slack' },
  { plugin: 'public/uninstalled-mail' },
] };
const schedule: Schedule = {
  id: 'fixture', name: '有人找我时整理待办', prompt: '有人给我发消息时，读取原消息并判断是否需要我处理；需要的话整理成待办。',
  agentKind: 'codex', model: 'fixture-model', providerId: 'fixture', manual: true,
  recurring: true, cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai',
  workspaceKind: 'dialogue', useWorktree: false, notify: { desktop: true, feishu: false },
  status: 'active', kind: 'cron', source: 'user', jobType: 'prompt', createdAt: time, updatedAt: time,
  webhookTrigger: { endpointId: 'fixture-route', source },
};
const candidates = [
  { plugin: 'org.xd/xd-feishu', name: '飞书', state: 'listening' as const, events: [
    { type: 'message.direct', name: '收到私信', fields: ['chatId', 'senderId', 'fromSelf'] },
    { type: 'message.mention', name: '群里有人 @ 我', fields: ['chatId', 'senderId', 'fromSelf'] },
    { type: 'doc.comment', name: '文档有新评论', fields: ['docId', 'senderId'] },
  ] },
  { plugin: 'public/slack', name: 'Slack', state: 'disconnected' as const, events: [
    { type: 'message.direct', name: 'Direct message', fields: ['channel', 'user'] },
    { type: 'message.mention', name: 'Mentioned in a channel', fields: ['channel', 'user'] },
  ] },
  { plugin: 'public/gmail', name: 'Gmail', state: 'unknown' as const, events: [
    { type: 'mail.received', name: '收到新邮件', fields: ['label', 'from'] },
  ] },
];

void mountPage({
  route: '/cc-agent/scheduled',
  host: {
    ghosts: { listEventSources: async () => candidates, onChanged: subscription('ghostsChanged') },
    gitContext: { githubAppStatus: async () => ({ available: true, login: null }) },
    maker: {
      listAvailableAgents: async () => ['codex'],
      onAgentsChanged: subscription('agentsChanged'),
      schedule: {
        webhookReceiver: async () => (ctx.case === 'signed-out' ? 'signed-out' : 'cloud'),
        webhookAccount: async () => ({ used: 1, limit: 10, endpoints: [] }),
        scriptCapabilityStatus: async () => ({ statuses: [] }),
      },
    },
  },
  render: () => <ScheduleFormDialog open initial={ctx.case === 'default' ? schedule : null}
    onOpenChange={() => {}} onSubmit={forbid('save automation')} />,
});
