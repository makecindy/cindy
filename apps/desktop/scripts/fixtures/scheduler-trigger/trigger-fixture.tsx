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

// Issue #10224: automation prompts are often dozens of lines long.
const longPrompt = Array.from({ length: 40 }, (_, index) =>
  `${index + 1}. 检查项目的新动态，按负责人分组并总结需要跟进的事项。`).join('\n');

// The official GitLab plugin (event names from its manifest), installed only in the gitlab-plugin-* cases.
const gitlabPlugin = ctx.case.startsWith('gitlab-plugin') ? [{
  plugin: 'cindy-gitlab', name: 'GitLab', state: 'listening',
  events: [['merge_request.opened', 'MR 新建'], ['merge_request.updated', 'MR 有新提交或更新'], ['merge_request.comment', 'MR 新评论'],
    ['merge_request.approved', 'MR 被批准'], ['merge_request.pipeline', 'MR 流水线出结果'], ['merge_request.merged', 'MR 已合并'],
    ['issue.opened', 'Issue 新建'], ['issue.comment', 'Issue 新评论'], ['issue.closed', 'Issue 已关闭']]
    .map(([type, name]) => ({ type, name, fields: ['host', 'project', 'iid'] })),
}] : [];

void mountPage({
  route: '/cc-agent/scheduled',
  host: { ghosts: { listEventSources: async () => gitlabPlugin, onChanged: subscription('ghostsChanged') }, gitContext: {
    githubAppStatus: async () => ({ available: true, login: null }),
    // Fixture lookup: #7 is an issue, every other number a pull request.
    resolveGithubItem: async (_repository: string, number: number) => number === 7
      ? { ok: true, kind: 'issue', title: '启动时崩溃', state: 'open' }
      : { ok: true, kind: 'pr', title: '修复启动流程', state: 'open' },
  }, maker: {
    listAvailableAgents: async () => ['codex'],
    onAgentsChanged: subscription('agentsChanged'),
    schedule: {
    webhookReceiver: async () => 'cloud',
    webhookAccount: async () => ({ used: 1, limit: 10, endpoints: [] }),
    scriptCapabilityStatus: async () => ({ statuses: [] }),
  } } },
  render: () => <ScheduleFormDialog open
    initial={ctx.case === 'script-settings' ? { ...schedule, webhookTrigger: undefined, executionMode: 'script',
      scriptConfig: { command: 'node read-status.mjs', capabilities: ['settings.read', 'usage.read'] } }
      : ctx.case === 'create' ? null
      : ctx.case === 'long-prompt' || ctx.case === 'expanded' ? { ...schedule, prompt: longPrompt } : schedule}
    initialValues={ctx.case === 'create' ? { webhookEnabled: true } : undefined}
    onOpenChange={() => {}} onSubmit={forbid('save automation')} />,
});
