import type {
  MessageAutomationOrigin,
  MessageSchedulerOrigin,
  StoredMessageOrigin,
} from '@/lib/ccAgent.types';

/**
 * 把落库的 agentMeta.origin 投影成气泡来源标签。
 *
 * - scheduler：自动化发送，点击跳自动化页；共享任务访客收到的已脱敏（无 scheduleId），
 *   只显示「由自动化发送」。Hook 渠道消息复用 scheduler 形态（见 isHookSchedulerOrigin），
 *   界面显示渠道，不显示自动化；
 * - session：另一个任务经工具发送，点击跳来源任务；来源任务属于伙伴时带伙伴身份；
 * - orca：Lead / Worker 互发。卡片本身标明角色（orcaSenderLabel = Worker 的 role），
 *   来源标签只补可跳转的发送方任务——老数据没有 senderSessionId 时不出标签。
 */
export function toMessageAutomationOrigin(origin: unknown): MessageAutomationOrigin | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const value = origin as Partial<StoredMessageOrigin> & Record<string, unknown>;
  if (value.kind === 'scheduler') return value as MessageAutomationOrigin;
  if (value.kind !== 'session' && value.kind !== 'orca') return undefined;
  const senderSessionId = readNonEmptyString(value.senderSessionId);
  if (value.kind === 'orca') {
    const orcaSenderLabel = readNonEmptyString(value.senderLabel);
    if (!senderSessionId && !orcaSenderLabel) return undefined;
    return {
      kind: 'session',
      orca: true,
      ...(senderSessionId ? { senderSessionId } : {}),
      ...(orcaSenderLabel ? { orcaSenderLabel } : {}),
    };
  }
  // 共享任务访客收到的是主机脱敏后的来源：仍标出「由其他任务发送」，但不带身份、不可跳转。
  if (!senderSessionId) return { kind: 'session' };
  const senderSessionTitle = readNonEmptyString(value.senderSessionTitle);
  const senderBotId = readNonEmptyString(value.senderBotId);
  const senderBotName = readNonEmptyString(value.senderBotName);
  return {
    kind: 'session',
    senderSessionId,
    ...(senderSessionTitle ? { senderSessionTitle } : {}),
    ...(senderBotId ? { senderBotId, ...(senderBotName ? { senderBotName } : {}) } : {}),
  };
}

const HOOK_SCHEDULE_ID_PREFIX = 'hook:';
const HOOK_SCHEDULE_NAME_PREFIX = /^Hook\s*·\s*/;

/**
 * Hook 渠道（Slack / Telegram / X …）的消息复用 scheduler 来源，scheduleId 为
 * `hook:<连接 id>`、scheduleName 为 `Hook · <连接名>`。它不是自动化：不能显示
 * 「由自动化…发送」，也没有可跳转的自动化条目。
 */
export function isHookSchedulerOrigin(origin: MessageAutomationOrigin | undefined): boolean {
  return (
    origin?.kind === 'scheduler' &&
    typeof origin.scheduleId === 'string' &&
    origin.scheduleId.startsWith(HOOK_SCHEDULE_ID_PREFIX)
  );
}

/** 真正由自动化注入的消息（不含 Hook 渠道）：只有它们用 3 行收起与短导航刻度。 */
export function isRealAutomationOrigin(origin: MessageAutomationOrigin | undefined): boolean {
  return origin?.kind === 'scheduler' && !isHookSchedulerOrigin(origin);
}

/** Hook 来源的连接名（去掉 `Hook · ` 前缀）；取不到返回 undefined。 */
export function hookConnectionNameFromOrigin(origin: MessageSchedulerOrigin): string | undefined {
  const name = readNonEmptyString(origin.scheduleName);
  if (!name) return undefined;
  return readNonEmptyString(name.replace(HOOK_SCHEDULE_NAME_PREFIX, ''));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
