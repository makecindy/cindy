import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { getMaker } from '../maker-host/index.js';
import { createLogger } from '../logger.js';
import {
  consumeDispatchClaimReminder,
  findUnbackedDispatchClaim,
  type UnbackedDispatchClaim,
} from './orcaDispatchClaims.js';

const log = createLogger('orca-turn-gate');

/**
 * 判定器预算。取 10 秒:这是「收口最多等多久」的产品阈值,不是模型平均延迟。
 * 超时一律放行——卡住会话的代价高于放过一句假话。
 */
const JUDGE_TIMEOUT_MS = 10_000;
const JUDGE_MAX_TOKENS = 8;
/** 只判断尾,长回复的结论都在末尾。 */
const JUDGE_TEXT_CHARS = 2000;
const MAX_TRACKED_TURNS = 512;

type TurnKey = `${string}:${number}`;

interface TurnCounts {
  tools: number;
  orcaTools: number;
}

/**
 * Orca 自身的工具名。闸门只看「有没有碰过派发面」：读了几个文件不影响判断，
 * 而一旦调过任何一个 Orca 工具，凭据层就已经能核对，不需要语义判定。
 */
const ORCA_TOOL_NAMES = new Set([
  'send_to_worker',
  'send_to_lead',
  'create_worker',
  'list_workers',
  'update_worker',
  'interrupt_worker',
  'move_queued_message',
  'get_worker_queue_status',
  'switch_focus',
  'wait_for_workers',
  'report_progress',
]);

const countsByTurn = new Map<TurnKey, TurnCounts>();
const judgedByTurn = new Map<string, 'claim' | 'quiet' | 'unavailable'>();
/** 每个会话当前回合号：Stop hook 只拿得到 sessionId，没有事件里的代次。 */
const currentGeneration = new Map<string, number>();
/** 引擎侧已经判过的回合，宿主 settle 不再重判——一个会话只能有一个否决点。 */
const handledByTurn = new Map<TurnKey, true>();

const turnKey = (sessionId: string, generation: number): TurnKey => `${sessionId}:${generation}`;

function trimTracked(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/** 每个事件都调：记住当前回合号，Stop hook 才能按代次取到凭据与本轮计数。 */
export function noteTurnGeneration(sessionId: string, generation: number): void {
  currentGeneration.set(sessionId, generation);
}

export function currentTurnGeneration(sessionId: string): number | undefined {
  return currentGeneration.get(sessionId);
}

/** 收口闸门的机械扳机：本轮调过哪些工具，其中有没有 Orca 自己的工具。 */
export function noteTurnToolUse(sessionId: string, generation: number, toolName?: string): void {
  const key = turnKey(sessionId, generation);
  const counts = countsByTurn.get(key) ?? { tools: 0, orcaTools: 0 };
  counts.tools += 1;
  if (toolName && ORCA_TOOL_NAMES.has(toolName)) counts.orcaTools += 1;
  countsByTurn.set(key, counts);
  currentGeneration.set(sessionId, generation);
  trimTracked(countsByTurn, MAX_TRACKED_TURNS);
}

export function turnToolUseCount(sessionId: string, generation: number): number {
  return countsByTurn.get(turnKey(sessionId, generation))?.tools ?? 0;
}

/** 本回合碰过 Orca 工具的次数。0 表示它没碰过派发面。 */
export function turnOrcaToolUseCount(sessionId: string, generation: number): number {
  return countsByTurn.get(turnKey(sessionId, generation))?.orcaTools ?? 0;
}

/** 标记该回合已由引擎侧闸门判过（无论结论是拦还是放）。 */
export function markTurnGateHandled(sessionId: string, generation: number): void {
  handledByTurn.set(turnKey(sessionId, generation), true);
  trimTracked(handledByTurn, MAX_TRACKED_TURNS);
}

export function turnGateHandled(sessionId: string, generation: number): boolean {
  return handledByTurn.has(turnKey(sessionId, generation));
}

/**
 * Lead 收口计数，用来给欠账计时。
 *
 * 用「又过了几个 Lead 回合」而不是墙钟或代次：欠账的意义是「还在等，而且没人动」，
 * 换个说法就是连续几轮都没处理；代次在换实例时会跳变，墙钟会让空闲会话误触发。
 */
export function noteLeadSettle(sessionId: string): number {
  const next = (leadSettles.get(sessionId) ?? 0) + 1;
  leadSettles.set(sessionId, next);
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
const leadSettles = new Map<string, number>();
/** 欠账满两个 Lead 回合还没被处理，就该说话。一轮留给 Lead 正常向用户澄清。 */
const ARREARS_SETTLE_THRESHOLD = 2;

const arrearsKey = (leadSessionId: string, workerId: string): string => `${leadSessionId}:${workerId}`;

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
  if (!sessionId) {
    countsByTurn.clear();
    judgedByTurn.clear();
    arrearsByWorker.clear();
    leadSettles.clear();
    currentGeneration.clear();
    handledByTurn.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of countsByTurn.keys()) if (key.startsWith(prefix)) countsByTurn.delete(key);
  for (const key of judgedByTurn.keys()) if (key.startsWith(prefix)) judgedByTurn.delete(key);
  for (const key of arrearsByWorker.keys()) if (key.startsWith(prefix)) arrearsByWorker.delete(key);
  for (const key of handledByTurn.keys()) if (key.startsWith(prefix)) handledByTurn.delete(key);
  leadSettles.delete(sessionId);
  currentGeneration.delete(sessionId);
}

function judgePrompt(workerLabels: string[], finalText: string): string {
  const workers = workerLabels.length ? workerLabels.join(', ') : '(none registered)';
  return [
    'One assistant turn ended with no tool call and no accepted dispatch.',
    `Workers that could receive work: ${workers}.`,
    "Decide whether this closing text asserts that work was already handed to a worker.",
    'Answer "claim" only for an explicit assertion that work was already given, dispatched, queued, or is being done by a worker.',
    'Answer "quiet" for summaries, plans, questions, status of user-facing work, or anything that does not assert that a handoff already happened.',
    'When unsure, answer "quiet".',
    'Reply with exactly one word: claim or quiet.',
    '',
    'Turn text:',
    finalText,
  ].join('\n');
}

export type DispatchClaimVerdict = 'claim' | 'quiet' | 'unavailable';
/**
 * 只剩「纯口语声称已派」这一格需要语义判定:凭据(L0)已经由账本比对处理。
 * 判定失败、超时、无法解析一律返回 unavailable 并放行。
 */
export async function judgeDispatchClaim(params: {
  leadSessionId: string;
  turnGeneration: number;
  finalText: string;
  workerLabels: string[];
}): Promise<DispatchClaimVerdict> {
  const text = params.finalText.trim();
  if (!text) return 'quiet';

  const key = `${turnKey(params.leadSessionId, params.turnGeneration)}:${text.length}:${text.slice(-64)}`;
  const cached = judgedByTurn.get(key);
  if (cached) return cached;

  let verdict: DispatchClaimVerdict = 'unavailable';
  try {
    const result = await requestUtilityText(
      getMaker(),
      judgePrompt(params.workerLabels, text.slice(-JUDGE_TEXT_CHARS)),
      {
        source: 'orca-turn-gate',
        maxTokens: JUDGE_MAX_TOKENS,
        timeoutMs: JUDGE_TIMEOUT_MS,
        disableReasoning: true,
      },
    );
    if (result.ok) verdict = /\bclaim\b/i.test(result.text) ? 'claim' : 'quiet';
  } catch (error) {
    log.info('orca turn gate judge unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  judgedByTurn.set(key, verdict);
  trimTracked(judgedByTurn, MAX_TRACKED_TURNS);
  return verdict;
}

/** 拦下收口时回灌给模型的说明。L0 与 L1 用同一段结构，只有第一句不同。 */
function unbackedClaimReason(claim: UnbackedDispatchClaim): string {
  const detail =
    claim.kind === 'wake-kind'
      ? `You wrote \`${claim.label}=${claim.token}\`, but the host accepted no dispatch for this session.`
      : `You wrote \`${claim.label}: ${claim.token}\`, but no such dispatch exists in this session.`;
  return [
    '[Orca host] You cited a dispatch record the host does not have.',
    detail,
    'Either dispatch now with send_to_worker, or say plainly that nothing was dispatched.',
  ].join('\n');
}

const JUDGED_CLAIM_REASON = [
  '[Orca host] This turn dispatched nothing, and no worker received work from you.',
  'You wrote that work was already handed to a worker. Either dispatch now with send_to_worker, or say plainly that nothing was dispatched.',
].join('\n');

/**
 * 收口闸门的唯一判定入口。返回 reason 表示不允许收口（引擎 Stop hook 会据此 block）；
 * 返回 undefined 表示放行。
 *
 * 两个出口共用这里的判定、上限与文案：
 * - Claude Code：注册在引擎自己的 Stop 里，和用户 hook 同场评估、一次续跑；
 * - Codex / pi：宿主 settle 里调（Codex 的 hooks 在 Cindy 下是关闭的，不存在叠加）。
 *
 * 每回合最多拦一次，记在 `consumeDispatchClaimReminder` 里，两个出口共享同一本账。
 */
export async function evaluateTurnGate(input: {
  leadSessionId: string;
  turnGeneration: number;
  finalText: string | undefined;
  workerLabels: string[];
  /** 本回合被宿主接受的派发数（调用方从凭据账取，这里不推进账本观察）。 */
  factsCount: number;
}): Promise<string | undefined> {
  const text = input.finalText?.trim() ?? '';
  markTurnGateHandled(input.leadSessionId, input.turnGeneration);
  if (!text) return undefined;

  const claim = findUnbackedDispatchClaim(input.leadSessionId, text);
  if (claim) {
    if (
      !consumeDispatchClaimReminder(input.leadSessionId, input.turnGeneration, {
        kind: claim.kind,
        token: claim.token,
      })
    ) {
      return undefined;
    }
    return unbackedClaimReason(claim);
  }

  // 只剩「纯口语声称已派」这一格需要语义判定：本回合零派发、且没碰过任何 Orca 工具。
  // 用「零 Orca 工具」而不是「零工具」：读了几个文件再说已派同样可疑，
  // 而那正是 Claude Code 用户最常见的形态。
  if (input.factsCount > 0 || turnOrcaToolUseCount(input.leadSessionId, input.turnGeneration) > 0) {
    return undefined;
  }
  const verdict = await judgeDispatchClaim({
    leadSessionId: input.leadSessionId,
    turnGeneration: input.turnGeneration,
    finalText: text,
    workerLabels: input.workerLabels,
  });
  if (verdict !== 'claim') return undefined;
  if (
    !consumeDispatchClaimReminder(input.leadSessionId, input.turnGeneration, {
      kind: 'judge',
      token: 'turn-gate',
    })
  ) {
    return undefined;
  }
  return JUDGED_CLAIM_REASON;
}
