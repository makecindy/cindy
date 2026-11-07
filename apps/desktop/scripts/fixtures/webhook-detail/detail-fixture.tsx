import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import { useEffect, useState } from 'react';
import { ctx, forbid, mountPage } from '../../ui-page/harness';
import { RunHistoryPane } from '../../../src/renderer/features/scheduler/components/RunHistoryPane';

const initial = ctx.case === 'initial';
const released = ctx.case === 'released';
const time = Date.now() - 60_000;
const schedule: Schedule = {
  id: 'fixture', name: 'GitHub 项目动态', prompt: '检查项目的新动态并总结。',
  agentKind: 'codex', manual: true, recurring: true, cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai',
  workspaceKind: 'dialogue', useWorktree: false, notify: { desktop: false, feishu: false },
  status: 'active', kind: 'cron', source: 'user', jobType: 'prompt', createdAt: time, updatedAt: time,
  webhookTrigger: { events: ['issues.opened'], source: { preset: 'github' } },
};
const runs: ScheduleRun[] = initial ? [] : [{
  id: 'run', scheduleId: schedule.id, status: 'success', firedAt: time, finishedAt: time + 4600,
  readAt: time + 5000, triggerSource: 'webhook', resultText: '检查完成',
}];
Object.assign(window, { __webhookFixtureRuns: runs });

function Detail() {
  const [visit, setVisit] = useState(0);
  useEffect(() => {
    const revisit = () => setVisit((value) => value + 1);
    window.addEventListener('webhook-fixture-revisit', revisit);
    return () => window.removeEventListener('webhook-fixture-revisit', revisit);
  }, []);
  return <div className="flex h-screen flex-col">
    <RunHistoryPane key={visit} schedule={schedule} onRunNow={() => {}} onEdit={() => {}} onTogglePause={() => {}} onDelete={() => {}} />
  </div>;
}

mountPage({
  route: '/cc-agent/scheduled',
  host: { maker: { schedule: {
    webhookReceiver: async () => 'cloud',
    webhookStatus: async () => ({ receiver: 'cloud', connected: ctx.case !== 'offline',
      url: released ? undefined : 'https://webhook.example.test/hooks/fixture',
      hasSecret: !initial, lastReceivedAt: initial ? undefined : time, ignored: 0,
      problem: released ? 'released' : undefined,
    }),
    webhookAccount: async () => ({ used: released ? 1 : 2, limit: 10, endpoints: [] }),
    setWebhookSecret: forbid('setWebhookSecret'),
    rotateWebhookUrl: forbid('rotateWebhookUrl'),
    restoreWebhookEndpoint: forbid('restoreWebhookEndpoint'),
  } } },
  render: () => <Detail />,
});
