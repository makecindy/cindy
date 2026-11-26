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

/** 每个会话最近一次看到的事件代次：只用来发现「进入了新回合」，不当身份用。 */
const lastGeneration = new Map<string, number>();
/**
 * 宿主自己发的回合号：单调、跨实例不重复，是本模块唯一的回合身份。
 *
 * 不能拿事件代次当身份：实例重建后它从头数，同一个号会指向两个不同的回合。
 * 也不能拿收口文本当身份：连续两轮可以说同一句话，而那是两件不同的事
 * （第一轮真派了活，第二轮接到新要求却没派，同样说「已经安排了」）。
 *
 * Stop hook 还可能在本轮事件到达前触发——那时宿主还没为这一回合开号，闸门按
 * 「没有回合身份就不判」放行，交给宿主 settle 那一侧用真实回合号判。
 */
const turnSeqBySession = new Map<string, number>();
/** 已经判过的回合号：一个回合只能有一个否决点，两个出口不能各判一次。 */
const handledBySession = new Map<string, Set<number>>();
/** 判定结果缓存：同一回合只问一次模型。 */
const judgedByTurn = new Map<string, 'claim' | 'quiet'>();
/** 已经收口过的回合号集合：收口计数与「几轮之前」都按它数。 */
/** 最近一次收口的回合号：Stop hook 拿它判断「这一回合宿主开号了没有」。 */

function trimTracked(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/**
 * 每个事件都调一次：代次变了就是新回合，为它开一个新号。
 *
 * 号只增不减，跨实例也不重复，所以不需要在重建时清「已判」——新回合天然是新的号。
 * 实际 gen 相同（同一回合的后续事件）不开新号，否则一个回合会被判很多次。
 */
export function noteTurnEvent(sessionId: string, generation: number): void {
  if (lastGeneration.get(sessionId) === generation) return;
  lastGeneration.set(sessionId, generation);
  turnSeqBySession.set(sessionId, currentTurnSeq(sessionId) + 1);
}

/** 当前回合号；0 表示宿主还没见过这个会话的任何回合。 */
export function currentTurnSeq(sessionId: string): number {
  return turnSeqBySession.get(sessionId) ?? 0;
}

/** 标记这个回合已判过（结论是拦还是放都算）。 */
export function markTurnGateHandled(sessionId: string, turnSeq: number): void {
  const seen = handledBySession.get(sessionId) ?? new Set<number>();
  seen.add(turnSeq);
  handledBySession.set(sessionId, seen);
  while (seen.size > MAX_TRACKED_ENTRIES) {
    const oldest = seen.values().next();
    if (oldest.done) return;
    seen.delete(oldest.value);
  }
  trimTracked(handledBySession, MAX_TRACKED_ENTRIES);
}

export function turnGateHandled(sessionId: string, turnSeq: number): boolean {
  return handledBySession.get(sessionId)?.has(turnSeq) ?? false;
}

/** 会话结束或重建时清账：账本永不清会被会话键一直占着内存。 */
export function forgetTurnGate(sessionId?: string): void {
  resetDispatchClaimState(sessionId);
  if (!sessionId) {
    lastGeneration.clear();
    turnSeqBySession.clear();
    handledBySession.clear();
    judgedByTurn.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of judgedByTurn.keys()) if (key.startsWith(prefix)) judgedByTurn.delete(key);
  lastGeneration.delete(sessionId);
  turnSeqBySession.delete(sessionId);
  handledBySession.delete(sessionId);
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
  turnSeq: number;
  finalText: string;
  workers?: Array<{ label: string; status: string }>;
  workerLabels?: string[];
  priorDispatches?: string[];
}): Promise<DispatchClaimVerdict> {
  const text = params.finalText.trim();
  if (!text) return 'quiet';

  const key = `${params.leadSessionId}:${params.turnSeq}`;
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
  turnSeq: number;
  workers: Array<{ label: string; status: string }>;
  text: string;
}): string[] {
  const statuses = new Map(input.workers.map((worker) => [worker.label, worker.status]));
  const facts = dispatchFactsForTurn(input.leadSessionId, input.turnSeq).sort(
    (a, b) => b.at - a.at,
  );
  // 先给这段文本点到的 Worker：复述的往往就是最近提到的那个，被裁掉的恰好是
  // 「我上一轮派给 research 了」这句真话的依据。剩下的按时间补足行数。
  const cited = facts.filter((fact) => mentionsLabel(input.text, fact.workerLabel));
  const rest = facts.filter((fact) => !cited.includes(fact));
  return [...cited, ...rest]
    .slice(0, MAX_PRIOR_DISPATCH_LINES)
    .map((fact) => {
      const when = fact.turnSeq === input.turnSeq ? 'this turn' : 'an earlier turn';
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
 *
 * 归属一律按宿主自己发的回合号，不看文本、不看事件代次：
 * - 文本会重复（连续两轮说同一句「已经把活派出去了」），按文本归并会把第二轮漏掉；
 * - 事件代次可能滞后（Stop hook 先于本轮事件触发），按它归会把上一轮的派发当成本轮。
 * 没有回合号的调用不判：无法认领回合时静默放过，交给有真实回合号的出口。
 */
/**
 * 去掉 `dispatch_id: x` / `queued_message_id: x` 这类编号字面量。
 *
 * 编号里的 `dispatch` 不是动词：不剥掉的话，「这条 queued_message_id 还在排队」
 * 会被派发动词判据命中，白付一次模型调用。
 */
function stripIdentifierLiterals(text: string): string {
  return text.replace(
    /\b(?:dispatch_id|queued_message_id|message_id|client_id)\s*[=:]\s*`?[\w-]+`?/gi,
    ' ',
  );
}

export async function evaluateTurnGate(input: {
  leadSessionId: string;
  turnSeq: number;
  finalText: string | undefined;
  workers: Array<{ label: string; status: string }>;
}): Promise<string | undefined> {
  const text = input.finalText?.trim() ?? '';
  if (!text || input.turnSeq <= 0) return undefined;

  // 一个回合一个否决点：引擎侧判过，宿主 settle 不再判第二遍。
  if (turnGateHandled(input.leadSessionId, input.turnSeq)) return undefined;

  // L0 凭据层：引用了协议根本不存在的派发结果值；编号查不到不算证据。
  const claim = findUnbackedDispatchClaim(text);
  if (claim) {
    markTurnGateHandled(input.leadSessionId, input.turnSeq);
    if (
      !consumeDispatchClaimReminder(input.leadSessionId, input.turnSeq)
    ) {
      return undefined;
    }
    return unbackedClaimReason(claim);
  }

  // 免检只有一条：这个回合自己派发过。派发记录按回合号归属，所以「上一轮派过」
  // 不会替本轮作证。
  const dispatchedThisTurn = dispatchFactsForTurn(input.leadSessionId, input.turnSeq).some(
    (fact) => fact.turnSeq === input.turnSeq,
  );
  if (dispatchedThisTurn) {
    markTurnGateHandled(input.leadSessionId, input.turnSeq);
    return undefined;
  }

  // 既没有派发动词、也没点名任何 Worker：普通汇报，不付模型调用。
  // 点名的场合必须判：`developer2 那边已经在跑了` 这类说法没有动词，却是声称。
  const namesAWorker = input.workers.some((worker) => mentionsLabel(text, worker.label));
  if (!namesAWorker && !DISPATCH_WORD_PATTERN.test(stripIdentifierLiterals(text))) {
    markTurnGateHandled(input.leadSessionId, input.turnSeq);
    return undefined;
  }

  const verdict = await judgeDispatchClaim({
    leadSessionId: input.leadSessionId,
    turnSeq: input.turnSeq,
    finalText: text,
    workerLabels: input.workers.map((worker) => worker.label),
    priorDispatches: describePriorDispatches({
      leadSessionId: input.leadSessionId,
      turnSeq: input.turnSeq,
      workers: input.workers,
      text,
    }),
  });
  // 判定不可用（超时/报错/答非单值）不留标记：这一轮还能由另一个出口重判一次，
  // 把「没读」当成「读过且没问题」正是不可用的反义。
  if (verdict === 'unavailable') return undefined;
  markTurnGateHandled(input.leadSessionId, input.turnSeq);
  if (verdict !== 'claim') return undefined;
  if (!consumeDispatchClaimReminder(input.leadSessionId, input.turnSeq)) return undefined;
  return JUDGED_CLAIM_REASON;
}

export { MAX_PRIOR_DISPATCH_LINES, JUDGE_TEXT_LIMIT };
