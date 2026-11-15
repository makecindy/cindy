import type { Schedule } from '@cindy/maker-scheduler';
import { ctx, forbid, mountPage, subscription } from '../../ui-page/harness';
import { ScheduleFormDialog } from '../../../src/renderer/features/scheduler/components/ScheduleFormDialog';

const schedule: Schedule = {
  id: 'fixture', name: '项目动态', prompt: '检查项目的新动态并总结。',
  agentKind: 'codex', model: 'fixture-model', providerId: 'fixture', manual: true,
  recurring: true, cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai',
  workspaceKind: 'dialogue', useWorktree: false, notify: { desktop: false, feishu: false },
  status: 'paused', kind: 'cron', source: 'user', jobType: 'prompt', createdAt: 1, updatedAt: 1,
  webhookTrigger: { events: ['issues.opened'], source: { preset: 'github' } },
};

void mountPage({
  route: '/cc-agent/scheduled',
  host: { maker: {
    listAvailableAgents: async () => ['codex'],
    onAgentsChanged: subscription('agentsChanged'),
    schedule: {
    webhookReceiver: async () => 'cloud',
    webhookAccount: async () => ({ used: 1, limit: 10, endpoints: [] }),
    scriptCapabilityStatus: async () => ({ statuses: [] }),
  } } },
  render: () => <ScheduleFormDialog open initial={ctx.case === 'create' ? null : schedule}
    initialValues={ctx.case === 'create' ? { webhookEnabled: true } : undefined}
    onOpenChange={() => {}} onSubmit={forbid('save automation')} />,
});
