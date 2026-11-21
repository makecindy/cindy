import type { AttentionKind } from '@/lib/sessionAttentionStore';
import {
  hasPendingSessionInterruption,
  type SessionInterruptionState,
  type SessionRightStatus,
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
  /** 折叠容器右侧状态槽要显示的档位;两者都没有则 null(回落时间文字)。 */
  tone: CollapsedAttentionTone | null;
  /**
   * 贡献红点的子任务 id —— **未处理告警**的集合。
   *
   * ⚠️ 这个列表存在的理由:折叠容器一旦汇总出红点,用户必须能找到那条子任务。
   * 项目行展开后子任务各自成行,天然可达;定时任务分组收起时子行整片不渲染,
   * 组头此前只代表「最新一条」运行,于是「组里第 3 新的运行有未处理告警」会变成
   * 「项目折叠头亮红点、展开却哪儿都找不到」(实测:一条被 App 重启打断、turn 从未
   * 收尾的定时任务运行)。分组收起态据此打开贡献告警的运行，展开后可查看完整历史。
   */
  errorSessionIds: readonly string[];
}

/**
 * 折叠容器(项目行 / 定时任务分组头)汇总子任务实际可见的红/绿状态点。等待回复(蓝)
 * 与运行态不在此处升格;若红绿同时存在,错误红点优先。
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
      // 分别显示 spinner / 蓝点，不能再被本地残留状态误汇总成红绿点。
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
    tone: errorSessionIds.length > 0 ? 'error' : hasDone ? 'done' : null,
    errorSessionIds,
  };
}

/** 只要 tone 的调用点(项目折叠头)。语义见 resolveCollapsedAttention。 */
export function resolveCollapsedProjectAttentionTone(
  input: CollapsedAttentionInput,
): CollapsedAttentionTone | null {
  return resolveCollapsedAttention(input).tone;
}

export interface CollapsedAutomationGroupState {
  kind: SessionRightStatus;
  /** 与汇总状态对应的运行，确保点击状态入口能找到需要处理的那一条。 */
  sessionId: string | undefined;
  unreadCount: number;
}

/**
 * 自动化收起后只保留一个入口，因此连旧运行的等待回复和运行中状态也必须汇总。
 * 普通项目仍沿用红/绿汇总；这里复用其告警判据，再补齐自动化的五档状态与打开目标。
 */
export function resolveCollapsedAutomationGroupState(
  input: CollapsedAttentionInput & {
    latestSessionId?: string;
    latestKind?: SessionRightStatus;
    localPhaseOf?: (sessionId: string) => RemoteSessionActivityPhase | undefined;
  },
): CollapsedAutomationGroupState {
  const localPhaseOf = (sessionId: string, deviceId?: string | null) =>
    deviceId ? undefined : input.localPhaseOf?.(sessionId);
  const attention = resolveCollapsedAttention({
    ...input,
    remotePhaseOf: (sessionId, deviceId) => {
      const remotePhase = input.remotePhaseOf(sessionId, deviceId);
      if (remotePhase) return remotePhase;
      const localPhase = localPhaseOf(sessionId, deviceId);
      // 本地终态是否未读仍由通知决定；活动中的等待/运行和错误不依赖未读标记。
      return localPhase === 'needs-interaction' || localPhase === 'running' || localPhase === 'error'
        ? localPhase
        : undefined;
    },
  });
  let awaitingSessionId: string | undefined;
  let runningSessionId: string | undefined;
  let doneSessionId: string | undefined;
  const unreadSessionIds = new Set<string>();

  for (const session of input.sessions) {
    // 失败运行的未读状态可只存在于 schedule urgency，不能依赖普通通知集合。
    if (input.urgentSessionIds.has(session.id)) unreadSessionIds.add(session.id);
    const remotePhase = input.remotePhaseOf(session.id, session.deviceLinkDeviceId);
    if (remotePhase) {
      if (remotePhase === 'needs-interaction') awaitingSessionId ??= session.id;
      else if (remotePhase === 'running') runningSessionId ??= session.id;
      else if (remotePhase === 'completed' || remotePhase === 'error') {
        unreadSessionIds.add(session.id);
        if (remotePhase === 'completed') doneSessionId ??= session.id;
      }
      // 远程镜像优先，不把旧的本地未读/运行标记重新汇总进来。
      continue;
    }

    const hasNotification = input.notifications.has(session.id);
    const localPhase = localPhaseOf(session.id, session.deviceLinkDeviceId);
    if (localPhase === 'needs-interaction') {
      awaitingSessionId ??= session.id;
      continue;
    }
    if (localPhase === 'running') {
      runningSessionId ??= session.id;
      continue;
    }
    if (localPhase === 'error') {
      if (hasNotification) unreadSessionIds.add(session.id);
      continue;
    }
    const kind = input.attentionKinds.get(session.id);
    if (hasNotification && kind === 'awaiting') awaitingSessionId ??= session.id;
    else if (input.runningSessionIds.has(session.id)) runningSessionId ??= session.id;
    else if (hasNotification) {
      unreadSessionIds.add(session.id);
      if (kind !== 'error' && !input.urgentSessionIds.has(session.id)) doneSessionId ??= session.id;
    }
  }

  const unreadCount = unreadSessionIds.size;
  const state: CollapsedAutomationGroupState = attention.errorSessionIds[0]
    ? { kind: 'error', sessionId: attention.errorSessionIds[0], unreadCount }
    : awaitingSessionId
      ? { kind: 'awaiting', sessionId: awaitingSessionId, unreadCount }
      : runningSessionId
        ? { kind: 'running', sessionId: runningSessionId, unreadCount }
        : doneSessionId
          ? { kind: 'done', sessionId: doneSessionId, unreadCount }
          : { kind: 'time', sessionId: input.latestSessionId, unreadCount };
  // 最新运行的实时状态不依赖未读标记。读过任务后，它仍可能在等待回复或继续运行。
  const priority: Record<SessionRightStatus, number> = {
    error: 4, awaiting: 3, running: 2, done: 1, time: 0,
  };
  if (input.latestSessionId && input.latestKind && priority[input.latestKind] > priority[state.kind]) {
    return { kind: input.latestKind, sessionId: input.latestSessionId, unreadCount };
  }
  return state;
}

/**
 * 定时任务分组头右侧状态槽的最终档位。
 *
 * 组头平时是「最新一条运行的代理」(状态 / loading / 点击目标都跟最新那条一致,
 * 2026-08 既有裁决),展开态照此不变;收起态它代表的却是**整组**,于是按整组汇总补两档:
 *   - 汇总出 error → 强制红。压过 latest 的 running spinner,与全端色表
 *     error > awaiting > running > done 一致 ——「等你处理」永远最高。
 *   - 汇总出 done → 只在组头自身无状态可显(time)时补绿。绿点若压掉 spinner 会造成
 *     「仍在跑却看起来已完成」的错觉(sidebarRightStatus 里有同款告警)。
 * awaiting(蓝)刻意不升格,与项目折叠头口径一致。
 */
export { resolveCollapsedGroupRightStatus } from '@cindy/maker-shared/session-activity';

/**
 * 组头点击打开哪一条。展开态仍打开最新一条;收起且整组是红时,
 * 打开贡献红点的那条,避免点红进到后来成功的巡检。
 */
export function resolveCollapsedGroupHeaderSessionId({
  collapsed,
  latestSessionId,
  attention,
}: {
  collapsed: boolean;
  latestSessionId: string | undefined;
  attention: Pick<CollapsedAttentionSummary, 'tone' | 'errorSessionIds'>;
}): string | undefined {
  if (collapsed && attention.tone === 'error' && attention.errorSessionIds[0]) {
    return attention.errorSessionIds[0];
  }
  return latestSessionId;
}
