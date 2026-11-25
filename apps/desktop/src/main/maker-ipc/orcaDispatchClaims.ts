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
  turnGeneration: number;
  delivery: OrcaDispatchDelivery;
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
  /** 最近一次收口看到的轮次；变小说明换了会话实例，账本整体作废。 */
  turnGeneration: number;
  facts: LeadDispatchFact[];
  /** 已经就哪一轮的不实凭据提醒过。同一轮只提醒一次，避免空转。 */
  remindedGeneration: number | null;
  /** 已经提醒过的声称身份（假编号 / 被点名的 worker 批），避免一句复述每轮被纠一次。 */
  remindedClaims: Map<string, number>;
  /** 账本属于哪个会话实例。换实例后旧账整体作废，新实例从第一条凭据重新记。 */
  instanceToken?: number;
}

const ledgers = new Map<string, LeadLedger>();
/** 派发凭据只在本轮有用，留一天足够覆盖跨重启的收口。 */
const FACT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FACTS = 200;
/** 同一个声称只纠正一次的时间窗：复述同一件事不算新问题，换一件事才重新判。 */
const CLAIM_REMINDER_RETENTION_MS = 30 * 60 * 1000;
const MAX_REMINDED_CLAIMS = 32;

function ledgerFor(leadSessionId: string): LeadLedger {
  let ledger = ledgers.get(leadSessionId);
  if (!ledger) {
    ledger = {
      turnGeneration: 0,
      facts: [],
      remindedGeneration: null,
      remindedClaims: new Map(),
    };
    ledgers.set(leadSessionId, ledger);
  }
  return ledger;
}

/** 轮次回退 = 换了会话实例，旧账本不能继续用（否则上一实例的提醒状态会压住新实例）。 */
function observeGeneration(ledger: LeadLedger, turnGeneration: number): void {
  if (turnGeneration >= ledger.turnGeneration) {
    ledger.turnGeneration = turnGeneration;
    return;
  }
  ledgersReset(ledger);
  ledger.turnGeneration = turnGeneration;
}

function ledgersReset(ledger: LeadLedger): void {
  ledger.facts = [];
  ledger.remindedGeneration = null;
  ledger.remindedClaims.clear();
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
    ledger.turnGeneration = fact.turnGeneration;
  }
  if (fact.instanceToken !== undefined) ledger.instanceToken = fact.instanceToken;
  ledger.facts.push(fact);
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
  turnGeneration: number,
): LeadDispatchFact[] {
  const ledger = ledgerFor(leadSessionId);
  observeGeneration(ledger, turnGeneration);
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
/** 宿主签发编号的协议标签：只认这几个标签，不猜裸 id。 */
const LABELED_ID_ALL_PATTERN =
  /\b(queued_message_id|message_id|dispatch_id)\s*[=:]\s*`?([A-Za-z0-9_-]{8,64})`?/gi;

/**
 * 找出回复里「引用了宿主没有的派发凭据」的第一处。
 *
 * - `wake_kind=<值>` 断言了一次派发结果，而账本里一条凭据都没有 → 无中生有。
 * - `queued_message_id: <编号>` 等标签后的编号必须命中账本里某个派发/排队编号。
 *
 * 账本非空时 `wake_kind` 不判：那时分不清它复述的是哪一次派发，误判代价高。
 */
export function findUnbackedDispatchClaim(
  leadSessionId: string,
  text: string,
): UnbackedDispatchClaim | null {
  const ledger = ledgers.get(leadSessionId);
  const facts = ledger ? ledger.facts : [];

  const wakeKind = text.match(WAKE_KIND_PATTERN);
  if (wakeKind && facts.length === 0) {
    return { kind: 'wake-kind', token: wakeKind[1]!, label: 'wake_kind' };
  }

  // 一条回复里可能列出多个编号：逐个核对，只要有一个查不到就拦住。
  // 只看第一个的话，前面放一个真编号就能把后面的假编号遮住。
  for (const labeledId of text.matchAll(LABELED_ID_ALL_PATTERN)) {
    const label = labeledId[1]!;
    const token = labeledId[2]!;
    const known = facts.some(
      (fact) => fact.dispatchId === token || fact.queuedMessageId === token,
    );
    if (!known) return { kind: 'id', token, label };
  }

  return null;
}

/**
 * 额度分两层：同一轮一次；同一个声称在窗口内一次。
 *
 * 同一轮只提醒一次，避免模型坚持不改时来回空转。同一个声称（同一条假编号、
 * 同一批被点名的 worker）在窗口内也只提醒一次——改成「每轮都提醒」会让一句
 * 复述在接下来每一轮都被纠正一遍，那正是「一单纠正四次」的形态。
 *
 * claimKey 省略时只做按轮去重：调用点还没算出身份时不能凭轮次冒充身份。
 */
export function consumeDispatchClaimReminder(
  leadSessionId: string,
  turnGeneration: number,
  claimKey?: string,
): boolean {
  const ledger = ledgerFor(leadSessionId);
  observeGeneration(ledger, turnGeneration);
  if (ledger.remindedGeneration === turnGeneration) return false;
  if (claimKey) {
    const now = Date.now();
    for (const [key, at] of ledger.remindedClaims) {
      if (now - at > CLAIM_REMINDER_RETENTION_MS) ledger.remindedClaims.delete(key);
    }
    if (ledger.remindedClaims.has(claimKey)) return false;
    if (ledger.remindedClaims.size >= MAX_REMINDED_CLAIMS) {
      const oldest = ledger.remindedClaims.keys().next().value;
      if (oldest !== undefined) ledger.remindedClaims.delete(oldest);
    }
    ledger.remindedClaims.set(claimKey, now);
  }
  ledger.remindedGeneration = turnGeneration;
  return true;
}

/** 测试与会话销毁用：清掉一个 Lead 的账本。 */
export function resetDispatchClaimState(leadSessionId?: string): void {
  if (leadSessionId) ledgers.delete(leadSessionId);
  else ledgers.clear();
}
