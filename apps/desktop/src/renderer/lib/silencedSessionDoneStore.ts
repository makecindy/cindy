/**
 * 自动任务(scheduler)终态通知的抑制标记。
 *
 * 两组标记语义刻意分开:
 *   - silenced:静默运行的成功 run —— 完全不发通知、不亮角标。来源有两条:
 *     `Schedule.silentWhenIdle` 预设(run 开始、session-bound 时就静默),以及 agent
 *     在自己 turn 内调 `schedule_silence_current_run`(引擎 `silenceRun`)。两条都走
 *     `silenced` 事件,但**建立标记的时机相对 turn 完全不同**(一条在 turn 之前、
 *     一条在 turn 中间),任何依赖「事件序」的判断都会在其中一条上翻车。
 *   - schedulerOwned:普通自动任务 —— scheduler notifier 已按 `schedule.notify`
 *     发过这次终态通知,renderer 不能再发第二条;但侧栏 / Dock attention 仍按
 *     普通 done/error 逻辑保留。
 *
 * **标记的生命周期跟随 run,不是「被第一次 done 消费掉」**:一个 run 内 session
 * 的 running→done 会翻转多次(后台 subagent 完成后 SDK 自动续 turn、silent-stop
 * 守卫 1.5s 后自动续跑、队列自动衔接),标记必须活过每一次中间 done,否则最终那
 * 次真 done 会当成普通完成,把 macOS toast / 飞书 / 手机推送全发一遍。
 *
 * 清除只有三条路径:scheduler 的 completed / failed / notified 事件、run 已终态后该
 * session 又起新 turn、以及对账权威 run 状态(`reconcileRunMarkers`,治事件丢失)。前两条
 * 与第三条统一走 `MARKER_TERMINAL_LINGER_MS` 的退场窗口。main 侧灵动岛
 * (`main/agent-island/service.ts` 的 `isCompletionEventSilenced`)是同一套语义,
 * 两边不要再分叉。
 */

const silencedRunSessionIds = new Map<string, string>();
const silencedSessionRunIds = new Map<string, string>();
const silencedRunHadAttention = new Map<string, boolean>();
const schedulerOwnedRunSessionIds = new Map<string, string>();
const schedulerOwnedSessionRunIds = new Map<string, string>();
const schedulerOwnedClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
const runAttentionBaselines = new Map<
  string,
  { sessionId: string; hadSessionAttention: boolean }
>();
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 事件丢失的自愈**不用定时器**。历史上试过三种「猜 run 还在不在飞行」的判据,
 * 每一种都被证明会误判,不要再往回走:
 *
 *   1. 事件先后顺序(建标记时武装、新 turn 起时撤销):agent 在自己 turn 内调
 *      `schedule_silence_current_run` 时,标记建立时该 turn 已经 running,此后再没
 *      有信号能撤销;反过来只在新 turn 起时撤销,消费方随后卸载就永远没有兜底。
 *   2. renderer 的 running 快照:`makerChatStore` 的折算**刻意**把 `remote_agent`、
 *      `local_bash`、未知 task_type 排除在 `WAKE_AGENT_TASK_TYPES` 之外,device-link
 *      远程会话整体豁免 —— run 仍在飞行而快照为 false 是设计内行为。
 *   3. 固定时长上限:runner 的 `BG_TASK_IDLE_FALLBACK_MS` 是**事件静默**超时,每个
 *      事件都会重新武装,不是最大 run 时长。持续产出事件的后台任务可以合法飞行
 *      任意长,任何固定窗口都必然误清。
 *
 * 现在改为向权威来源对账:scheduler 落库的 run 状态(见
 * `reconcileRunMarkers`)。不猜,只问。
 */

export function rememberScheduleRunSessionAttentionBaseline(
  runId: string,
  sessionId: string,
  hadSessionAttention: boolean,
): void {
  if (!runId || !sessionId) return;
  runAttentionBaselines.set(runId, { sessionId, hadSessionAttention });
}

export function getScheduleRunSessionAttentionBaseline(
  runId: string,
): { sessionId: string; hadSessionAttention: boolean } | undefined {
  return runAttentionBaselines.get(runId);
}

export function markNextSessionDoneSilenced(
  runId: string,
  sessionId: string,
  hadSessionAttention = false,
): void {
  if (!runId || !sessionId) return;
  const previousRunId = silencedSessionRunIds.get(sessionId);
  if (previousRunId) {
    silencedRunSessionIds.delete(previousRunId);
    silencedRunHadAttention.delete(previousRunId);
    // 被顶替的 run 不会再有人调 clearSilencedRun(它已不在 silencedRunSessionIds
    // 里,scheduleClearSilencedRun 会直接 return),baseline 必须在这里一起清,
    // 否则 runAttentionBaselines 会随 session 复用无界增长。
    runAttentionBaselines.delete(previousRunId);
  }
  clearPendingTimer(previousRunId);
  clearPendingTimer(runId);
  silencedRunSessionIds.set(runId, sessionId);
  silencedSessionRunIds.set(sessionId, runId);
  silencedRunHadAttention.set(runId, hadSessionAttention);
}

/** 纯查询:同一个 run 内每次 done 转换都要得到 true(见文件头注释)。 */
export function isSessionDoneSilenced(sessionId: string): boolean {
  return silencedSessionRunIds.has(sessionId);
}

export function markNextSessionTerminalNotificationOwnedByScheduler(
  runId: string,
  sessionId: string,
): void {
  if (!runId || !sessionId) return;
  const previousRunId = schedulerOwnedSessionRunIds.get(sessionId);
  if (previousRunId) schedulerOwnedRunSessionIds.delete(previousRunId);
  clearSchedulerOwnedTimer(previousRunId);
  clearSchedulerOwnedTimer(runId);
  schedulerOwnedRunSessionIds.set(runId, sessionId);
  schedulerOwnedSessionRunIds.set(sessionId, runId);
}

/** 与 `isSessionDoneSilenced` 同款语义:纯查询,run 内多次 done 都命中。 */
export function isSessionTerminalNotificationOwnedByScheduler(
  sessionId: string,
): boolean {
  return schedulerOwnedSessionRunIds.has(sessionId);
}

/** 对账用的 run 存活态:只关心「还在飞行」与「不再飞行」。 */
export type RunLivenessStatus = 'running' | 'terminal';

/**
 * 标记从「run 已终态」到真正删除之间的退场窗口。
 *
 * 这段延迟是留给 renderer 的 done transition 的:scheduler 的终态事件可能早于 React
 * 处理该 session 的 running→done,立刻删标记会让那次 transition 看不到标记、于是发出
 * 不该发的(或重复的)通知。事件路径与对账路径都必须走这段 linger —— 对账遇到的恰恰是
 * 「终态事件丢了、从未排过 linger」的标记,直接清就会踩到同一个坑。
 *
 * 于是全模块只有一个统一语义:**linger 定时器存在 = run 已终态、标记进入退场倒计时**,
 * 不论这个判定来自事件还是来自对账。`clearCompleted*ForNewActivity` 正是拿它当终态判据。
 */
export const MARKER_TERMINAL_LINGER_MS = 2000;

/** 是否还有任何标记等待对账。消费方据此决定要不要继续重试拉取快照。 */
export function hasAnyRunMarker(): boolean {
  return silencedRunSessionIds.size > 0 || schedulerOwnedRunSessionIds.size > 0;
}

export interface ReconcileRunMarkersResult {
  /**
   * 本轮出现了「DB 说还在跑、引擎的 in-flight 快照里却没有」的持标记 run,说明这两份读
   * 拿到的不是同一时刻的状态。
   *
   * 它们由同一次 IPC 取回,但中间隔着 DB 查询的 `await`:run 恰好在那个窗口内结束时,
   * SQLite 返回的行还是 `running`,而 controller 已被注销 —— 于是本轮只能保守保持标记
   * (它也可能真的还在跑,无法区分)。问题在于:**如果该 run 的终态事件正是丢掉的那个,
   * 就再没有任何信号来清这个标记**,自愈保证被打破。
   *
   * 所以消费方拿到 true 时必须安排一次快速重新对账 —— 下一轮 DB 已落到终态,不一致自然
   * 消解。这是 review 指出的竞态的收口方式(race-safe 快照需要在 main 侧忙等重采样,
   * 代价更大;这里用一次重查换同样的正确性)。
   */
  needsRecheck: boolean;
}

/**
 * 用 scheduler 落库的**权威** run 状态对账标记 —— 事件丢失(广播断链、事件早于消费方
 * 挂载等)的唯一自愈路径。不猜时间、也不看 renderer 的 running 快照,那几种判据都会
 * 误判,见上方「事件丢失的自愈不用定时器」注释。
 *
 * **两份数据缺一不可**,且**引擎的 in-flight 快照优先级更高**:
 *   - `inflightRunIds` 有 → 保持。仍在飞行,飞多久都不清。「行不在库里」并不等于
 *     「跑完了」——agent 在任务 run 内调 `schedule_delete` 删自己的 schedule 时,引擎用
 *     `exemptRunId` 豁免 caller run 不 abort,它的行随 schedule 级联删除后仍继续跑到底。
 *     引擎内存态是这件事唯一的权威来源。
 *   - `dbRunStatus` 是 `terminal` → 排 linger 退场。它的 completed / failed 事件没送到。
 *   - 两份都没有 → 同样排 linger 退场。该 run 已经不存在了:删除 schedule 会级联删掉
 *     它的 `schedule_runs` 行,deferred run 也会被显式删除,这两种情况永远等不到一个终态
 *     状态。这里不可能是「标记建好但 run 还没落库」的极早期 —— 引擎先 `updateRun` 写
 *     sessionId、再 emit `session-bound` / `silenced`,而权威快照包含所有 running run,
 *     所以标记存在就意味着该 run 当时已进入快照范围。异步拉取的过期结果由调用方的
 *     seq 守卫挡掉,不会走到这里。
 *
 * **空的 dbRunStatus 不是异常,一样要对账**:权威查询在库里没有匹配行时合法返回空数组
 * (删掉了最后一个 schedule、或唯一的 run 被 defer 后删除),而查询失败是 reject、走调用方
 * 的 catch 与重试,根本不会以空映射的形式到这里。
 *
 * 清除统一走 `MARKER_TERMINAL_LINGER_MS` 的 linger,不立即删 —— 对账面对的正是「终态
 * 事件丢了、从未排过 linger」的标记,而 DB 可能已报终态、React 却还没处理该 session 的
 * running→done。已排 linger 的标记跳过,避免重置它的倒计时。
 *
 * 返回 `needsRecheck`:见 `ReconcileRunMarkersResult`。
 */
export function reconcileRunMarkers(
  dbRunStatus: ReadonlyMap<string, RunLivenessStatus>,
  inflightRunIds: ReadonlySet<string>,
): ReconcileRunMarkersResult {
  let needsRecheck = false;
  const resolve = (runId: string): 'running' | 'terminal' | 'inconsistent' => {
    if (inflightRunIds.has(runId)) return 'running';
    // DB 说还在跑、引擎却说没在跑 —— 两份读之间那个 await 窗口里 run 刚好结束了。
    if (dbRunStatus.get(runId) === 'running') return 'inconsistent';
    return 'terminal';
  };
  for (const runId of [...silencedRunSessionIds.keys()]) {
    if (clearTimers.has(runId)) continue;
    const state = resolve(runId);
    if (state === 'inconsistent') needsRecheck = true;
    if (state !== 'terminal') continue;
    scheduleClearSilencedRun(runId, MARKER_TERMINAL_LINGER_MS);
  }
  for (const runId of [...schedulerOwnedRunSessionIds.keys()]) {
    if (schedulerOwnedClearTimers.has(runId)) continue;
    const state = resolve(runId);
    if (state === 'inconsistent') needsRecheck = true;
    if (state !== 'terminal') continue;
    scheduleClearSchedulerOwnedRun(runId, MARKER_TERMINAL_LINGER_MS);
  }
  return { needsRecheck };
}

export function scheduleClearSchedulerOwnedRun(runId: string, delayMs: number): void {
  if (!schedulerOwnedRunSessionIds.has(runId)) return;
  clearSchedulerOwnedTimer(runId);
  const timer = setTimeout(() => {
    schedulerOwnedClearTimers.delete(runId);
    clearSchedulerOwnedRun(runId);
  }, delayMs);
  schedulerOwnedClearTimers.set(runId, timer);
}

export function clearSchedulerOwnedRun(runId: string): string | undefined {
  clearSchedulerOwnedTimer(runId);
  const sessionId = schedulerOwnedRunSessionIds.get(runId);
  if (!sessionId) return undefined;
  schedulerOwnedRunSessionIds.delete(runId);
  if (schedulerOwnedSessionRunIds.get(sessionId) === runId) {
    schedulerOwnedSessionRunIds.delete(sessionId);
  }
  return sessionId;
}

/**
 * run 已终态(completed/failed 排了 linger)后该 session 又起新 turn:那是用户手动
 * 对话或下一个 run,立刻交回普通通知路径。run 还在跑时不清 —— 判据是
 * `schedulerOwnedClearTimers` 有没有 linger 定时器,而不是任何时间或 running 推断。
 */
export function clearCompletedSchedulerOwnedRunForNewActivity(sessionId: string): void {
  const runId = schedulerOwnedSessionRunIds.get(sessionId);
  if (!runId || !schedulerOwnedClearTimers.has(runId)) return;
  clearSchedulerOwnedRun(runId);
}

export function scheduleClearSilencedRun(runId: string, delayMs: number): void {
  if (!silencedRunSessionIds.has(runId)) return;
  clearPendingTimer(runId);
  const timer = setTimeout(() => {
    clearTimers.delete(runId);
    clearSilencedRun(runId);
  }, delayMs);
  clearTimers.set(runId, timer);
}

/** 与 `clearCompletedSchedulerOwnedRunForNewActivity` 对称。 */
export function clearCompletedSilencedRunForNewActivity(sessionId: string): void {
  const runId = silencedSessionRunIds.get(sessionId);
  if (!runId || !clearTimers.has(runId)) return;
  clearSilencedRun(runId);
}

export function clearSilencedRun(runId: string): string | undefined {
  clearPendingTimer(runId);
  const sessionId = silencedRunSessionIds.get(runId);
  if (!sessionId) {
    runAttentionBaselines.delete(runId);
    return undefined;
  }
  silencedRunSessionIds.delete(runId);
  silencedRunHadAttention.delete(runId);
  runAttentionBaselines.delete(runId);
  if (silencedSessionRunIds.get(sessionId) === runId) {
    silencedSessionRunIds.delete(sessionId);
  }
  return sessionId;
}

export function getSilencedRunSessionId(runId: string): string | undefined {
  return silencedRunSessionIds.get(runId);
}

export function getSilencedRunSessionIdForAttentionFallback(runId: string): string | undefined {
  if (silencedRunHadAttention.get(runId) !== false) return undefined;
  return silencedRunSessionIds.get(runId);
}

export function resetSilencedSessionDoneStoreForTests(): void {
  for (const timer of clearTimers.values()) clearTimeout(timer);
  clearTimers.clear();
  silencedRunSessionIds.clear();
  silencedSessionRunIds.clear();
  silencedRunHadAttention.clear();
  runAttentionBaselines.clear();
  for (const timer of schedulerOwnedClearTimers.values()) clearTimeout(timer);
  schedulerOwnedClearTimers.clear();
  schedulerOwnedRunSessionIds.clear();
  schedulerOwnedSessionRunIds.clear();
}

function clearPendingTimer(runId: string | undefined): void {
  if (!runId) return;
  const timer = clearTimers.get(runId);
  if (!timer) return;
  clearTimeout(timer);
  clearTimers.delete(runId);
}

function clearSchedulerOwnedTimer(runId: string | undefined): void {
  if (!runId) return;
  const timer = schedulerOwnedClearTimers.get(runId);
  if (!timer) return;
  clearTimeout(timer);
  schedulerOwnedClearTimers.delete(runId);
}
