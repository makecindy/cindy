import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { getMaker } from '../maker-host/index.js';
import { createLogger } from '../logger.js';

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

const toolUseByTurn = new Map<TurnKey, number>();
const judgedByTurn = new Map<string, 'claim' | 'quiet' | 'unavailable'>();

const turnKey = (sessionId: string, generation: number): TurnKey => `${sessionId}:${generation}`;

function trimTracked(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/**
 * 收口闸门的机械扳机:本回合有没有任何工具调用。
 * 只数次数,不关心哪个工具——闸门要的是「这轮到底做没做事」。
 */
export function noteTurnToolUse(sessionId: string, generation: number): void {
  const key = turnKey(sessionId, generation);
  toolUseByTurn.set(key, (toolUseByTurn.get(key) ?? 0) + 1);
  trimTracked(toolUseByTurn, MAX_TRACKED_TURNS);
}

export function turnToolUseCount(sessionId: string, generation: number): number {
  return toolUseByTurn.get(turnKey(sessionId, generation)) ?? 0;
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
    toolUseByTurn.clear();
    judgedByTurn.clear();
    arrearsByWorker.clear();
    leadSettles.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of toolUseByTurn.keys()) if (key.startsWith(prefix)) toolUseByTurn.delete(key);
  for (const key of judgedByTurn.keys()) if (key.startsWith(prefix)) judgedByTurn.delete(key);
  for (const key of arrearsByWorker.keys()) if (key.startsWith(prefix)) arrearsByWorker.delete(key);
  leadSettles.delete(sessionId);
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
