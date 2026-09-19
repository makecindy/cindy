import type {
  CindyMakeHistoryRecord,
  MakeFeatureAction,
  MakeHistoryCompletion,
} from '../../shared/cindyMakeHistory.js';
import { activeFeatureReceipts } from '../../shared/cindyMakeHistory.js';
import type { MakeFeatureMergePlan } from '../../shared/cindyMakeMerge.js';

/** Content deltas remain usable after rebase rewrites commit IDs. Undo uses the actual adopted delta. */
export function planFeatureChange(
  record: CindyMakeHistoryRecord,
  action: MakeFeatureAction,
  completion?: MakeHistoryCompletion,
): MakeFeatureMergePlan {
  const latest = record.receipts.at(-1);
  const active = activeFeatureReceipts(record.receipts);
  const plan: MakeFeatureMergePlan = {
    runId: record.runId,
    taskSessionId: record.sessionId,
    action,
    taskTree: latest?.taskTree ?? '',
    steps: [],
    nextStep: 0,
  };
  if (action === 'revert') {
    if (!active.length) throw new Error('No integrated feature to undo');
    plan.steps = active
      .slice()
      .reverse()
      .map((item) => ({ before: item.tree, after: item.beforeTree }));
    return plan;
  }
  if (action === 'reapply' || latest?.action === 'revert') {
    if (latest?.action !== 'revert') throw new Error('No reverted feature to reapply');
    plan.steps.push({ before: latest.tree, after: latest.beforeTree });
    if (action === 'reapply') return plan;
  }
  if (!completion?.tree || !completion.commit) throw new Error('No verified completion');
  plan.taskTree = completion.tree;
  plan.completionId = completion.id;
  if (latest) {
    if (latest.taskTree !== completion.tree)
      plan.steps.push({ before: latest.taskTree, after: completion.tree });
  } else plan.mergeCommit = completion.commit;
  return plan;
}
