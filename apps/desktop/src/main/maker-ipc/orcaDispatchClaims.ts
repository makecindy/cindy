/**
 * 宿主侧的派发凭据账，以及「引用不存在的凭据」的核对。
 *
 * 派发由宿主自己记账：send_to_worker 被接受的那一刻就写下凭据，只来自真实动作。
 * Lead 的回复里如果引用了宿主签发的编号或派发结果值，而账本里没有对应记录，
 * 那就是一个纯字段矛盾——不需要读语义，也不需要模型判定。
 *
 * 取舍：只认协议令牌（`wake_kind=`、`queued_message_id:` 一类），不认措辞。
 * 词表永远补不完；核对只比字段，误报的代价是多问一轮，不会动派发本身。
 */

/** 投递方式：direct = 本轮直接唤醒/立即执行，queued = 进队列等 Worker 自己取。 */
export type OrcaDispatchDelivery = 'direct' | 'queued';

/** 宿主自己的一个派发凭据：只由真实派发写下，不来自模型输出。 */
export interface LeadDispatchFact {
  workerId: string;
  workerLabel: string;
  dispatchId: string;
  turnSeq: number;
  delivery: OrcaDispatchDelivery;
  /**
   * 凭据落地时 Lead 已经收口过几次。
   *
   * 回合归属靠它，不靠代次：代次由事件推出来，Stop hook 可能在本轮事件投递前触发，
   * 那时用代次比较会把本轮的派发漏掉，把一句真话判成假话。
   */
  settlesAtAccept?: number;
  queuedMessageId?: string;
  at: number;
  /**
   * 写下这条凭据的会话实例。投递落地可能晚于换实例，只靠轮次分不开「新实例第 1 轮」
   * 与「旧实例迟到的第 1 轮」，所以凭据自带实例身份。
   */
  instanceToken?: number;
}

const instanceTokens = new WeakMap<object, number>();
let nextInstanceToken = 1;

/** 会话实例的稳定标记：同一个运行时对象始终得到同一个号。 */
export function sessionInstanceToken(session: object): number {
  let token = instanceTokens.get(session);
  if (token === undefined) {
    token = nextInstanceToken++;
    instanceTokens.set(session, token);
  }
  return token;
}

interface LeadLedger {
  /** 最近一次看到的回合号；变小说明换了会话实例，账本整体作废。 */
  turnSeq: number;
  facts: LeadDispatchFact[];
  /** 已经就哪一轮的不实凭据提醒过。同一轮只提醒一次，避免空转。 */
  remindedSeq: number | null;
  /** 账本属于哪个会话实例。换实例后旧账整体作废，新实例从第一条凭据重新记。 */
  instanceToken?: number;
}

const ledgers = new Map<string, LeadLedger>();
/** 派发凭据只在本轮有用，留一天足够覆盖跨重启的收口。 */
const FACT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FACTS = 200;

function ledgerFor(leadSessionId: string): LeadLedger {
  let ledger = ledgers.get(leadSessionId);
  if (!ledger) {
    ledger = {
      turnSeq: 0,
      facts: [],
      remindedSeq: null,
    };
    ledgers.set(leadSessionId, ledger);
  }
  return ledger;
}

/** 回合号回退 = 换了会话实例，只作废旧实例的提醒额度，凭据留着。 */
function observeTurn(ledger: LeadLedger, turnSeq: number): void {
  // 轮次未知（Stop hook 可能在本轮事件投递前触发）：既不算前进也不算回退。
  if (turnSeq <= 0) return;
  if (turnSeq >= ledger.turnSeq) {
    ledger.turnSeq = turnSeq;
    return;
  }
  // 回退通常只是实例重建，凭据还在 Lead 自己的上下文里；跟着清掉的话，
  // 它引用一个真实存在的编号就会被判成无中生有。只清额度。
  ledger.remindedSeq = null;
  ledger.turnSeq = turnSeq;
}

function ledgersReset(ledger: LeadLedger): void {
  ledger.facts = [];
  ledger.remindedSeq = null;
  ledger.instanceToken = undefined;
}

/** 记一条宿主派发凭据。 */
export function noteLeadDispatchFact(leadSessionId: string, fact: LeadDispatchFact): void {
  const ledger = ledgerFor(leadSessionId);
  if (
    fact.instanceToken !== undefined &&
    ledger.instanceToken !== undefined &&
    fact.instanceToken !== ledger.instanceToken
  ) {
    // 换了会话实例：旧账本作废，并把轮次降到新实例这一轮，
    // 否则随后的收口按「轮次回退」再清一次，会把这条新凭据一起抹掉。
    ledgersReset(ledger);
    ledger.turnSeq = fact.turnSeq;
  }
  if (fact.instanceToken !== undefined) ledger.instanceToken = fact.instanceToken;
  // 测试与恢复路径可能不带时间戳：缺省的按现在算，否则会被保留窗口直接滤掉。
  ledger.facts.push({ ...fact, at: fact.at ?? Date.now() });
  if (ledger.facts.length > MAX_FACTS) ledger.facts.splice(0, ledger.facts.length - MAX_FACTS);
  // 凭据不参与轮次观察：投递落地可能晚于它所属的轮次收口，迟到的旧凭据既不能抹掉
  // 当前账本，也不能替已经提醒过的那一轮作废记录。
}

/** 派发被撤回（恢复草稿）时扣掉凭据：它没真正交到 Worker 手上。 */
export function dropLeadDispatchFact(leadSessionId: string, dispatchId: string): void {
  const ledger = ledgers.get(leadSessionId);
  if (!ledger) return;
  ledger.facts = ledger.facts.filter((fact) => fact.dispatchId !== dispatchId);
}

/** 账本里的全部派发凭据。窗口不是墙钟也不是单轮：判断「派过没有」要看整本账。 */
export function dispatchFactsForTurn(
  leadSessionId: string,
  turnSeq: number,
): LeadDispatchFact[] {
  const ledger = ledgerFor(leadSessionId);
  observeTurn(ledger, turnSeq);
  const cutoff = Date.now() - FACT_RETENTION_MS;
  ledger.facts = ledger.facts.filter((fact) => fact.at >= cutoff);
  return [...ledger.facts];
}

/** 回复里引用了一个宿主没有记录的派发。 */
export interface UnbackedDispatchClaim {
  /** wake-kind = 引用了派发结果值；id = 引用了宿主签发的编号。 */
  kind: 'wake-kind' | 'id';
  /** 回复里出现的那个值。 */
  token: string;
  /** 回复里使用的标签，用于回话时指出是哪一处。 */
  label: string;
}

/** 派发结果值闭集：这些值只可能来自工具返回。 */
const WAKE_KIND_PATTERN = /\bwake_kind\s*[=:]\s*`?([a-z][a-z-]{2,20})`?/i;

/**
 * 宿主会发出的 wake_kind 值（`send_to_worker` / `send_to_session` 的返回闭集）。
 *
 * 不在这个集合里的值不可能来自任何一次派发——账本里有多少条都一样。
 */
const ISSUED_WAKE_KINDS = new Set(['resumed', 'already-active', 'queued', 'created']);

/**
 * 找出回复里「引用了宿主不可能发出的派发结果值」的第一处。
 *
 * 只判闭集违规：`wake_kind=<值>` 不在协议里，就不可能是任何一次派发的结果，
 * 与账本里存了几条、期间是否重启过、事件是否已调换过都无关。
 *
 * 编号（`dispatch_id` / `queued_message_id` / `message_id`）一律不核对。账本只在内存里，
 * 有 24 小时与 200 条上限，重启或过期之后一条真实编号与编造的完全一样。查不到不等于编造，
 * 能证明的只有「这个值协议里根本没有」。
 */
export function findUnbackedDispatchClaim(text: string): UnbackedDispatchClaim | null {
  const wakeKind = text.match(WAKE_KIND_PATTERN);
  if (!wakeKind) return null;
  const token = wakeKind[1]!.toLowerCase();
  if (ISSUED_WAKE_KINDS.has(token)) return null;
  return { kind: 'wake-kind', token, label: 'wake_kind' };
}

/**
 * 这个回合还能不能提醒。额度只按回合：一轮一次。
 *
 * 额度只认回合号：一轮最多提醒一次，下一轮重新判。跨回合静默（无论是按会话还是按
 * 声称身份）都会让「反复坚持同一句假话」免费过关。真话靠判定器看到账本里的派发行
 * 放行，不靠压制提醒次数。
 */
export function consumeDispatchClaimReminder(
  leadSessionId: string,
  turnSeq: number,
): boolean {
  const ledger = ledgerFor(leadSessionId);
  observeTurn(ledger, turnSeq);
  // 轮次未知时不能当作新的一轮：那会把同一句声称每轮纠一遍。
  if (turnSeq <= 0) return false;
  if (ledger.remindedSeq === turnSeq) return false;
  ledger.remindedSeq = turnSeq;
  return true;
}

/** 测试与会话销毁用：清掉一个 Lead 的账本。 */
export function resetDispatchClaimState(leadSessionId?: string): void {
  if (leadSessionId) ledgers.delete(leadSessionId);
  else ledgers.clear();
}
