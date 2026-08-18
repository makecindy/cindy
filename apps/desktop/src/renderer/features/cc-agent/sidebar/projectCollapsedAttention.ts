import type { AttentionKind } from '@/lib/sessionAttentionStore';
import type { RemoteSessionActivityPhase } from '@/features/device-link/remoteSessionActivityStore';

export type CollapsedProjectAttentionTone = 'error' | 'done';

interface CollapsedProjectAttentionInput {
  sessions: readonly { id: string }[];
  runningSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  attentionKinds: ReadonlyMap<string, AttentionKind>;
  urgentSessionIds: ReadonlySet<string>;
  remotePhaseOf: (sessionId: string) => RemoteSessionActivityPhase | undefined;
}

/**
 * 折叠项目只汇总子任务实际可见的红/绿状态点。等待回复(蓝)与运行态不在此处
 * 升格；若红绿同时存在，错误红点优先。
 */
export function resolveCollapsedProjectAttentionTone({
  sessions,
  runningSessionIds,
  notifications,
  attentionKinds,
  urgentSessionIds,
  remotePhaseOf,
}: CollapsedProjectAttentionInput): CollapsedProjectAttentionTone | null {
  let hasDone = false;

  for (const session of sessions) {
    const remotePhase = remotePhaseOf(session.id);
    if (remotePhase) {
      if (remotePhase === 'error') return 'error';
      if (remotePhase === 'completed') hasDone = true;
      // 远程活动镜像是远程行右侧状态的权威来源；running / needs-interaction
      // 分别显示 spinner / 蓝点，不能再被本地残留状态误汇总成红绿点。
      continue;
    }

    if (urgentSessionIds.has(session.id)) return 'error';
    if (!notifications.has(session.id)) continue;

    const attentionKind = attentionKinds.get(session.id);
    if (attentionKind === 'error') return 'error';
    if (attentionKind === 'awaiting' || runningSessionIds.has(session.id)) continue;
    hasDone = true;
  }

  return hasDone ? 'done' : null;
}
