import type { MessageAutomationOrigin, StoredMessageOrigin } from '@/lib/ccAgent.types';

/**
 * 把落库的 agentMeta.origin 投影成气泡来源标签。
 *
 * - scheduler：自动化发送，点击跳自动化页；
 * - session：另一个任务经工具发送，点击跳来源任务；来源任务属于伙伴时带伙伴身份；
 * - orca：Lead / Worker 互发，卡片本身已标明角色，这里只补可跳转的发送方任务。
 *   老数据没有 senderSessionId 时不出标签，保持原卡片展示。
 */
export function toMessageAutomationOrigin(origin: unknown): MessageAutomationOrigin | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const value = origin as Partial<StoredMessageOrigin> & Record<string, unknown>;
  if (value.kind === 'scheduler') return value as MessageAutomationOrigin;
  if (value.kind !== 'session' && value.kind !== 'orca') return undefined;
  const senderSessionId = readNonEmptyString(value.senderSessionId);
  if (!senderSessionId) return undefined;
  if (value.kind === 'orca') return { kind: 'session', senderSessionId };
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

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
