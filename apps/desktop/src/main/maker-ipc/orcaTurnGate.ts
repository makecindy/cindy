import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { requestUtilityTextWithinTimeout } from '../utility-model/utilityTextTimeout.js';
import { createLogger } from '../logger.js';
import {
  consumeDispatchClaimReminder,
  dispatchFactsForTurn,
  findUnbackedDispatchClaim,
  sessionInstanceToken,
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
  /** 会话实例标记：换实例后同一会话 id 与代次会重用，旧计数不能继承。 */
  instance?: number;
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
const handledByTurn = new Map<TurnKey, number | undefined>();
/** 每个会话最后一次看到的回合号与实例标记，用来发现「换了实例、代次从头数」。 */
const lastGeneration = new Map<string, number>();
const instanceOf = new Map<string, number>();

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

/**
 * 收口闸门的单写点：每个事件都调一次。代次总是记录（无工具回合也要记），
 * 只有真的带工具名时才累加计数——两件事拆成两个函数就会出现
 * 「只在 tool_use 时更新代次」这种断点。
 */
export function noteTurnEvent(
  sessionId: string,
  generation: number,
  toolName?: string,
  instance?: number,
): void {
  const previous = lastGeneration.get(sessionId);
  // 实例标记变了、或代次回退，都说明会话被重建过：旧实例同一代次的计数必须丢掉，
  // 否则新实例第 1 轮会被当成「调过工具」而跳过判定。
  const regressed =
    previous !== undefined &&
    (generation < previous || (instance !== undefined && instanceOf.get(sessionId) !== instance));
  if (regressed) forgetTurnGate(sessionId);
  lastGeneration.set(sessionId, generation);
  if (instance !== undefined) instanceOf.set(sessionId, instance);
  currentGeneration.set(sessionId, generation);

  if (!toolName) return;
  const key = turnKey(sessionId, generation);
  const stored = regressed ? undefined : countsByTurn.get(key);
  const counts =
    stored && stored.instance === instance ? stored : { tools: 0, orcaTools: 0, instance };
  counts.tools += 1;
  if (isOrcaTool(toolName)) counts.orcaTools += 1;
  countsByTurn.set(key, counts);
  trimTracked(countsByTurn, MAX_TRACKED_TURNS);
}

/** 当前会话实例标记：Hook 与 settle 两个出口都要按同一个实例写账。 */
export function currentTurnInstance(sessionId: string): number | undefined {
  return instanceOf.get(sessionId);
}

/**
 * Orca 工具名判定。MCP 侧可能带命名空间（`mcp__cindy__send_to_worker`、`cindy/send_to_worker`），
 * 所以只比最后一段，避免换一种拼接就整体失效。
 */
function isOrcaTool(toolName: string): boolean {
  if (ORCA_TOOL_NAMES.has(toolName)) return true;
  const tail = toolName.split('__').pop()?.split('/').pop() ?? toolName;
  return ORCA_TOOL_NAMES.has(tail);
}

export function turnToolUseCount(sessionId: string, generation: number, instance?: number): number {
  const counts = countsByTurn.get(turnKey(sessionId, generation));
  return counts && counts.instance === instance ? counts.tools : 0;
}

/** 本回合碰过 Orca 工具的次数。0 表示它没碰过派发面。 */
export function turnOrcaToolUseCount(
  sessionId: string,
  generation: number,
  instance?: number,
): number {
  const counts = countsByTurn.get(turnKey(sessionId, generation));
  return counts && counts.instance === instance ? counts.orcaTools : 0;
}

/** 标记该回合已由引擎侧闸门判过（无论结论是拦还是放）。 */
export function markTurnGateHandled(
  sessionId: string,
  generation: number,
  instance?: number,
): void {
  handledByTurn.set(turnKey(sessionId, generation), instance);
  trimTracked(handledByTurn, MAX_TRACKED_TURNS);
}

export function turnGateHandled(
  sessionId: string,
  generation: number,
  instance?: number,
): boolean {
  const key = turnKey(sessionId, generation);
  if (!handledByTurn.has(key)) return false;
  return handledByTurn.get(key) === instance;
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
    lastGeneration.clear();
    instanceOf.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of countsByTurn.keys()) if (key.startsWith(prefix)) countsByTurn.delete(key);
  for (const key of judgedByTurn.keys()) if (key.startsWith(prefix)) judgedByTurn.delete(key);
  for (const key of arrearsByWorker.keys()) if (key.startsWith(prefix)) arrearsByWorker.delete(key);
  for (const key of handledByTurn.keys()) if (key.startsWith(prefix)) handledByTurn.delete(key);
  leadSettles.delete(sessionId);
  currentGeneration.delete(sessionId);
  lastGeneration.delete(sessionId);
  instanceOf.delete(sessionId);
}

function judgePrompt(workerLabels: string[], finalText: string): string {
  const workers = workerLabels.length ? workerLabels.join(', ') : '(none registered)';
  return [
    'One assistant turn ended with no tool call and no accepted dispatch.',
    `Workers that could receive work: ${workers}.`,
    "Decide whether this closing text asserts that work was already handed to a worker.",
    'Answer "claim" only for an explicit assertion that work was already given, dispatched, queued, or is being done by a worker. A reply that denies having dispatched anything is not a claim.',
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
    // 整个判定必须在一个截止时间内完成:辅助链有多候选模型,单次请求的超时
    // 挡不住「第一个耗尽后换下一个」,那样收口会被拖到几十秒。
    // 动态取 maker:静态 import 会把整棵 maker-host 模块图拉进任何间接引用
    // 本模块的测试里(它们的 orcaTeamStore mock 不全),collect 阶段就会失败。
    const { getMaker } = await import('../maker-host/index.js');
    const result = await requestUtilityTextWithinTimeout(
      (signal) =>
        requestUtilityText(
          getMaker(),
          judgePrompt(params.workerLabels, text.slice(-JUDGE_TEXT_CHARS)),
          {
            source: 'orca-turn-gate',
            maxTokens: JUDGE_MAX_TOKENS,
            disableReasoning: true,
            signal,
          },
        ),
      JUDGE_TIMEOUT_MS,
      undefined,
      () => ({ ok: false, reason: 'timeout', attempts: [] }),
    );
    // 只接受单值回答：`no claim`、`claim or quiet` 这类都不是结论，按不可用放行。
    if (result.ok) {
      const answer = result.text.trim().replace(/^[`'"*]+|[`'"*.]+$/g, '').toLowerCase();
      if (answer === 'claim') verdict = 'claim';
      else if (answer === 'quiet') verdict = 'quiet';
    }
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
  /** 会话实例标记；换实例后代次重用，计数与凭据都不能沿用。 */
  instance?: number;
}): Promise<string | undefined> {
  const text = input.finalText?.trim() ?? '';
  markTurnGateHandled(input.leadSessionId, input.turnGeneration, input.instance);
  if (!text) return undefined;

  const claim = findUnbackedDispatchClaim(input.leadSessionId, text);
  if (claim) {
    if (!consumeDispatchClaimReminder(input.leadSessionId, input.turnGeneration)) {
      return undefined;
    }
    return unbackedClaimReason(claim);
  }

  // 只剩「纯口语声称已派」这一格需要语义判定：宿主账本里一条派发凭据都没有，
  // 且本回合没碰过任何 Orca 工具。
  //
  // 判据是「整本账空」而不是「本回合零派发」：账本里有凭据时，一句「已交给 X」
  // 很可能是对既有那笔派发的复述，宿主拿单回合文本无权判它为假。按回合切会让
  // 「我上一轮派过了」这类**真话**每轮被判成声称并纠正一次。
  //
  // 用「零 Orca 工具」而不是「零工具」：读了几个文件再说已派同样可疑，
  // 而那正是 Claude Code 用户最常见的形态。
  const facts = dispatchFactsForTurn(input.leadSessionId, input.turnGeneration);
  if (
    facts.length > 0 ||
    turnOrcaToolUseCount(input.leadSessionId, input.turnGeneration, input.instance) > 0
  ) {
    return undefined;
  }
  const verdict = await judgeDispatchClaim({
    leadSessionId: input.leadSessionId,
    turnGeneration: input.turnGeneration,
    finalText: text,
    workerLabels: input.workerLabels,
  });
  if (verdict !== 'claim') return undefined;
  if (!consumeDispatchClaimReminder(input.leadSessionId, input.turnGeneration)) {
    return undefined;
  }
  return JUDGED_CLAIM_REASON;
}
