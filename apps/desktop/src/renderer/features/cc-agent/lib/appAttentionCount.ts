import type { Session } from '@/lib/ccAgent.types';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import type { AttentionKind } from '@/lib/sessionAttentionStore';
import {
  projectSidebarSessionActivity,
  resolveSidebarRightStatus,
  type SidebarRightStatusInput,
} from '../sidebar/sidebarRightStatus';

type ScheduleAttention = { hasUnreadRun: boolean; hasUnreadFailedRun: boolean };

export interface AppAttentionCountInput {
  sessions: readonly Session[];
  attentionKinds: ReadonlyMap<string, AttentionKind>;
  runningSessionIds: ReadonlySet<string>;
  localActivities: ReadonlyMap<string, SidebarRightStatusInput['liveActivity']>;
  getRemoteActivity: (sessionId: string) => SidebarRightStatusInput['liveActivity'];
  localSchedules: ReadonlyMap<string, ScheduleAttention>;
  remoteSchedules: ReadonlyMap<string, ScheduleAttention>;
}

/** 与任务行的红/蓝/绿点同源，不随搜索、折叠或当前机器筛选改变。 */
export function countAppAttention(input: AppAttentionCountInput): number {
  const attentionIds = new Set<string>();
  for (const session of input.sessions) {
    if (session.status !== 'active' || isOrcaWorkerSession(session)) continue;
    const localSchedule = input.localSchedules.get(session.id);
    const remoteSchedule = input.remoteSchedules.get(session.id);
    const activity = projectSidebarSessionActivity({
      interruption: session,
      sessionId: session.id,
      title: session.title,
      recordStatus: session.status,
      liveActivity: input.getRemoteActivity(session.id) ?? input.localActivities.get(session.id),
      attentionKind: input.attentionKinds.get(session.id),
      isUrgentFromContext:
        localSchedule?.hasUnreadFailedRun === true || remoteSchedule?.hasUnreadFailedRun === true,
      isRunning: input.runningSessionIds.has(session.id),
      hasAttentionNotification:
        input.attentionKinds.has(session.id) ||
        localSchedule?.hasUnreadRun === true ||
        remoteSchedule?.hasUnreadRun === true,
    });
    const status = resolveSidebarRightStatus(activity);
    if (status === 'done' || status === 'awaiting' || status === 'error') {
      attentionIds.add(session.id);
    }
  }
  return attentionIds.size;
}
