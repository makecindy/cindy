import type { AttentionKind } from '@/lib/sessionAttentionStore';
import {
  hasPendingSessionInterruption,
  type SessionInterruptionState,
} from '@cindy/maker-shared/session-activity';
import type { RemoteSessionActivityPhase } from '@/features/device-link/remoteSessionActivityStore';

export type CollapsedAttentionTone = 'error' | 'done';
/** @deprecated 保留旧名给既有调用点;新代码用 CollapsedAttentionTone。 */
export type CollapsedProjectAttentionTone = CollapsedAttentionTone;

interface CollapsedAttentionInput {
  sessions: readonly ({
    id: string;
    deviceLinkDeviceId?: string | null;
  } & SessionInterruptionState)[];
  runningSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  attentionKinds: ReadonlyMap<string, AttentionKind>;
  urgentSessionIds: ReadonlySet<string>;
  remotePhaseOf: (
    sessionId: string,
    deviceId?: string | null,
  ) => RemoteSessionActivityPhase | undefined;
}

export interface CollapsedAttentionSummary {
  /** 折叠容器的成功未读档位；没有则 null（回落最新状态或时间文字）。 */
  tone: CollapsedAttentionTone | null;
  /**
   * 未处理错误的子任务 id。保留收起态下错误条目的可达性，
   * 但不再据此显示红点或遮住其它子任务的成功未读提示。
   */
  errorSessionIds: readonly string[];
}

/**
 * 折叠容器汇总成功未读绿点，并保留错误子任务的可达性。
 * 错误不显示红点；等待回复与运行态不在此处升格。
 *
 * 这是折叠态「什么算告警」的**唯一**判据:项目折叠头取 tone,定时任务分组头同时取
 * tone 与 errorSessionIds(见该字段注释)。要改语义就只改这里,别在消费侧另写一份。
 */
export function resolveCollapsedAttention({
  sessions,
  runningSessionIds,
  notifications,
  attentionKinds,
  urgentSessionIds,
  remotePhaseOf,
}: CollapsedAttentionInput): CollapsedAttentionSummary {
  let hasDone = false;
  const errorSessionIds: string[] = [];

  for (const session of sessions) {
    if (hasPendingSessionInterruption(session)) {
      errorSessionIds.push(session.id);
      continue;
    }
    if (urgentSessionIds.has(session.id)) {
      errorSessionIds.push(session.id);
      continue;
    }
    const remotePhase = remotePhaseOf(session.id, session.deviceLinkDeviceId);
    if (remotePhase) {
      if (remotePhase === 'error') errorSessionIds.push(session.id);
      else if (remotePhase === 'completed') hasDone = true;
      // 远程活动镜像是远程行右侧状态的权威来源；running / needs-interaction
      // 分别显示 spinner / 蓝点，不能再被本地残留状态误汇总成完成绿点。
      continue;
    }

    if (urgentSessionIds.has(session.id)) {
      errorSessionIds.push(session.id);
      continue;
    }
    if (!notifications.has(session.id)) continue;

    const attentionKind = attentionKinds.get(session.id);
    if (attentionKind === 'error') {
      errorSessionIds.push(session.id);
      continue;
    }
    if (attentionKind === 'awaiting' || runningSessionIds.has(session.id)) continue;
    hasDone = true;
  }

  return {
    // Keep failed children discoverable, but no longer advertise failures with a dot.
    tone: hasDone ? 'done' : null,
    errorSessionIds,
  };
}

/** 只要 tone 的调用点(项目折叠头)。语义见 resolveCollapsedAttention。 */
export function resolveCollapsedProjectAttentionTone(
  input: CollapsedAttentionInput,
): CollapsedAttentionTone | null {
  return resolveCollapsedAttention(input).tone;
}

/**
 * 定时任务分组头沿用最新运行的状态，折叠时仅在最新状态为 time 时补成功未读绿点。
 * 本地汇总不产生 error；共享解析器保留其它端的错误汇总行为。
 * 等待回复不在此处升格，错误子任务通过独立子行保持可达。
 */
export { resolveCollapsedGroupRightStatus } from '@cindy/maker-shared/session-activity';
