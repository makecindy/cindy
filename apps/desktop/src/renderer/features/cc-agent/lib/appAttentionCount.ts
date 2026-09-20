import type { Session } from '@/lib/ccAgent.types';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import type { AttentionKind } from '@/lib/sessionAttentionStore';
import { resolveSessionRightStatus } from '@cindy/maker-shared/session-activity';
import {
  projectSidebarSessionActivity,
  type SidebarRightStatusInput,
} from '../sidebar/sidebarRightStatus';
import { isAutomationGeneratedSession } from './scheduledSessionGrouping';

type ScheduleAttention = { hasUnreadRun: boolean; hasUnreadFailedRun: boolean };

export interface AppAttentionCountInput {
  sessions: readonly Session[];
  attentionKinds: ReadonlyMap<string, AttentionKind>;
  runningSessionIds: ReadonlySet<string>;
  localActivities: ReadonlyMap<string, SidebarRightStatusInput['liveActivity']>;
  localSchedules: ReadonlyMap<string, ScheduleAttention>;
}

/** 系统角标仍统计错误；不随侧栏隐藏错误红点、搜索或折叠改变。 */
export function countAppAttention(input: AppAttentionCountInput): number {
  const attentionIds = new Set<string>();
  for (const session of input.sessions) {
    if (
      session.status !== 'active' ||
      isOrcaWorkerSession(session) ||
      session.deviceLinkDeviceId !== undefined ||
      isAutomationGeneratedSession(session) ||
      session.source === 'learn'
    )
      continue;
    const activity = projectSidebarSessionActivity({
      interruption: session,
      sessionId: session.id,
      title: session.title,
      recordStatus: session.status,
      liveActivity: input.localActivities.get(session.id),
      attentionKind: input.attentionKinds.get(session.id),
      isUrgentFromContext: false,
      isRunning: input.runningSessionIds.has(session.id),
      hasAttentionNotification: input.attentionKinds.has(session.id),
    });
    const status = resolveSessionRightStatus(activity);
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
