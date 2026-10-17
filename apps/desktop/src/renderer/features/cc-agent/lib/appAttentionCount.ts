import type { Session } from '@/lib/ccAgent.types';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import type { AttentionKind } from '@/lib/sessionAttentionStore';
import {
  projectSidebarSessionActivity,
  resolveSidebarRightStatus,
  type SidebarRightStatusInput,
} from '../sidebar/sidebarRightStatus';
import { isAutomationGeneratedSession } from './scheduledSessionGrouping';
import {
  mergeOrcaLeadAttentionKind,
  type OrcaLeadWorkerAttentionKind,
} from './orcaLeadWorkerAttention';

type ScheduleAttention = { hasUnreadRun: boolean; hasUnreadFailedRun: boolean };

export interface AppAttentionCountInput {
  sessions: readonly Session[];
  attentionKinds: ReadonlyMap<string, AttentionKind>;
  runningSessionIds: ReadonlySet<string>;
  localActivities: ReadonlyMap<string, SidebarRightStatusInput['liveActivity']>;
  localSchedules: ReadonlyMap<string, ScheduleAttention>;
  /** Orca Lead → 其 Worker 汇总的出错 / 等待确认;与侧栏 Lead 行同口径,一个 Lead 只算 1。 */
  orcaLeadWorkerAttention?: ReadonlyMap<string, OrcaLeadWorkerAttentionKind>;
}

/** 与任务行的红/蓝/绿点同源，不随搜索、折叠或当前机器筛选改变。 */
export function countAppAttention(input: AppAttentionCountInput): number {
  const attentionIds = new Set<string>();
  for (const session of input.sessions) {
    if (
      session.status !== 'active' ||
      (!CINDY_MAKE_ENABLED && isCindyMakeSource(session.source)) ||
      session.source === 'bot' ||
      isOrcaWorkerSession(session) ||
      session.deviceLinkDeviceId !== undefined ||
      isAutomationGeneratedSession(session) ||
      session.source === 'learn'
    )
      continue;
    const orcaWorkerAttentionKind = input.orcaLeadWorkerAttention?.get(session.id);
    const activity = projectSidebarSessionActivity({
      interruption: session,
      sessionId: session.id,
      title: session.title,
      recordStatus: session.status,
      liveActivity: input.localActivities.get(session.id),
      attentionKind: mergeOrcaLeadAttentionKind(
        input.attentionKinds.get(session.id),
        orcaWorkerAttentionKind,
      ),
      isUrgentFromContext: false,
      isRunning: input.runningSessionIds.has(session.id),
      hasAttentionNotification:
        input.attentionKinds.has(session.id) || orcaWorkerAttentionKind !== undefined,
    });
    const status = resolveSidebarRightStatus(activity);
    // heartbeat 绑普通任务时 runner 保留 desktop 来源，完成会写入 done；
    // 只压未读自动化 done，不连同之后的 awaiting / error 一起丢掉。
    if (status === 'done' && input.localSchedules.get(session.id)?.hasUnreadRun === true) {
      continue;
    }
    if (status === 'done' || status === 'awaiting' || status === 'error') {
      attentionIds.add(session.id);
    }
  }
  return attentionIds.size;
}
