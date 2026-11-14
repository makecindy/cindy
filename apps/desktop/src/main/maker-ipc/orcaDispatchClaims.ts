/**
 * Lead 派单主张对账：宿主只认派发凭据（send_to_worker / 初始派活成功返回），
 * 不认 Lead 文本里的「已派给 X」。判定发生在 turn 收口，误报只多问一轮，不会动派发本身。
 *
 * 三个概念分开，互不共享状态：
 * - 凭据（fact）：一次真实被接受的本轮派发，带目标 Worker、投递形态与队列编号；
 * - 主张（reading）：从收口文本里取出的「已派」句、句中声明的目标与带标签的队列编号；
 * - 处置（action）：一条 Lead 至多唤醒一次、升级一次，且在真派发出现前保持静默。
 */

export type OrcaDispatchDelivery = 'direct' | 'queued';

export interface LeadDispatchFact {
  /** 底层 dispatcher 为该消息生成的 clientId：同轮并行派发也互不相同。 */
  dispatchId: string;
  workerId: string;
  workerLabel: string;
  delivery: OrcaDispatchDelivery;
  /** 仅 queued 投递有：队列内寻址句柄，可与主张里的 queued_message_id 对照。 */
  queuedMessageId?: string;
  turnGeneration: number;
  at: number;
}

/** 一个协同成员：主张里的目标名按这张表解析，避免把任意词当 Worker。 */
export interface OrcaDispatchRosterEntry {
  id: string;
  label: string;
}

export interface DispatchClaimReading {
  claimed: boolean;
  /** 主张句里点名、且能在花名册里解析到的成员。 */
  targets: OrcaDispatchRosterEntry[];
  /** 主张句里显式标为队列编号的值（queued_message_id / queue id / 队列编号）。 */
  messageIds: string[];
  /** 唤醒文案引用的原句，附指针用。 */
  quote: string;
}

export type DispatchClaimVerdict =
  | { consistent: true }
  | {
      consistent: false;
      reason: 'no-dispatch' | 'target-not-dispatched' | 'unknown-message-id';
      /** 出问题的目标名或编号，用于文案与日志。 */
      detail: string;
    };

/** 一次收口该做什么：唤醒补派一次，或升级，或什么都不做。 */
export type DispatchClaimAction = 'wake' | 'escalate' | null;

interface LeadLedger {
  /** Session 实例代次：同一个任务重建 Session 后 turnGeneration 会从 0 重来，靠它作废旧凭据。 */
  epoch: number;
  lastGeneration: number | null;
  facts: LeadDispatchFact[];
  /** 已经唤醒过一次补派。 */
  woke: boolean;
  /** 已经升级过；真派发出现前不再唤醒，避免同一主张反复刷。 */
  escalated: boolean;
}

const MAX_FACTS_PER_LEAD = 40;
const ledgers = new Map<string, LeadLedger>();

/** 主张识别只取「过去完成态 + 派动词」；计划、将来说明、读完文件后的推断都不算。 */
const DISPATCH_CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:已|已经)(?:把|将)?[^。！？\n]{0,40}?(?:派给|派发给|派发|派出|分派给|交给|转给)/,
  /(?:已|已经)(?:派|分派|发出)/,
  /\b(?:dispatched|assigned|sent|handed off)\b[^.\n]{0,30}\bworker\b/i,
  /\bI(?:'ve| have)?\s+(?:already\s+)?(?:dispatched|assigned|sent)\b/i,
];

/** 否认、假设、引用与待办同样带派动词，必须在主张判定前排除。 */
const NEGATION_PATTERNS: readonly RegExp[] = [
  /(?:尚未|还没|还没有|没有|未|并未|不能|不可|不该|不要|无法)(?:[^。！？\n]{0,12})?(?:派给|派发|派出|分派给|交给|转给)/,
  /(?:尚未|还没|还没有|没有|未|并未)(?:派|分派|发出)/,
  /(?:如果|假如|若|要是|将会|将要|准备|打算|计划)(?:[^。！？\n]{0,20})?(?:派给|派发|派出|分派给|交给|转给)/,
  /\b(?:not|never|n't|didn't|did not|haven't|have not|hasn't|has not|no longer|without)\b[^.\n]{0,30}\b(?:dispatched|assigned|sent|handed off)\b/i,
  /\b(?:will|would|plan(?:ning)? to|going to|about to|should|must|need to)\b[^.\n]{0,30}\b(?:dispatch|assign|send|hand off)\b/i,
  /\b(?:if|whether)\b[^.\n]{0,30}\b(?:dispatch|assign|send|hand off)\b/i,
];

/** 只认显式标注的队列编号；散落在别处的 UUID（Worker/任务 ID）不参与核对。 */
const LABELED_MESSAGE_ID_PATTERN =
  /(?:queued_message_id|queue[_ ](?:message[_ ])?id|队列编号|排队编号|排队号)\s*[:：=]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

const FENCED_CODE_PATTERN = /```[\s\S]*?```/g;
const BLOCKQUOTE_LINE_PATTERN = /^\s*>.*$/gm;

function emptyLedger(): LeadLedger {
  return { epoch: 0, lastGeneration: null, facts: [], woke: false, escalated: false };
}

function ledgerFor(leadSessionId: string): LeadLedger {
  const existing = ledgers.get(leadSessionId);
  if (existing) return existing;
  const created = emptyLedger();
  ledgers.set(leadSessionId, created);
  return created;
}

/** 观察到更小的 turnGeneration = 同一任务换了 Session 实例：作废旧凭据与节流状态。 */
function observeGeneration(ledger: LeadLedger, turnGeneration: number): void {
  if (ledger.lastGeneration !== null && turnGeneration < ledger.lastGeneration) {
    ledger.epoch += 1;
    ledger.facts = [];
    ledger.woke = false;
    ledger.escalated = false;
  }
  ledger.lastGeneration = turnGeneration;
}

export function noteLeadDispatchFact(leadSessionId: string, fact: LeadDispatchFact): void {
  const ledger = ledgerFor(leadSessionId);
  observeGeneration(ledger, fact.turnGeneration);
  ledger.facts.push(fact);
  if (ledger.facts.length > MAX_FACTS_PER_LEAD) {
    ledger.facts.splice(0, ledger.facts.length - MAX_FACTS_PER_LEAD);
  }
  // 真派发出现即视为恢复，重置升级抑制。
  ledger.escalated = false;
}

/** 撤回未派发的排队消息时同步撤掉凭据，否则对账会把它当成真实派发。 */
export function dropLeadDispatchFact(leadSessionId: string, queuedMessageId: string): void {
  const ledger = ledgers.get(leadSessionId);
  if (!ledger) return;
  ledger.facts = ledger.facts.filter((fact) => fact.queuedMessageId !== queuedMessageId);
}

/** 只取当前 Session 实例、本轮（含自动续跑推进过的代次）的凭据。 */
export function dispatchFactsForTurn(
  leadSessionId: string,
  turnGeneration: number,
): readonly LeadDispatchFact[] {
  const ledger = ledgerFor(leadSessionId);
  observeGeneration(ledger, turnGeneration);
  return ledger.facts.filter((fact) => fact.turnGeneration >= turnGeneration);
}

/** 句级切分：中文句号与英文句点都算边界，保留标点后的语气不影响判定。 */
function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[。！？.!?])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 引用块、行内代码与引号内文本是「转述」，不算 Lead 自己的主张。 */
function stripQuotedSegments(sentence: string): string {
  return sentence
    .replace(/`[^`]*`/g, ' ')
    .replace(/["“”][^"“”]{0,200}["“”]/g, ' ')
    .replace(/「[^」]{0,200}」/g, ' ');
}

/** 编号常被写成行内代码，核对前要拆掉反引号，否则假编号会在提取前丢掉。 */
function readMessageIdText(sentence: string): string {
  return sentence.replace(/`/g, '');
}

function hasClaimWord(sentence: string): boolean {
  return DISPATCH_CLAIM_PATTERNS.some((pattern) => pattern.test(sentence));
}

function hasNegation(sentence: string): boolean {
  return NEGATION_PATTERNS.some((pattern) => pattern.test(sentence));
}

function resolveTargets(sentence: string, roster: readonly OrcaDispatchRosterEntry[]): OrcaDispatchRosterEntry[] {
  const matched: OrcaDispatchRosterEntry[] = [];
  for (const entry of roster) {
    const label = entry.label.trim();
    // 单字标签太容易撞词，只按多字标签解析。
    if (label.length < 2 || !sentence.includes(label)) continue;
    if (matched.some((item) => item.id === entry.id)) continue;
    matched.push(entry);
  }
  return matched;
}

function extractLabeledMessageIds(sentence: string): string[] {
  const ids: string[] = [];
  for (const match of sentence.matchAll(LABELED_MESSAGE_ID_PATTERN)) {
    const id = match[1]?.toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function readDispatchClaim(
  text: string,
  roster: readonly OrcaDispatchRosterEntry[] = [],
): DispatchClaimReading {
  const body = (text ?? '').replace(FENCED_CODE_PATTERN, ' ').replace(BLOCKQUOTE_LINE_PATTERN, ' ');
  const targets: OrcaDispatchRosterEntry[] = [];
  const messageIds: string[] = [];
  let quote = '';

  for (const sentence of splitSentences(body)) {
    const own = stripQuotedSegments(sentence);
    if (!hasClaimWord(own) || hasNegation(own)) continue;
    for (const entry of resolveTargets(own, roster)) {
      if (!targets.some((item) => item.id === entry.id)) targets.push(entry);
    }
    for (const id of extractLabeledMessageIds(readMessageIdText(sentence))) {
      if (!messageIds.includes(id)) messageIds.push(id);
    }
    quote ||= own;
  }

  const claimed = quote.length > 0;
  return {
    claimed,
    targets,
    messageIds,
    quote: claimed ? clip(quote, 160) : '',
  };
}

function clip(text: string, limit: number): string {
  const body = text.replace(/\s+/g, ' ').trim();
  return body.length > limit ? `${body.slice(0, limit - 1)}…` : body;
}

export function verifyDispatchClaim(
  reading: DispatchClaimReading,
  facts: readonly LeadDispatchFact[],
): DispatchClaimVerdict {
  if (!reading.claimed) return { consistent: true };

  // 本轮没有任何派发时，一切主张都归为「没派」——不再细分目标或编号。
  if (facts.length === 0) return { consistent: false, reason: 'no-dispatch', detail: '' };

  const queuedIds = new Set(
    facts.flatMap((fact) => (fact.queuedMessageId ? [fact.queuedMessageId.toLowerCase()] : [])),
  );
  const unknownId = reading.messageIds.find((id) => !queuedIds.has(id));
  if (unknownId) {
    return { consistent: false, reason: 'unknown-message-id', detail: unknownId };
  }

  const dispatchedWorkerIds = new Set(facts.map((fact) => fact.workerId));
  const missingTarget = reading.targets.find((target) => !dispatchedWorkerIds.has(target.id));
  if (missingTarget) {
    return { consistent: false, reason: 'target-not-dispatched', detail: missingTarget.label };
  }

  return { consistent: true };
}

/** 卡片与唤醒文本共用的短原因，避免同一判定在别处再写一遍分支。 */
export function describeDispatchClaimVerdict(verdict: DispatchClaimVerdict): string {
  if (verdict.consistent) return '';
  switch (verdict.reason) {
    case 'no-dispatch':
      return 'this turn has no accepted dispatch';
    case 'target-not-dispatched':
      return `no dispatch to ${verdict.detail}`;
    case 'unknown-message-id':
      return `queue id ${verdict.detail} matches no dispatch`;
  }
}

/**
 * 一次收口的处置：
 * - 一致 → 清状态，返回 null；
 * - 首次不一致 → wake（只唤醒一次）；
 * - 补派轮仍不一致 → escalate，并抑制该 Lead 的后续唤醒直到真派发出现；
 * - 已升级过 → null（不重复刷）。
 */
export function settleDispatchClaimIncident(leadSessionId: string, consistent: boolean): DispatchClaimAction {
  const ledger = ledgerFor(leadSessionId);
  if (consistent) {
    ledger.woke = false;
    ledger.escalated = false;
    return null;
  }
  if (ledger.escalated) return null;
  if (ledger.woke) {
    ledger.woke = false;
    ledger.escalated = true;
    return 'escalate';
  }
  ledger.woke = true;
  return 'wake';
}

export function resetDispatchClaimState(): void {
  ledgers.clear();
}
