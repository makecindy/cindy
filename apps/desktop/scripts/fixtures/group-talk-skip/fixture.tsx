import { useState } from 'react';
import { ctx, mountPage } from '../../ui-page/harness';
import { BotGroupTimelineItem } from '../../../src/renderer/features/bots/BotGroupTimelineItem';
import type { BotGroupPlanView } from '../../../src/shared/botGroupChat';

const names = ['PR 管理', 'Engineering Delivery Teammate', 'Search Ads Review', '选题策划', '代码审计', 'Cindy'];
const initial: BotGroupPlanView = {
  id: 'queue', kind: 'talk', status: ctx.case === 'stopped' ? 'stopped' : ctx.case === 'waiting' ? 'waiting' : 'running',
  supportsPendingSkip: ctx.case !== 'legacy',
  organizerBotId: 'bot-0', organizerName: names[0], currentStep: 1, canManage: ctx.case !== 'viewer',
  workDir: null, branch: null, createdAt: 1, updatedAt: 1,
  steps: names.map((botName, position) => ({ position, botId: `bot-${position}`, botName, task: '',
    status: position === 0 ? 'done' : position === 1 ? ctx.case === 'waiting' ? 'done' : 'running' : 'pending',
    ...(position === 1 && ctx.case !== 'legacy' ? { executionId: 'queued-attempt', executionStatus: ctx.case === 'running' ? 'running' : 'queued' } : {}),
  })),
};
function Fixture() {
  const [plan, setPlan] = useState(initial);
  const [pending, setPending] = useState<'edit' | null>(ctx.case === 'busy' ? 'edit' : null);
  return <main className="p-4"><BotGroupTimelineItem plan={plan} members={[]}
    message={{ id: 'queue-message', sequence: 1, kind: 'plan', authorKind: 'bot',
      authorBotId: 'bot-0', authorName: names[0], content: '', mentions: { all: false, botIds: [] },
      noticeCode: null, planId: plan.id, files: [], attachments: [], createdAt: 1 }}
    continued={false} authorName={names[0]} mentionLabels={[]} locale={ctx.locale}
    shareScope="fixture" sharing={false} onChanged={() => {}} planReassignable
    planPending={pending}
    onEditStep={(_planId, step, action) => {
      if (action !== 'skip') throw new Error('Unexpected command');
      setPending('edit');
      // Fixture-only receipt. Production scheduling and races are covered by server integration tests.
      setTimeout(() => {
        const steps = plan.steps.map(s => s.position === step.position
          ? { ...s, status: 'skipped' as const, executionId: undefined, executionStatus: undefined } : s);
        const next = steps.find(s => s.position > (plan.currentStep ?? -1) && s.status === 'pending');
        const advance = step.position === plan.currentStep;
        setPlan({ ...plan,
          status: !next && (advance || plan.status === 'waiting') ? 'done' : plan.status,
          currentStep: advance && next ? next.position : plan.currentStep,
          steps: steps.map(s => advance && s === next
            ? { ...s, status: 'running', executionId: 'next-attempt', executionStatus: 'running' } : s),
        });
        setPending(null);
      }, 50);
    }} /></main>;
}
void mountPage({ render: () => <Fixture /> });
