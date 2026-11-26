import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { requestUtilityTextWithinTimeout } from '../utility-model/utilityTextTimeout.js';
import { createLogger } from '../logger.js';
import {
  consumeDispatchClaimReminder,
  dispatchFactsForTurn,
  findUnbackedDispatchClaim,
  resetDispatchClaimState,
  type UnbackedDispatchClaim,
} from './orcaDispatchClaims.js';

const log = createLogger('orca-turn-gate');

/**
 * 判定器预算。取 10 秒:这是「收口最多等多久」的产品阈值,不是模型平均延迟。
 * 超时一律放行——卡住会话的代价高于放过一句假话。
 */
const JUDGE_TIMEOUT_MS = 10_000;
const JUDGE_MAX_TOKENS = 8;
/**
 * 判官必须看到**整段**回复：要么全文，要么不判。
 *
 * 这里不能取窗口，也不能切块。取末尾 2000 字押「结论在末尾」；取首尾两段押
 * 「声称在两端」；切块押「切点不落在句子中间」——三种都是赌位置，而声称可以
 * 出现在任何地方（先跑测试、中途派单、再收尾一大段）。切成两半的「没有派单」
 * 还可能被读成声称，把真话纠一遍。所以判据只有一条：送全文。
 *
 * 超过上限时不抽样、不推断，按不可用放行并在日志里留下长度——让「没读」是
 * 可见的事实，而不是悄悄变成 quiet。
 */
const JUDGE_TEXT_LIMIT = 48_000;
const MAX_TRACKED_ENTRIES = 512;
const MAX_PRIOR_DISPATCH_LINES = 8;

/** 每个会话当前回合号：Stop hook 只拿得到 sessionId，没有事件里的代次。 */
const currentGeneration = new Map<string, number>();
/** 每个会话最后一次看到的回合号，用来发现「换了实例、代次从头数」。 */
const lastGeneration = new Map<string, number>();
/** 已经判过的收口文本：一个会话只能有一个否决点，两个出口不能各判一次。 */
const handledBySession = new Map<string, Set<string>>();
/** 判定结果缓存：同一回合同一段文本只问一次模型。 */
const judgedByTurn = new Map<string, 'claim' | 'quiet'>();
/** Lead 收口计数与最后一次收口文本：欠账按「过了几个回合」计时。 */
const leadSettles = new Map<string, number>();
const lastSettleFingerprint = new Map<string, string>();

function trimTracked(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/** 收口文本的指纹：同一段结论被两个出口各送一次时，只算一次。 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}.${hash.toString(16)}`;
}

/** 每个事件都调一次：记住当前回合号，Stop hook 才能按代次取到凭据账。 */
export function noteTurnEvent(sessionId: string, generation: number): void {
  const previous = lastGeneration.get(sessionId);
  // 代次回退＝会话实例重建：旧实例记的「已判」与计数都不能继承，
  // 否则新实例的第 3 回合会被当成判过而静默放过。
  if (previous !== undefined && generation < previous) forgetTurnGate(sessionId);
  lastGeneration.set(sessionId, generation);
  currentGeneration.set(sessionId, generation);
}

export function currentTurnGeneration(sessionId: string): number | undefined {
  return currentGeneration.get(sessionId);
}

/**
 * 标记这段收口文本已判过（结论是拦还是放都算）。
 *
 * 身份用文本而不是代次：Stop hook 可能在本轮事件到达前触发，那时宿主手里的代次
 * 还停在上一轮；按代次记会让两个出口各判一次，也会把「把握到本轮的派发」漏掉。
 */
export function markTurnGateHandled(sessionId: string, textFingerprint: string): void {
  const seen = handledBySession.get(sessionId) ?? new Set<string>();
  seen.add(textFingerprint);
  handledBySession.set(sessionId, seen);
  while (seen.size > MAX_TRACKED_ENTRIES) {
    const oldest = seen.values().next();
    if (oldest.done) return;
    seen.delete(oldest.value);
  }
  trimTracked(handledBySession, MAX_TRACKED_ENTRIES);
}

export function turnGateHandled(sessionId: string, textFingerprint: string): boolean {
  return handledBySession.get(sessionId)?.has(textFingerprint) ?? false;
}

/**
 * 记一次 Lead 收口，返回已收口的次数。
 *
 * 同一段收口文本被数两次，「连续两个回合没回答」就变成一个回合——引擎 Stop hook
 * 与宿主 settle 都会调这里。
 */
export function noteLeadSettle(sessionId: string, textFingerprint: string): number {
  if (lastSettleFingerprint.get(sessionId) === textFingerprint) {
    return leadSettleCount(sessionId);
  }
  const next = leadSettleCount(sessionId) + 1;
  leadSettles.set(sessionId, next);
  lastSettleFingerprint.set(sessionId, textFingerprint);
  return next;
}

export function leadSettleCount(sessionId: string): number {
  return leadSettles.get(sessionId) ?? 0;
}

/**
 * Worker 的欠账：它报了 waiting 并留了一个问题，宿主在等 Lead 处理。
 *
 * 依赖 #9818 的 `send_to_lead` 结构化参数 `report.state` / `report.question`。
 * 该分支尚未合入时字段缺席，这里静默不记录（本层失效，其余闸门照常）。
 */
export interface WorkerArrears {
  leadSessionId: string;
  workerId: string;
  workerLabel: string;
  question: string;
  settlesAtReport: number;
  nudged: boolean;
}

const arrearsByWorker = new Map<string, WorkerArrears>();
/** 欠账满两个 Lead 回合还没被处理，就该说话。一轮留给 Lead 正常向用户澄清。 */
const ARREARS_SETTLE_THRESHOLD = 2;
const MAX_TRACKED_ARREARS = 256;

const arrearsKey = (leadSessionId: string, workerId: string): string =>
  `${leadSessionId}:${workerId}`;

/** 记一条欠账；worker 报了非 waiting 状态就说明它不再等，撤销。 */
export function noteWorkerReportArrears(input: {
  leadSessionId: string;
  workerId: string;
  workerLabel: string;
  state: string | undefined;
  question: string | undefined;
}): void {
  const key = arrearsKey(input.leadSessionId, input.workerId);
  const question = input.question?.trim() ?? '';
  if (input.state !== 'waiting' || !question) {
    arrearsByWorker.delete(key);
    return;
  }
  arrearsByWorker.set(key, {
    leadSessionId: input.leadSessionId,
    workerId: input.workerId,
    workerLabel: input.workerLabel,
    question,
    settlesAtReport: leadSettleCount(input.leadSessionId),
    nudged: false,
  });
  trimTracked(arrearsByWorker, MAX_TRACKED_ARREARS);
}

/** Lead 真的给了它活（派发被接受），欠账就算处理过。 */
export function clearWorkerArrears(leadSessionId: string, workerId: string): void {
  arrearsByWorker.delete(arrearsKey(leadSessionId, workerId));
}

/** 到期待叫醒的欠账：跨够回合数且还没提醒过。 */
export function arrearsDue(leadSessionId: string): WorkerArrears[] {
  const settled = leadSettleCount(leadSessionId);
  return [...arrearsByWorker.values()].filter(
    (entry) =>
      entry.leadSessionId === leadSessionId &&
      !entry.nudged &&
      settled - entry.settlesAtReport >= ARREARS_SETTLE_THRESHOLD,
  );
}

/** 一笔欠账只叫醒一次；它继续等下去也不重复刷。 */
export function markArrearsNudged(leadSessionId: string, workerId: string): void {
  const entry = arrearsByWorker.get(arrearsKey(leadSessionId, workerId));
  if (entry) entry.nudged = true;
}

export function arrearsCount(leadSessionId: string): number {
  return [...arrearsByWorker.values()].filter((entry) => entry.leadSessionId === leadSessionId)
    .length;
}

/** 会话结束或重建时清账,避免旧代次的计数被新一轮读到。 */
export function forgetTurnGate(sessionId?: string): void {
  // 会话结束了，它那本派发账也一起丢掉：账本永不清会被会话键一直占着内存。
  resetDispatchClaimState(sessionId);
  if (!sessionId) {
    currentGeneration.clear();
    lastGeneration.clear();
    handledBySession.clear();
    judgedByTurn.clear();
    leadSettles.clear();
    lastSettleFingerprint.clear();
    arrearsByWorker.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of judgedByTurn.keys()) if (key.startsWith(prefix)) judgedByTurn.delete(key);
  for (const key of arrearsByWorker.keys()) if (key.startsWith(prefix)) arrearsByWorker.delete(key);
  currentGeneration.delete(sessionId);
  lastGeneration.delete(sessionId);
  handledBySession.delete(sessionId);
  leadSettles.delete(sessionId);
  lastSettleFingerprint.delete(sessionId);
}

function judgePrompt(workerLabels: string[] | undefined, priorDispatches: string[], finalText: string): string {
  const workers = workerLabels?.length ? workerLabels.join(', ') : '(none registered)';
  const prior = priorDispatches.length
    ? priorDispatches.map((line) => (line.startsWith('  ') ? line : `  ${line}`)).join('\n')
    : '  (none)';
  return [
    'One assistant turn ended with no dispatch accepted in that turn.',
    `Workers that could receive work: ${workers}.`,
    'Handoffs the host already accepted earlier in this session, most recent first:',
    prior,
    'Decide whether this closing text asserts that work was already handed to a worker.',
    'Answer "claim" only for an explicit assertion that work was given, dispatched or queued to a worker and that this handoff is not one of the recorded handoffs above.',
    'Text that reports or refers back to a recorded handoff (answering a question about it, or restating it) is a restatement, not a claim.',
    'Denials such as "this turn dispatched nothing" are not claims.',
    'Answer "quiet" for summaries, plans, questions, status of user-facing work, restatements without a named worker, or anything that does not assert that a new handoff already happened.',
    'When unsure, answer "quiet".',
    'Reply with exactly one word: claim or quiet.',
    '',
    'Turn text:',
    finalText,
  ].join('\n');
}

export type DispatchClaimVerdict = 'claim' | 'quiet' | 'unavailable';

/**
 * 只剩「纯口语声称已派」这一格需要语义判定:凭据已经由账本比对处理。
 * 判定失败、超时、无法解析一律返回 unavailable 并放行。
 */
export async function judgeDispatchClaim(params: {
  leadSessionId: string;
  turnGeneration: number;
  finalText: string;
  workers?: Array<{ label: string; status: string }>;
  workerLabels?: string[];
  priorDispatches?: string[];
}): Promise<DispatchClaimVerdict> {
  const text = params.finalText.trim();
  if (!text) return 'quiet';

  const key = `${params.leadSessionId}:${params.turnGeneration}:${fingerprint(text)}`;
  const cached = judgedByTurn.get(key);
  if (cached) return cached;

  if (text.length > JUDGE_TEXT_LIMIT) {
    // 宁可放过，不拿半段文本下结论：抽样恰好漏掉声称比不判更坏。
    // 不写缓存：下一出口/下一回合还能再试。
    log.info('orca turn gate skipped an oversized turn', { chars: text.length });
    return 'unavailable';
  }

  const verdict = await judgeOneText({
    workerLabels: params.workerLabels ?? params.workers?.map((worker) => worker.label),
    priorDispatches: params.priorDispatches,
    text,
    timeoutMs: JUDGE_TIMEOUT_MS,
  });

  // 只缓存真结论：把「没读成」缓存成 quiet 等于把一次超时变成一个回合永久免检。
  if (verdict !== 'unavailable') {
    judgedByTurn.set(key, verdict);
    trimTracked(judgedByTurn, MAX_TRACKED_ENTRIES);
  }
  return verdict;
}

/** 判一次：送整段文本，一次调用出结论。 */
async function judgeOneText(params: {
  workerLabels?: string[];
  priorDispatches?: string[];
  text: string;
  timeoutMs: number;
}): Promise<DispatchClaimVerdict> {
  try {
    // 动态取 maker：静态 import 会把整棵 maker-host 模块图拉进任何间接引用
    // 本模块的测试里（它们的 orcaTeamStore mock 不全），collect 阶段就会失败。
    const { getMaker } = await import('../maker-host/index.js');
    const result = await requestUtilityTextWithinTimeout(
      (signal) =>
        requestUtilityText(
          getMaker(),
          judgePrompt(params.workerLabels, params.priorDispatches ?? [], params.text),
          {
            source: 'orca-turn-gate',
            maxTokens: JUDGE_MAX_TOKENS,
            disableReasoning: true,
            signal,
          },
        ),
      params.timeoutMs,
      undefined,
      () => ({ ok: false, reason: 'timeout', attempts: [] }),
    );
    // 只接受单值回答：`no claim`、`claim or quiet` 这类都不是结论，按不可用放行。
    if (!result.ok) return 'unavailable';
    const answer = result.text.trim().replace(/^[`'"*]+|[`'"*.]+$/g, '').toLowerCase();
    if (answer === 'claim') return 'claim';
    if (answer === 'quiet') return 'quiet';
    return 'unavailable';
  } catch (error) {
    log.info('orca turn gate judge unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unavailable';
  }
}

/** 拦下收口时回灌给模型的说明。 */
function unbackedClaimReason(claim: UnbackedDispatchClaim): string {
  return [
    '[Orca host] You cited a dispatch result value the protocol never issues.',
    `You wrote \`${claim.label}=${claim.token}\`; no dispatch returns that value.`,
    'Either dispatch now with send_to_worker, or say plainly that nothing was dispatched.',
  ].join('\n');
}

/**
 * 把账本里已成立的派发写成判官能读的几行：判官靠它把「复述」与「新声称」分开。
 *
 * 少了这段，判官只有「本回合有没有派发」这一个量，「我上一轮派过了」与「我刚派了」
 * 在它眼里一模一样，真话会被当成假话纠正。
 */
/**
 * 文本里是否点名了这个 Worker。
 *
 * 用词边界而不是子串：Worker 叫 `research` 时，`researcher` 不该算出点名——
 * 名字参与去重键，子串命中会把两个不同的声称并成一个，桥掉后面的纠正。
 */
function mentionsLabel(text: string, label: string): boolean {
  const lowered = text.toLowerCase();
  const needle = label.toLowerCase();
  const wordChar = /[a-z0-9_]/;
  let at = lowered.indexOf(needle);
  while (at !== -1) {
    const before = lowered[at - 1] ?? '';
    const after = lowered[at + needle.length] ?? '';
    if (!wordChar.test(before) && !wordChar.test(after)) return true;
    at = lowered.indexOf(needle, at + 1);
  }
  return false;
}

function describePriorDispatches(input: {
  leadSessionId: string;
  turnGeneration: number;
  workers: Array<{ label: string; status: string }>;
  settleIndex: number;
  text: string;
}): string[] {
  const statuses = new Map(input.workers.map((worker) => [worker.label, worker.status]));
  const facts = dispatchFactsForTurn(input.leadSessionId, input.turnGeneration).sort(
    (a, b) => b.at - a.at,
  );
  // 先给这段文本点到的 Worker：复述的往往就是最近提到的那个，被裁掉的恰好是
  // 「我上一轮派给 research 了」这句真话的依据。剩下的按时间补足行数。
  const cited = facts.filter((fact) => mentionsLabel(input.text, fact.workerLabel));
  const rest = facts.filter((fact) => !cited.includes(fact));
  return [...cited, ...rest]
    .slice(0, MAX_PRIOR_DISPATCH_LINES)
    .map((fact) => {
      const closesAgo =
        fact.settlesAtAccept === undefined ? 1 : input.settleIndex - fact.settlesAtAccept;
      const when = closesAgo <= 0 ? 'this turn' : `${closesAgo} turn(s) earlier`;
      const status = statuses.get(fact.workerLabel) ?? 'unknown';
      return `  ${fact.workerLabel} — accepted ${when}, delivery ${fact.delivery}, worker status ${status}`;
    });
}

const JUDGED_CLAIM_REASON = [
  '[Orca host] This turn dispatched nothing, and no worker received work from you.',
  'You wrote that work was already handed to a worker. Either dispatch now with send_to_worker, or say plainly that nothing was dispatched.',
].join('\n');

/**
 * 「派/安排/交给」这类动词的粗筛：命中才值得付一次模型调用。
 *
 * 绝大多数收口是普通汇报，没有这类词就直接放行；这不是判据，只是省钱。
 */
const DISPATCH_WORD_PATTERN =
  /派|安排|交给|交办|转交|让.{0,8}(做|跑|改|查)|已发出|hand(?:ed|s)?\s+(?:it\s+|this\s+)?off|dispatch|delegat|assign|sent to|queued to/i;

/**
 * 收口闸门的唯一判定入口。返回 reason 表示不允许收口（引擎 Stop hook 会据此 block）；
 * 返回 undefined 表示放行。
 *
 * 两个出口共用这里的判定、上限与文案：
 * - Claude Code：注册在引擎自己的 Stop 里，和用户 hook 同场评估、一次续跑；
 * - Codex / pi：宿主 settle 里调（Codex 的 hooks 在 Cindy 下是关闭的，不存在叠加）。
 */
export async function evaluateTurnGate(input: {
  leadSessionId: string;
  turnGeneration: number;
  finalText: string | undefined;
  workers: Array<{ label: string; status: string }>;
}): Promise<string | undefined> {
  const text = input.finalText?.trim() ?? '';
  if (!text) return undefined;

  const textFingerprint = fingerprint(text);
  // 一个会话一个否决点：引擎侧判过这段收口，宿主 settle 不再判第二遍。
  if (turnGateHandled(input.leadSessionId, textFingerprint)) return undefined;

  const settleIndex = noteLeadSettle(input.leadSessionId, textFingerprint);

  // L2 欠账：有 Worker 报了 waiting 并留了问题，之后连续两个 Lead 回合没人理它。
  // 判据是状态（谁在等、等了几轮），不是文本；沉默的没做同样命中。
  const due = arrearsDue(input.leadSessionId);
  if (due.length > 0) {
    const arrear = due[0]!;
    markArrearsNudged(arrear.leadSessionId, arrear.workerId);
    markTurnGateHandled(input.leadSessionId, textFingerprint);
    log.info('orca arrears reminder', {
      leadSessionId: input.leadSessionId,
      worker: arrear.workerId,
      turns: settleIndex - arrear.settlesAtReport,
    });
    return [
      `[Orca host] Worker ${arrear.workerLabel} has been waiting ${settleIndex - arrear.settlesAtReport} turns and nothing has been sent to it since:`,
      arrear.question,
      'Answer it with send_to_worker, or tell the user what you are waiting for.',
    ].join('\n');
  }

  // L0 凭据层：引用了协议根本不存在的派发结果值；编号查不到不算证据。
  const claim = findUnbackedDispatchClaim(text);
  if (claim) {
    if (!consumeDispatchClaimReminder(input.leadSessionId, input.turnGeneration, `${claim.kind}:${claim.token}`)) {
      return undefined;
    }
    markTurnGateHandled(input.leadSessionId, textFingerprint);
    return unbackedClaimReason(claim);
  }

  // 只剩「纯口语声称已派」这一格需要语义判定。
  //
  // 免检的判据只有一条：**这个回合自己派发过**。归属看「上一次收口之后落地」
  // （settlesAtAccept），不看代次等值——代次由事件推出来，Stop hook 触发时可能
  // 还停在上一轮，把握到本轮的派发漏掉，就会把一句真话判成假话。
  //
  // 「碰过 Orca 工具」不构成免检：调用两次都报错、第三次才成的形态真实存在，
  // 那种回合里说「已派出去了」同样是假话。
  const dispatchedThisTurn = dispatchFactsForTurn(input.leadSessionId, input.turnGeneration).some(
    (fact) =>
      fact.settlesAtAccept === undefined
        ? fact.turnGeneration === input.turnGeneration
        : fact.settlesAtAccept >= settleIndex - 1,
  );
  if (dispatchedThisTurn) {
    markTurnGateHandled(input.leadSessionId, textFingerprint);
    return undefined;
  }

  // 没有派发、也没有这类动词：普通汇报，不付模型调用。
  if (!DISPATCH_WORD_PATTERN.test(text)) {
    markTurnGateHandled(input.leadSessionId, textFingerprint);
    return undefined;
  }

  const verdict = await judgeDispatchClaim({
    leadSessionId: input.leadSessionId,
    turnGeneration: input.turnGeneration,
    finalText: text,
    workerLabels: input.workers.map((worker) => worker.label),
    priorDispatches: describePriorDispatches({
      leadSessionId: input.leadSessionId,
      turnGeneration: input.turnGeneration,
      workers: input.workers,
      settleIndex,
      text,
    }),
  });
  if (verdict !== 'claim') {
    markTurnGateHandled(input.leadSessionId, textFingerprint);
    return undefined;
  }

  // 声称的身份 = 它点名的 worker 名单；没点名时用文本指纹，避免把所有不点名的
  // 声称合并成一个 key（那会让第一句拦下后，窗口内的假声称全部静默放行）。
  const named = input.workers
    .map((worker) => worker.label)
    .filter((label) => mentionsLabel(text, label))
    .sort();
  const claimKey = named.length > 0 ? `spoken:${named.join('|')}` : `spoken:unnamed:${textFingerprint}`;
  markTurnGateHandled(input.leadSessionId, textFingerprint);
  if (!consumeDispatchClaimReminder(input.leadSessionId, input.turnGeneration, claimKey)) {
    return undefined;
  }
  return JUDGED_CLAIM_REASON;
}

export { MAX_PRIOR_DISPATCH_LINES, JUDGE_TEXT_LIMIT };
