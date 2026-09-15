import type { Session } from '@/lib/ccAgent.types';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import type { AttentionKind } from '@/lib/sessionAttentionStore';
import { isAutomationGeneratedSession } from './scheduledSessionGrouping';
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
  localSchedules: ReadonlyMap<string, ScheduleAttention>;
}

/**
 * 系统角标只统计**本机需要用户处理的非自动化任务**:
 *   - device-link 被控设备的远程任务由对端自己提醒,本机既没有可点击的任务行,
 *     也没有清除入口 —— 计入本机角标只会得到一个点不掉的外部数字;
 *   - 自动化会话(scheduler / learn,以及 legacy `[Schedule] ` 标题)的未读结果
 *     归自动化页与通知,不点亮系统角标。
 * 其余判据与任务行同源;定时任务**绑定在普通会话**上的未读仍计入(见 localSchedules)。
 */
function countsTowardAppAttention(session: Session): boolean {
  return (
    session.status === 'active' &&
    !isOrcaWorkerSession(session) &&
    session.deviceLinkDeviceId === undefined &&
    session.source !== 'learn' &&
    !isAutomationGeneratedSession(session)
  );
}

/** 与任务行的红/蓝/绿点同源，不随搜索、折叠或当前机器筛选改变。 */
export function countAppAttention(input: AppAttentionCountInput): number {
  const attentionIds = new Set<string>();
  for (const session of input.sessions) {
    if (!countsTowardAppAttention(session)) continue;
    const localSchedule = input.localSchedules.get(session.id);
    const activity = projectSidebarSessionActivity({
      interruption: session,
      sessionId: session.id,
      title: session.title,
      recordStatus: session.status,
      liveActivity: input.localActivities.get(session.id),
      attentionKind: input.attentionKinds.get(session.id),
      isUrgentFromContext: localSchedule?.hasUnreadFailedRun === true,
      isRunning: input.runningSessionIds.has(session.id),
      hasAttentionNotification:
        input.attentionKinds.has(session.id) || localSchedule?.hasUnreadRun === true,
    });
    const status = resolveSidebarRightStatus(activity);
    if (status === 'done' || status === 'awaiting' || status === 'error') {
      attentionIds.add(session.id);
    }
  }
  return attentionIds.size;
}
