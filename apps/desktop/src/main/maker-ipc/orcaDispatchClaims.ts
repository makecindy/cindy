/**
 * Lead 回合声明的宿主侧对账。
 *
 * Lead 每轮收口必须在 report_turn 里交两本账：assignments（本轮想让谁做什么）
 * 与 dispatched（本轮真正被宿主接受的派发），派不出去的在 pending 里写明在等什么。
 * 宿主用自己的派发凭据对账：任一侧差集非空即不一致。
 *
 * 取舍：不读 Lead 的散文。词表永远补不完；对账只认字段，误报只多问一轮，
 * 不会动派发本身，连续不一致才升级成卡。
 */
import type {
  OrcaDispatchClaimFailure,
  OrcaDispatchClaimNotice,
} from '../../shared/orcaDispatchReceipt';

/** 投递方式：direct = 本轮直接唤醒/立即执行，queued = 进队列等 Worker 自己取。 */
export type OrcaDispatchDelivery = 'direct' | 'queued';

/** 宿主自己的一个派发凭据：只由真实派发写下，不来自模型输出。 */
export interface LeadDispatchFact {
  workerId: string;
  workerLabel: string;
  dispatchId: string;
  turnGeneration: number;
  delivery: OrcaDispatchDelivery;
  queuedMessageId?: string;
  at: number;
}

/** Lead 声明的一条指派：想让哪个 Worker 做什么。 */
export interface LeadTurnAssignment {
  workerId: string;
  taskSummary: string;
}

/** Lead 声明的一条已完成派发。messageId 只在进队列时有值，可直接抄 dispatch 结果。 */
export interface LeadTurnDispatched {
  workerId: string;
  messageId?: string;
}

/** Lead 声明的一条未派出去的指派，以及它在等什么。 */
export interface LeadTurnPending {
  workerId: string;
  waitingFor: string;
}

/** 一轮的声明。turnGeneration 取提交时的轮次，用于和同一轮的凭据对齐。 */
export interface LeadTurnDeclaration {
  assignments: LeadTurnAssignment[];
  dispatched: LeadTurnDispatched[];
  pending: LeadTurnPending[];
  turnGeneration: number;
  at: number;
}

export type DeclarationVerdict =
  | { consistent: true }
  | {
      consistent: false;
      reason: OrcaDispatchClaimFailure;
      targets: string[];
      detail: string;
    };

/** wake = 首次不一致，叫它补交一轮；escalate = 补交后仍不一致，落卡。 */
export type DispatchClaimAction = 'wake' | 'escalate' | null;

interface LeadLedger {
  /** 最近一次收口看到的轮次；变小说明换了会话实例，账本整体作废。 */
  turnGeneration: number;
  /**
   * 本轮声明。只在「对账一致」后清空：不一致时保留，让下一次收口看到同一处矛盾，
   * 而不是逼模型重交一遍才升级。
   */
  declaration: LeadTurnDeclaration | null;
  facts: LeadDispatchFact[];
  /** 是否已就当前矛盾唤醒过；真实派发会清掉它，避免同一动作反复打扰。 */
  woke: boolean;
  /** 已升级成卡：同一矛盾不再重复落卡，等真实派发或一致声明解除。 */
  escalated: boolean;
  escalatedAt: number | null;
  /**
   * 这次不一致从哪一轮开始。唤醒会开新一轮，但凭据属于引发对账的那一轮，
   * 所以地板只降不升；一致后清空。
   */
  incidentFloor: number | null;
}

const ledgers = new Map<string, LeadLedger>();
/** 派发凭据只在本轮有用，留一天足够覆盖跨重启的收口。 */
const FACT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FACTS = 200;

function ledgerFor(leadSessionId: string): LeadLedger {
  let ledger = ledgers.get(leadSessionId);
  if (!ledger) {
    ledger = {
      turnGeneration: 0,
      declaration: null,
      facts: [],
      woke: false,
      escalated: false,
      escalatedAt: null,
      incidentFloor: null,
    };
    ledgers.set(leadSessionId, ledger);
  }
  return ledger;
}

/** 轮次回退 = 换了会话实例，旧账本不能继续用（否则上一实例的卡会压住新实例）。 */
function observeGeneration(ledger: LeadLedger, turnGeneration: number): void {
  if (turnGeneration >= ledger.turnGeneration) {
    ledger.turnGeneration = turnGeneration;
    return;
  }
  ledgersReset(ledger);
  ledger.turnGeneration = turnGeneration;
}

function ledgersReset(ledger: LeadLedger): void {
  ledger.declaration = null;
  ledger.facts = [];
  ledger.woke = false;
  ledger.escalated = false;
  ledger.escalatedAt = null;
  ledger.incidentFloor = null;
}

/** 记一条宿主派发凭据。真实派发重置抑制状态：同一个动作值得重新判定。 */
export function noteLeadDispatchFact(leadSessionId: string, fact: LeadDispatchFact): void {
  const ledger = ledgerFor(leadSessionId);
  observeGeneration(ledger, fact.turnGeneration);
  ledger.facts.push(fact);
  if (ledger.facts.length > MAX_FACTS) ledger.facts.splice(0, ledger.facts.length - MAX_FACTS);
  ledger.woke = false;
  ledger.escalated = false;
  ledger.escalatedAt = null;
}

/** 派发被撤回（恢复草稿）时扣掉凭据：它没真正交到 Worker 手上。 */
export function dropLeadDispatchFact(leadSessionId: string, dispatchId: string): void {
  const ledger = ledgers.get(leadSessionId);
  if (!ledger) return;
  ledger.facts = ledger.facts.filter((fact) => fact.dispatchId !== dispatchId);
}

/** 这次不一致的凭据地板：唤醒会开新一轮，地板只降不升，避免自己造出假不一致。 */
export function dispatchReconcileFloor(leadSessionId: string, turnGeneration: number): number {
  const ledger = ledgerFor(leadSessionId);
  if (ledger.incidentFloor !== null && ledger.incidentFloor <= turnGeneration) {
    return ledger.incidentFloor;
  }
  return turnGeneration;
}

/** 本轮（含同轮后续续跑）的派发凭据。窗口是生成号，不是墙钟。 */
export function dispatchFactsForTurn(
  leadSessionId: string,
  turnGeneration: number,
  sinceGeneration = turnGeneration,
): LeadDispatchFact[] {
  const ledger = ledgerFor(leadSessionId);
  observeGeneration(ledger, turnGeneration);
  const cutoff = Date.now() - FACT_RETENTION_MS;
  ledger.facts = ledger.facts.filter((fact) => fact.at >= cutoff);
  return ledger.facts.filter((fact) => fact.turnGeneration >= sinceGeneration);
}

/**
 * 记一轮的声明（report_turn 工具入口）。
 * 只登记不判定：对账发生在收口，凭据由宿主自己写下，两者不在同一时刻产生。
 */
export function noteLeadTurnDeclaration(
  leadSessionId: string,
  declaration: Omit<LeadTurnDeclaration, 'at' | 'pending'> & { pending?: LeadTurnPending[] },
): void {
  const ledger = ledgerFor(leadSessionId);
  ledger.declaration = {
    assignments: declaration.assignments,
    dispatched: declaration.dispatched,
    pending: declaration.pending ?? [],
    turnGeneration: declaration.turnGeneration,
    at: Date.now(),
  };
}

/**
 * 对账：声明里的每一条派发都必须有宿主凭据，宿主的每一条凭据都必须写进声明。
 * 声明了但故意没派的，必须出现在 pending 里并写明在等什么，否则视为「光说不做」。
 * 一致后清空声明：下一轮必须重新交，不允许上一轮的声明替这一轮背书。
 */
export function reconcileLeadTurnDeclaration(
  leadSessionId: string,
  facts: readonly LeadDispatchFact[],
): DeclarationVerdict {
  const ledger = ledgerFor(leadSessionId);
  const declaration = ledger.declaration;

  if (!declaration) {
    // 没有派发就没有可对账的对象：普通问答不该被逼着交声明。
    if (facts.length === 0) return { consistent: true };
    return {
      consistent: false,
      reason: 'no-declaration',
      targets: facts.map((fact) => fact.workerLabel),
      detail: facts.map((fact) => fact.workerLabel).join(', '),
    };
  }

  const factsByWorker = new Map<string, LeadDispatchFact[]>();
  for (const fact of facts) {
    const bucket = factsByWorker.get(fact.workerId);
    if (bucket) bucket.push(fact);
    else factsByWorker.set(fact.workerId, [fact]);
  }
  const labelOf = (workerId: string): string =>
    factsByWorker.get(workerId)?.[0]?.workerLabel ??
    declaration.assignments.find((entry) => entry.workerId === workerId)?.workerId ??
    workerId;

  for (const entry of declaration.dispatched) {
    // 同一个 Worker 可以连着收多条（q1、q2）：按这一轮它全部凭据匹配，不能只看最后一条。
    const bucket = factsByWorker.get(entry.workerId);
    if (!bucket || bucket.length === 0) {
      return {
        consistent: false,
        reason: 'declared-not-dispatched',
        targets: [labelOf(entry.workerId)],
        detail: labelOf(entry.workerId),
      };
    }
    const matched =
      !entry.messageId ||
      bucket.some(
        (fact) => fact.dispatchId === entry.messageId || fact.queuedMessageId === entry.messageId,
      );
    if (!matched) {
      return {
        consistent: false,
        reason: 'unknown-message-id',
        targets: [bucket[0]!.workerLabel],
        detail: entry.messageId ?? '',
      };
    }
  }

  const declaredWorkers = new Set(declaration.dispatched.map((entry) => entry.workerId));
  for (const assignment of declaration.assignments) {
    if (declaredWorkers.has(assignment.workerId)) continue;
    if (declaration.pending.some((entry) => entry.workerId === assignment.workerId)) continue;
    return {
      consistent: false,
      reason: 'declared-not-dispatched',
      targets: [labelOf(assignment.workerId)],
      detail: labelOf(assignment.workerId),
    };
  }

  for (const fact of facts) {
    if (declaredWorkers.has(fact.workerId)) continue;
    return {
      consistent: false,
      reason: 'dispatched-not-declared',
      targets: [fact.workerLabel],
      detail: fact.workerLabel,
    };
  }

  ledger.declaration = null;
  return { consistent: true };
}

/** 一句人话，用作唤醒文本里的原因行。 */
export function describeDeclarationVerdict(verdict: {
  reason: OrcaDispatchClaimFailure;
  detail: string;
}): string {
  switch (verdict.reason) {
    case 'no-declaration':
      return 'You dispatched this turn but submitted no report_turn declaration';
    case 'declared-not-dispatched':
      return `You declared a dispatch to ${verdict.detail} that the host never accepted`;
    case 'dispatched-not-declared':
      return `The host dispatched to ${verdict.detail} this turn, but your declaration leaves it out`;
    case 'unknown-message-id':
      return `The queued message id ${verdict.detail} matches no dispatch of this turn`;
  }
}

/** 升级卡的载荷。只带字段，不带原话：卡片正文由渲染层按语言拼。 */
export function toDispatchClaimNotice(verdict: {
  reason: OrcaDispatchClaimFailure;
  targets: string[];
  detail: string;
}): OrcaDispatchClaimNotice {
  return {
    version: 1,
    state: 'unverified',
    targets: verdict.targets,
    reason: verdict.reason,
    detail: verdict.detail,
    at: Date.now(),
  };
}

/** 一致就清账；不一致先唤醒一次，仍不一致才升级。返回本轮该做的动作。 */
export function settleDispatchClaimIncident(
  leadSessionId: string,
  consistent: boolean,
  turnGeneration = 0,
): DispatchClaimAction {
  const ledger = ledgerFor(leadSessionId);

  if (consistent) {
    ledger.woke = false;
    ledger.escalated = false;
    ledger.escalatedAt = null;
    ledger.incidentFloor = null;
    return null;
  }

  // 已经落过卡：同一处矛盾不再唤醒、不再重复落卡，等真实派发或一致声明解除。
  if (ledger.escalated) return null;

  ledger.incidentFloor = Math.min(ledger.incidentFloor ?? turnGeneration, turnGeneration);

  if (ledger.woke) {
    ledger.escalated = true;
    ledger.escalatedAt = Date.now();
    return 'escalate';
  }

  ledger.woke = true;
  return 'wake';
}

/** 测试与会话销毁用：清掉一个 Lead 的账本。 */
export function resetDispatchClaimState(leadSessionId?: string): void {
  if (leadSessionId) ledgers.delete(leadSessionId);
  else ledgers.clear();
}
