/**
 * Lead 派单主张对账：宿主只认派发凭据（send_to_worker / 初始派活成功返回），
 * 不认 Lead 文本里的「已派给 X」。判定发生在 turn 收口，误报只多问一轮，不会动派发本身。
 */

export type OrcaDispatchDelivery = 'direct' | 'queued';

export interface LeadDispatchFact {
  leadSessionId: string;
  turnGeneration: number;
  workerId: string;
  workerLabel: string;
  delivery: OrcaDispatchDelivery;
  queuedMessageId?: string;
  at: number;
}

export interface DispatchClaimReading {
  claimed: boolean;
  messageIds: string[];
}

export type DispatchClaimVerdict =
  | { consistent: true }
  | { consistent: false; reason: 'no-dispatch' | 'unknown-message-id'; detail: string };

/** 一次收口该做什么：唤醒补派一次，或直接升级，或什么都不做。 */
export type DispatchClaimAction = 'wake' | 'escalate' | null;

const MAX_FACTS_PER_LEAD = 40;

const factsByLead = new Map<string, LeadDispatchFact[]>();
/** 已唤醒过一次的 Lead；下一次仍不一致就升级。 */
const wokeLeads = new Set<string>();
/** 升级过的 Lead 在真派发出现前不再唤醒，避免「唤醒→升级」自激。 */
const escalatedLeads = new Set<string>();

/** 主张识别只取「过去完成态 + 派动词」；计划、将来说明、读完文件后的推断都不算。 */
const DISPATCH_CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:已|已经)(?:把|将)?[^。！？\n]{0,40}?(?:派给|派发给|派发|派出|分派给|交给|转给)/,
  /(?:已|已经)(?:派|分派|发出)/,
  /\b(?:dispatched|assigned|sent|handed off)\b[^.\n]{0,30}\bworker\b/i,
  /\bI(?:'ve| have)?\s+(?:already\s+)?(?:dispatched|assigned|sent)\b/i,
];

const MESSAGE_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function noteLeadDispatchFact(fact: LeadDispatchFact): void {
  const list = factsByLead.get(fact.leadSessionId) ?? [];
  list.push(fact);
  if (list.length > MAX_FACTS_PER_LEAD) list.splice(0, list.length - MAX_FACTS_PER_LEAD);
  factsByLead.set(fact.leadSessionId, list);
  // 真派发出现即视为恢复，重置升级抑制。
  escalatedLeads.delete(fact.leadSessionId);
}

/** 撤回未派发的排队消息时同步撤掉凭据，否则对账会把它当成真实派发。 */
export function dropLeadDispatchFact(leadSessionId: string, queuedMessageId: string): void {
  const list = factsByLead.get(leadSessionId);
  if (!list) return;
  const next = list.filter((fact) => fact.queuedMessageId !== queuedMessageId);
  if (next.length !== list.length) factsByLead.set(leadSessionId, next);
}

/** 只取本轮（含自动续跑推进过的代次）的凭据。 */
export function dispatchFactsForTurn(leadSessionId: string, turnGeneration: number): LeadDispatchFact[] {
  return (factsByLead.get(leadSessionId) ?? []).filter((fact) => fact.turnGeneration >= turnGeneration);
}

export function detectDispatchClaim(text: string): DispatchClaimReading {
  const body = text ?? '';
  const claimed = DISPATCH_CLAIM_PATTERNS.some((pattern) => pattern.test(body));
  return { claimed, messageIds: claimed ? [...new Set(body.match(MESSAGE_ID_PATTERN) ?? [])] : [] };
}

/** 唤醒/升级文案里引用的那句主张，附指针用的短引用。 */
export function quoteClaimSentence(text: string, limit = 160): string {
  const body = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const sentence =
    body
      .split(/(?<=[。！？.!?])\s*/)
      .find((part) => DISPATCH_CLAIM_PATTERNS.some((pattern) => pattern.test(part))) ?? body;
  const trimmed = sentence.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

export function verifyDispatchClaim(
  reading: DispatchClaimReading,
  facts: readonly LeadDispatchFact[],
): DispatchClaimVerdict {
  if (!reading.claimed) return { consistent: true };
  if (reading.messageIds.length > 0) {
    const known = new Set(facts.flatMap((fact) => (fact.queuedMessageId ? [fact.queuedMessageId] : [])));
    const unknown = reading.messageIds.find((id) => !known.has(id));
    return unknown
      ? { consistent: false, reason: 'unknown-message-id', detail: unknown }
      : { consistent: true };
  }
  return facts.length === 0
    ? { consistent: false, reason: 'no-dispatch', detail: '' }
    : { consistent: true };
}

/**
 * 一次收口的处置：
 * - 一致 → 清状态，返回 null；
 * - 首次不一致 → wake（只唤醒一次）；
 * - 补派轮仍不一致 → escalate，并抑制该 Lead 的后续唤醒直到真派发出现；
 * - 已升级过 → null（不重复刷）。
 */
export function settleDispatchClaimIncident(leadSessionId: string, consistent: boolean): DispatchClaimAction {
  if (consistent) {
    wokeLeads.delete(leadSessionId);
    escalatedLeads.delete(leadSessionId);
    return null;
  }
  if (escalatedLeads.has(leadSessionId)) return null;
  if (wokeLeads.has(leadSessionId)) {
    wokeLeads.delete(leadSessionId);
    escalatedLeads.add(leadSessionId);
    return 'escalate';
  }
  wokeLeads.add(leadSessionId);
  return 'wake';
}

export function resetDispatchClaimState(): void {
  factsByLead.clear();
  wokeLeads.clear();
  escalatedLeads.clear();
}
