/**
 * Codex 子代理卡的实时状态聚合(V1 / V2 双轨通用)。
 *
 * 背景:子代理跑在自己的 thread 里,app-server 会把子线程的 item / tokenUsage / turn
 * 通知一并推给本连接(过滤全在客户端本地)。`AppServerHost` 按 lineage 把它们归到 root
 * 订阅者的 `descendantNotification` 通道 —— 刻意不走主线程 dispatch,否则子代理的
 * exec / 文件改动会被渲染成主会话自己的工具调用,还会污染主 turn 的用量与状态机。
 *
 * 本模块把那条原始通知流聚合成子代理卡需要的三个数字(tokens / 工具调用数 / 耗时)与
 * 状态,由调用方按同一 `taskId` 发 `agent_task_update`。卡片本体与 Claude 子代理共用
 * `AgentTaskCard`,这里只负责补齐 Codex 侧此前缺失的数据源,不引入新的 UI 概念。
 *
 * 四条容易踩空的语义,单测各有覆盖:
 *  - **一次 spawn 可能扇出多个子线程**(V1 `spawnAgent` 的 `receiverThreadIds`),但它们
 *    共用同一张卡。聚合状态必须挂在 taskId 上、按 thread 分量累计,否则各线程用自己的
 *    计数器发同一个 taskId,后到的快照会把先到的覆盖成更小的值(token/工具数回退),
 *    且任一 sibling 先收口就会把整张卡误报成完成。
 *  - **通知可能早于 spawn 登记到达**(子线程 `thread/started` 建立 lineage 后,父线程的
 *    spawn item 还没被处理)。这类通知先缓冲,登记后重放,否则首个工具调用、初始 token
 *    甚至终态会永久缺失。
 *  - **血缘边本身也可能早于归属到达**:子线程尚未归属时它就派出了孙线程。那条「孙 → 子」
 *    血缘是孙线程**唯一**的入卡途径(孙线程的 spawn item 只在子线程自己的事件流里,主线程
 *    看不到),丢了不会有第二次机会 —— 必须缓冲,并在父线程归属时**递归**补绑整条链。
 *  - **spawn 自身失败是终态**:派发失败后子线程迟到的 `turn/started` / `turn/completed`
 *    不得把卡片翻回 running/completed。靠卡上的终态闩,不能只改当下已知线程的状态。
 *
 * 设计约束:
 * - **纯聚合、零 IO**:落在 translator/event-loop 热路径上,每条通知只做 Map 查 + 计数。
 * - **有界**:跟踪条目与缓冲都封顶,长会话大量 spawn 不无界增长。
 * - **不猜**:认不出的 method / item 一律忽略并返回 null,不合成任何状态。
 */

import { readCodexSubagentSpawnRegistration } from './translator.js';

export type SubagentLiveCardStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type SubagentSpawnItemPhase = 'started' | 'updated' | 'completed';

/** 一次聚合结果:调用方据此发 `agent_task_update`(字段与 `AgentTaskUsage` 对齐)。 */
export interface SubagentLiveCardUpdate {
  taskId: string;
  status: SubagentLiveCardStatus;
  agentPath?: string;
  /** Observed child-thread model, or its frozen spawn-time default. `null` clears a stale badge. */
  model?: string | null;
  /** 本卡全部子线程 token 快照之和;现代载荷按 spawn 增量,旧 total-only 载荷保留绝对值。 */
  totalTokens: number;
  /** 本卡全部子线程内的工具类 item 数;未知为 0。 */
  toolUses: number;
  durationMs: number;
}

export interface SubagentLiveCardTracker {
  /**
   * 主线程 item 里认出 spawn → 登记「子线程 id → 子代理卡 taskId」。
   *
   * 返回聚合快照 = 调用方应在 translator 之后发一帧 `agent_task_update` 把真实状态重新
   * 声明一次(两种情形:有早到通知/血缘被重放出状态;或该 taskId 已在跟踪 —— 此时
   * translator 的合成 `completed` 帧必须被真实聚合状态盖回去)。
   *
   * 返回 null = 非 spawn item，或 fresh spawn 没有早到状态需要重放（初始模型已由
   * translator 合并进原有启动帧），或 spawn 自身失败且没有早到 usage 可补。
   */
  noteSpawnItem(
    item: unknown,
    inheritedModel?: string,
    phase?: SubagentSpawnItemPhase,
  ): SubagentLiveCardUpdate | null;
  /**
   * 登记「子线程 → 其父线程」的血缘(host 的 `descendantThreadStarted` 对**每一代**都触发)。
   *
   * 嵌套子代理必须靠它:孙线程的 spawn item 出现在**子线程自己**的事件流里,主线程的
   * itemStarted 钩子永远看不到,所以 noteSpawnItem 不可能登记孙线程。父线程已归属某张卡时,
   * 把子线程并入同一张卡并重放其早到缓冲。
   *
   * 父线程**尚未**归属时不能丢弃:那可能只是 spawn item 还没到(乱序),而这条边是孙线程唯一
   * 的入卡途径 —— 先缓冲,父线程归属时递归补绑整条链。真正与子代理无关的血缘会自然淘汰。
   *
   * 返回聚合快照 = 有早到通知被重放出状态,**或**新线程并入改变了聚合状态(例如已显示完成的
   * 卡因为孙线程仍在跑而必须回到 running);否则 null。
   */
  noteDescendantThread(
    childThreadId: string,
    parentThreadId: string,
    model?: string,
    spawnFailed?: boolean,
    inheritParentModel?: boolean,
  ): SubagentLiveCardUpdate | null;
  /**
   * 消费一条子线程通知。返回聚合快照表示卡片需要刷新;返回 null = 与子代理卡无关
   * (不关心的 method、无效载荷),或该子线程尚未登记(已缓冲,等 spawn 到达后重放)。
   */
  handleDescendantNotification(
    childThreadId: string,
    method: string,
    params: unknown,
  ): SubagentLiveCardUpdate | null;
  /**
   * 连接/会话收口前,为所有**仍在跑**的卡产出终态快照(`stopped`)。
   *
   * 必须在 `clear()` 之前调用并把返回的帧发出去:tracker 只靠后代的 `turn/completed` 写终态,
   * 而 transport error / 强制 retire / thread cleanup failure 之后那些通知**永远不会再到**。
   * 光清内部状态的话,桌面与手机的 task-update map 会一直留着最后一帧 `running` —— 进程早就
   * 死了、或者用户已经重连,卡还在原地转圈(review)。
   */
  drainRunningForShutdown(): SubagentLiveCardUpdate[];
  /** 会话收口时清空(与 descendant MCP context 注销同点调用)。 */
  clear(): void;
  /** 诊断/测试用:当前跟踪的子代理卡数。 */
  readonly size: number;
}

/**
 * 计入「工具调用次数」的子线程 item 类型(排除 agentMessage / reasoning / plan 等非工具产出)。
 *
 * 这份名单已对**真实 codex 二进制**导出的协议 schema 逐项核对过(见 PR 说明的实测记录):
 * `codex app-server generate-json-schema` 的 `ThreadItem` 共 18 个变体,这里的 8 个全部存在
 * (无拼写错误),`sleep` 是核对时补上的 —— schema 里写明它是 "Display item emitted by the
 * interruptible `clock.sleep` tool",属工具调用,漏掉会少计一次。其余未计入的
 * (userMessage / hookPrompt / agentMessage / plan / reasoning / enteredReviewMode /
 * exitedReviewMode / contextCompaction / subAgentActivity)确非工具产出。
 */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'fileChange',
  'imageView',
  'imageGeneration',
  'collabAgentToolCall',
  'sleep',
]);

/** 我们会消费的 method —— 只有这些值得在 spawn 登记前缓冲。 */
const CONSUMED_METHODS = new Set([
  'item/started',
  // updated 也必须消费:长跑工具的首个可见阶段可能就是 updated(与主线程 spawn 路径同因),
  // 不收就会在 completed 到达前不计数,会话若先中断则永久漏计。去重靠 countedItemIds 的
  // item id,同一 item 的 started/updated/completed 只会计一次。
  'item/updated',
  'item/completed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
]);

const DEFAULT_MAX_TRACKED_CARDS = 64;
/** 早到通知的缓冲上限(线程数 × 每线程条数),防永不登记的线程无界堆积。 */
const MAX_PENDING_THREADS = 32;
const MAX_PENDING_PER_THREAD = 64;
/** 未归属血缘边的缓冲上限(父线程数 × 每父线程子线程数),同样防无界堆积。 */
const MAX_PENDING_LINEAGE_PARENTS = 32;
const MAX_PENDING_LINEAGE_CHILDREN = 32;
/** Observed models can arrive before lineage; keep this side buffer bounded too. */
const MAX_PENDING_THREAD_MODELS = MAX_PENDING_LINEAGE_PARENTS * MAX_PENDING_LINEAGE_CHILDREN;
/**
 * 单卡工具 item 去重登记的条数上限。去重登记必须活到卡片淘汰(turn/completed 可能早于
 * 后台 item/completed,提前清会让迟到的 completed 重复计数),所以只能按条数封顶。
 */
const MAX_COUNTED_ITEM_IDS = 4096;
/** 基线建立前保留的 live turn id 上限,用于识别跨 turn 延迟到达的首帧 usage。 */
const MAX_OBSERVED_LIVE_TURN_IDS = 64;

interface ThreadState {
  status: SubagentLiveCardStatus;
  /** 现代载荷为本次 spawn 后增量;旧 total-only 载荷保留宿主提供的绝对快照。 */
  totalTokens: number;
  /**
   * app-server 在 fork / resume 连接建立时会先重放一帧恢复后的 tokenUsage；其中 total
   * 含父线程继承历史，不能直接展示。保存该绝对水位，后续 live 快照只显示相对增量。
   */
  tokenUsageBaseline?: number;
  /** 基线建立前已确认的 live turn id；usage 可能晚于下一轮 turn/started 才到。 */
  observedLiveTurnIds: Set<string>;
  /** Model observed from thread metadata, an explicit spawn, or frozen parent inheritance. */
  model?: string;
  /** Keep lower-confidence late spawn metadata from replacing a runtime observation. */
  modelSource?: ThreadModelSource;
  /** A failed nested spawn remains terminal despite late lifecycle events. */
  spawnFailed: boolean;
}

type ThreadModelSource = 'inherited' | 'configured' | 'explicit' | 'runtime';

const MODEL_SOURCE_PRIORITY: Record<ThreadModelSource, number> = {
  inherited: 0,
  configured: 1,
  explicit: 2,
  runtime: 3,
};

interface ThreadModelObservation {
  model: string;
  source: ThreadModelSource;
}

function spawnItemHasRunningAgentState(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const record = item as { type?: unknown; agentsStates?: unknown };
  if (
    record.type !== 'collabAgentToolCall'
    || !record.agentsStates
    || typeof record.agentsStates !== 'object'
  ) return false;
  return Object.values(record.agentsStates as Record<string, unknown>).some((state) => {
    let label: unknown = typeof state === 'string' ? state : undefined;
    if (!label && state && typeof state === 'object') {
      const stateRecord = state as Record<string, unknown>;
      for (const key of ['status', 'state', 'phase']) {
        if (typeof stateRecord[key] === 'string') {
          label = stateRecord[key];
          break;
        }
      }
    }
    return typeof label === 'string'
      && /^(running|in[_-]?progress|started|active)$/i.test(label.trim());
  });
}

/**
 * 读取 agentsStates 里某个子线程的终态标签（completed-only spawn 的唯一终态证据）。
 *
 * app-server 可能省略 item/started，首个可见帧直接是 completed 的 collab 快照——
 * 那里 agentsStates 已是各子线程的**真实终态**。不同步进 tracker 的话线程恒为
 * running，drainRunningForShutdown 会把已完成的子代理持久化成 stopped（P1-4）。
 * 返回 undefined = 无标签或标签不认识（不猜）。
 */
function agentStateTerminalStatus(state: unknown): SubagentLiveCardStatus | undefined {
  let label: unknown = typeof state === 'string' ? state : undefined;
  if (!label && state && typeof state === 'object') {
    const stateRecord = state as Record<string, unknown>;
    for (const key of ['status', 'state', 'phase']) {
      if (typeof stateRecord[key] === 'string') {
        label = stateRecord[key];
        break;
      }
    }
  }
  if (typeof label !== 'string') return undefined;
  const trimmed = label.trim().toLowerCase();
  // `done` 是 Codex agentsStates 的实际产出拼写（见 translator.test.ts 夹具与
  // formatCodexAgentStateLabel 消费的同一载荷），漏掉它会把已完成的子代理在
  // shutdown 时持久化成 stopped（review P1）。
  if (trimmed === 'completed' || trimmed === 'complete' || trimmed === 'succeeded' || trimmed === 'done') return 'completed';
  if (trimmed === 'failed' || trimmed === 'error') return 'failed';
  if (trimmed === 'stopped' || trimmed === 'interrupted' || trimmed === 'cancelled') return 'stopped';
  return undefined;
}

interface TrackedCard {
  taskId: string;
  agentPath?: string;
  startedAt: number;
  toolUses: number;
  /** 已计数的 item id:部分 item 只发 completed(如 imageView),据此防重复计数。 */
  countedItemIds: Set<string>;
  /** 同一次 spawn 的全部子线程(V1 可能多 receiver);状态与 token 分量按线程存。 */
  threads: Map<string, ThreadState>;
  /**
   * spawn 工具调用**自身**失败 → 卡片终态闩。一旦置位,任何子线程生命周期通知都不得再把
   * 状态翻回 running/completed:派发失败就是失败,子线程后续说什么都不改变这个结论(review)。
   */
  spawnFailed: boolean;
}

interface PendingNotification {
  method: string;
  params: unknown;
}

export function createSubagentLiveCardTracker(opts: {
  now?: () => number;
  maxTrackedCards?: number;
  subagentModelFallback?: string;
  /** The proxy route makes this model the actual outbound model, not a display guess. */
  lockSubagentModel?: boolean;
} = {}): SubagentLiveCardTracker {
  const now = opts.now ?? (() => Date.now());
  const maxTrackedCards = opts.maxTrackedCards ?? DEFAULT_MAX_TRACKED_CARDS;
  const subagentModelFallback = typeof opts.subagentModelFallback === 'string' && opts.subagentModelFallback.trim()
    ? opts.subagentModelFallback.trim()
    : undefined;
  const lockSubagentModel = opts.lockSubagentModel === true && Boolean(subagentModelFallback);
  const cards = new Map<string, TrackedCard>();
  const taskIdByThread = new Map<string, string>();
  const pending = new Map<string, PendingNotification[]>();
  /**
   * 尚未归属任何卡的血缘边:`父线程 id → 子线程 id 集合`。
   *
   * 子线程的 `thread/started` 可能早于根线程的 spawn item 到达,而它在归属前就可能已经派出
   * 孙线程 —— 那条「孙 → 子」血缘此刻无从判断归属。以前直接丢弃,后果是父线程登记时只绑直接
   * 子线程,孙线程已缓冲的工具/token/终态永远不会重放:卡片漏计,还可能在孙线程仍在跑时提前
   * 显示完成(review)。这里先记下,父线程一归属就**递归**补绑整条血缘链。
   */
  const pendingLineage = new Map<string, Set<string>>();
  /** Model observed on thread/started before its parent spawn is registered. */
  const pendingThreadModels = new Map<string, ThreadModelObservation>();
  /** Failed nested spawns can be observed before their parent card is attached. */
  const pendingFailedThreads = new Set<string>();
  /**
   * 子线程**第一次被看见**的时刻(第一条缓冲通知或第一条未归属血缘边)。
   *
   * 建卡时 `startedAt` 不能直接用 now():spawn 的 started/updated 阶段可能缺失或晚到,等到
   * completed 才建卡时子线程其实已经跑了一段时间,而那段时间的通知都在缓冲里(没有时间戳)。
   * 用 now() 会把已消耗的时长整段漏掉 —— 长跑子代理甚至显示接近 0ms(review)。既然这套实现
   * 明确支持"通知早于 spawn 登记",起点就必须回溯到最早那条证据。
   */
  const firstSeenAt = new Map<string, number>();

  const noteFirstSeen = (threadId: string): void => {
    if (!firstSeenAt.has(threadId)) firstSeenAt.set(threadId, now());
  };

  /** 建卡时的起点:本次 spawn 的子线程里最早被看见的那个时刻,没有证据时才用当前时间。 */
  const earliestSeen = (threadIds: readonly string[]): number => {
    let earliest = now();
    for (const id of threadIds) {
      const seen = firstSeenAt.get(id);
      if (seen !== undefined && seen < earliest) earliest = seen;
    }
    return earliest;
  };

  const isTerminal = (status: SubagentLiveCardStatus): boolean => status !== 'running';

  const aggregateStatus = (card: TrackedCard): SubagentLiveCardStatus => {
    // 终态闩优先于一切子线程状态:spawn 自身失败就是失败。
    if (card.spawnFailed) return 'failed';
    let sawFailed = false;
    let sawStopped = false;
    for (const thread of card.threads.values()) {
      // 任一子线程仍在跑 → 整张卡仍在跑。sibling 先收口不得把卡提前收成完成。
      if (thread.status === 'running') return 'running';
      if (thread.status === 'failed') sawFailed = true;
      else if (thread.status === 'stopped') sawStopped = true;
    }
    if (card.threads.size === 0) return 'running';
    if (sawFailed) return 'failed';
    if (sawStopped) return 'stopped';
    return 'completed';
  };

  const aggregateModel = (card: TrackedCard): string | null | undefined => {
    const observedModels = new Set<string>();
    let threadsWithModel = 0;
    for (const thread of card.threads.values()) {
      if (thread.model) {
        threadsWithModel += 1;
        observedModels.add(thread.model);
      }
    }
    // V1 can aggregate multiple receiver threads into one card. A singular
    // model label is truthful only when **every** thread has reported one and
    // all values agree — partial observation must not be projected onto the
    // whole card (codex review). With zero reports, use Cindy's explicit
    // configured fallback.
    return threadsWithModel === 0
      ? subagentModelFallback
      : threadsWithModel === card.threads.size && observedModels.size === 1
        ? observedModels.values().next().value
        : null;
  };

  const snapshot = (card: TrackedCard): SubagentLiveCardUpdate => {
    let totalTokens = 0;
    for (const thread of card.threads.values()) totalTokens += thread.totalTokens;
    const status = aggregateStatus(card);
    const model = aggregateModel(card);
    // 这里**不能**因为收口就清 countedItemIds:app-server 允许 turn/completed 先发、后台
    // 收尾的 item/completed 随后才到(codex/index.ts 的终态墓碑注释写明了这个顺序)。清掉
    // 之后那条迟到的 completed 会被当成一个新工具再加一次,卡片最终工具数虚高(review)。
    // 去重登记改为跟卡同生命周期(dropCard 时随卡一起释放),只按条数封顶防长跑子代理无界增长。
    return {
      taskId: card.taskId,
      status,
      ...(card.agentPath ? { agentPath: card.agentPath } : {}),
      ...(model !== undefined ? { model } : {}),
      totalTokens,
      toolUses: card.toolUses,
      durationMs: Math.max(0, now() - card.startedAt),
    };
  };

  const pruneCards = (): void => {
    if (cards.size < maxTrackedCards) return;
    for (const [taskId, card] of cards) {
      if (isTerminal(aggregateStatus(card))) {
        dropCard(taskId);
        return;
      }
    }
    // 全在跑:淘汰最早插入的一张(Map 保序)。宁可丢最老的实时数据也不无界增长。
    const oldest = cards.keys().next();
    if (!oldest.done) dropCard(oldest.value);
  };

  const dropCard = (taskId: string): void => {
    const card = cards.get(taskId);
    if (card) {
      for (const childThreadId of card.threads.keys()) {
        if (taskIdByThread.get(childThreadId) === taskId) taskIdByThread.delete(childThreadId);
      }
    }
    cards.delete(taskId);
  };

  /** 把某子线程从它当前归属的卡上解绑(resume / 再 spawn 同线程时改绑到新卡)。 */
  const unbindThread = (childThreadId: string): void => {
    const previousTaskId = taskIdByThread.get(childThreadId);
    if (previousTaskId === undefined) return;
    taskIdByThread.delete(childThreadId);
    const previousCard = cards.get(previousTaskId);
    if (!previousCard) return;
    previousCard.threads.delete(childThreadId);
    if (previousCard.threads.size === 0) cards.delete(previousTaskId);
  };

  const bufferPending = (childThreadId: string, method: string, params: unknown): void => {
    if (!CONSUMED_METHODS.has(method)) return;
    noteFirstSeen(childThreadId);
    let queue = pending.get(childThreadId);
    if (!queue) {
      if (pending.size >= MAX_PENDING_THREADS) {
        // 淘汰最早缓冲的线程(它很可能永远不会被登记 —— 比如不属于任何子代理卡的后代)。
        const oldest = pending.keys().next();
        if (!oldest.done) pending.delete(oldest.value);
      }
      queue = [];
      pending.set(childThreadId, queue);
    }
    if (queue.length >= MAX_PENDING_PER_THREAD) queue.shift();
    queue.push({ method, params });
  };

  /** 记下一条尚未能判断归属的血缘边,等父线程归属后补绑。 */
  const bufferLineage = (childThreadId: string, parentThreadId: string): void => {
    noteFirstSeen(childThreadId);
    let children = pendingLineage.get(parentThreadId);
    if (!children) {
      if (pendingLineage.size >= MAX_PENDING_LINEAGE_PARENTS) {
        // 淘汰最早缓冲的父线程 —— 绝大多数是主线程自己的后代,永远不会归属任何子代理卡。
        const oldest = pendingLineage.keys().next();
        if (!oldest.done) pendingLineage.delete(oldest.value);
      }
      children = new Set<string>();
      pendingLineage.set(parentThreadId, children);
    }
    if (children.size >= MAX_PENDING_LINEAGE_CHILDREN && !children.has(childThreadId)) return;
    children.add(childThreadId);
  };

  const noteObservedLiveTurn = (thread: ThreadState, turnId: string | undefined): void => {
    if (!turnId || thread.tokenUsageBaseline !== undefined || thread.observedLiveTurnIds.has(turnId)) return;
    if (thread.observedLiveTurnIds.size >= MAX_OBSERVED_LIVE_TURN_IDS) {
      const oldest = thread.observedLiveTurnIds.values().next();
      if (!oldest.done) thread.observedLiveTurnIds.delete(oldest.value);
    }
    thread.observedLiveTurnIds.add(turnId);
  };

  const updateThreadModel = (
    thread: ThreadState,
    observation: ThreadModelObservation | undefined,
  ): boolean => {
    if (!observation) return false;
    if (
      lockSubagentModel
      && thread.modelSource === 'configured'
      && observation.source === 'runtime'
    ) return false;
    const previousPriority = thread.modelSource === undefined
      ? -1
      : MODEL_SOURCE_PRIORITY[thread.modelSource];
    const nextPriority = MODEL_SOURCE_PRIORITY[observation.source];
    if (
      nextPriority < previousPriority
      || (nextPriority === previousPriority && observation.source !== 'runtime')
    ) return false;
    const changed = thread.model !== observation.model;
    thread.model = observation.model;
    thread.modelSource = observation.source;
    return changed;
  };

  const bufferThreadModel = (
    childThreadId: string,
    observation: ThreadModelObservation,
  ): void => {
    const previous = pendingThreadModels.get(childThreadId);
    if (
      previous
      && (
        MODEL_SOURCE_PRIORITY[previous.source] > MODEL_SOURCE_PRIORITY[observation.source]
        || (
          previous.source === observation.source
          && observation.source !== 'runtime'
        )
      )
    ) return;
    if (!previous && pendingThreadModels.size >= MAX_PENDING_THREAD_MODELS) {
      const oldest = pendingThreadModels.keys().next();
      if (!oldest.done) pendingThreadModels.delete(oldest.value);
    }
    pendingThreadModels.set(childThreadId, observation);
  };

  /** 应用一条通知到卡上;返回是否产生了变化(无变化不必发帧)。 */
  const applyNotification = (
    card: TrackedCard,
    thread: ThreadState,
    method: string,
    params: unknown,
  ): boolean => {
    switch (method) {
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const itemParams = params as {
          turnId?: unknown;
          item?: { type?: unknown; id?: unknown };
        } | null;
        const itemTurnId = typeof itemParams?.turnId === 'string' ? itemParams.turnId : undefined;
        // app-server 不会把历史 item 重放成 live 通知；即使 turn/started 丢失，item 也能
        // 证明这个 turn 已经真实开跑，避免把随后到来的 live usage 误判成恢复帧。
        noteObservedLiveTurn(thread, itemTurnId);
        const item = itemParams?.item;
        const itemType = typeof item?.type === 'string' ? item.type : '';
        const itemId = typeof item?.id === 'string' ? item.id : '';
        if (!itemId || !TOOL_ITEM_TYPES.has(itemType)) return false;
        if (card.countedItemIds.has(itemId)) return false;
        // 按插入序淘汰最老的 id(Set 保序)。上限远大于任何真实迟到窗口 —— 被淘汰的 id 只在
        // "几千个工具调用之前那一条的 completed 现在才到"时才会重复计数,现实中不发生。
        if (card.countedItemIds.size >= MAX_COUNTED_ITEM_IDS) {
          const oldest = card.countedItemIds.values().next();
          if (!oldest.done) card.countedItemIds.delete(oldest.value);
        }
        card.countedItemIds.add(itemId);
        card.toolUses += 1;
        return true;
      }
      case 'thread/tokenUsage/updated': {
        const usageParams = params as {
          turnId?: unknown;
          tokenUsage?: {
            total?: { totalTokens?: unknown };
            last?: { totalTokens?: unknown };
          };
        } | null;
        const total = usageParams?.tokenUsage?.total?.totalTokens;
        if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return false;
        const usageTurnId = typeof usageParams?.turnId === 'string' ? usageParams.turnId : undefined;
        const last = usageParams?.tokenUsage?.last?.totalTokens;

        // 旧宿主只给 total（即使附带 turnId），没有 last 就无法从第一帧反推出 spawn 水位。
        // 这种载荷保持既有绝对快照语义；当前 app-server 的恢复帧与 live 帧都会带 last。
        if (thread.tokenUsageBaseline === undefined && last === undefined) {
          if (thread.totalTokens === total) return false;
          thread.totalTokens = total;
          return true;
        }

        // fork / resume 会在子线程第一个 live turn 之前重放恢复后的 usage。它的 total 是
        // 父线程历史 + 子线程增量的绝对累计值；若直接展示，就会把整段父会话历史算到卡上。
        // live 用量通知带当前 turnId，恢复帧没有对应的 live turn / item（或 id 不同），
        // 所以只把它记成基线而不产可见帧。无 turnId 的旧宿主载荷沿用原来的绝对快照口径。
        if (
          usageTurnId
          && !thread.observedLiveTurnIds.has(usageTurnId)
          && thread.tokenUsageBaseline === undefined
        ) {
          thread.tokenUsageBaseline = total;
          thread.observedLiveTurnIds.clear();
          return false;
        }
        if (!usageTurnId && thread.observedLiveTurnIds.size === 0) {
          if (thread.totalTokens === total) return false;
          thread.totalTokens = total;
          return true;
        }

        if (thread.tokenUsageBaseline === undefined) {
          // 若宿主或 fork 配置没先发恢复帧，用本次 live 增量反推出 spawn 前水位。协议缺
          // last 时宁可从当前 total 起算（本帧显示 0），也不要再次把继承历史误报成用量。
          thread.tokenUsageBaseline = typeof last === 'number'
            && Number.isFinite(last)
            && last >= 0
            && last <= total
            ? total - last
            : total;
          thread.observedLiveTurnIds.clear();
        }
        const relativeTotal = Math.max(0, total - thread.tokenUsageBaseline);
        // total 是累计快照，乱序旧帧或重复恢复帧都不能让卡片数字回退。
        if (relativeTotal <= thread.totalTokens) return false;
        thread.totalTokens = relativeTotal;
        return true;
      }
      case 'turn/started': {
        const turnId = (params as { turn?: { id?: unknown } } | null)?.turn?.id;
        noteObservedLiveTurn(thread, typeof turnId === 'string' ? turnId : undefined);
        // nested spawn 的失败闩可能早于迟到的 turn/started；状态仍须保持 failed，但 live
        // turn 身份必须先留下，后续 usage 才不会被误判成 fork / resume 的恢复快照。
        if (thread.spawnFailed) return false;
        thread.status = 'running';
        return true;
      }
      case 'turn/completed': {
        if (thread.spawnFailed) return false;
        const turnStatus = (params as { turn?: { status?: unknown } } | null)?.turn?.status;
        thread.status = turnStatus === 'failed'
          ? 'failed'
          : turnStatus === 'interrupted'
            ? 'stopped'
            : turnStatus === 'inProgress'
              ? 'running'
              : 'completed';
        return true;
      }
      default:
        return false;
    }
  };

  /**
   * 把一个子线程并入卡:绑定 → 重放它的早到通知 → **递归**补绑它在归属前自己派出的后代。
   *
   * 递归是必需的,不是保险:孙线程的 spawn item 只出现在子线程自己的事件流里,主线程的
   * itemStarted 钩子永远看不到,所以除了这条路径没有别的机会把孙线程并进卡。
   *
   * `visited` 防环:血缘理论上是树,但通知来自外部进程,不能假定它一定是树。
   * 返回是否有可见快照变化:早到通知被重放,或实际模型在本次绑定时首次落到线程上。
   */
  const attachThread = (
    card: TrackedCard,
    childThreadId: string,
    visited: Set<string>,
    spawnModel?: string,
    spawnModelSource: ThreadModelSource = 'inherited',
    spawnFailed = false,
    inheritedModel?: string,
  ): boolean => {
    if (visited.has(childThreadId)) return false;
    visited.add(childThreadId);

    if (taskIdByThread.get(childThreadId) !== card.taskId) unbindThread(childThreadId);
    const failedBeforeAttachment = pendingFailedThreads.delete(childThreadId);
    const latchSpawnFailure = spawnFailed || failedBeforeAttachment;
    let changed = false;
    if (!card.threads.has(childThreadId)) {
      const observedModel = pendingThreadModels.get(childThreadId);
      pendingThreadModels.delete(childThreadId);
      const lockedSpawnModel = lockSubagentModel && spawnModelSource === 'configured'
        ? { model: spawnModel, source: spawnModelSource }
        : undefined;
      const initialObservation = lockedSpawnModel?.model
        ? lockedSpawnModel
        : observedModel
          ?? (spawnModel
            ? { model: spawnModel, source: spawnModelSource }
            : inheritedModel
              ? { model: inheritedModel, source: 'inherited' as const }
              : undefined);
      const initialModel = initialObservation?.model;
      const initialModelSource = initialObservation?.source;
      // spawn item 自己携带的显式/默认/继承模型会由 translator 合并进原有启动帧；
      // 只有 spawn 到达前已经观测到的实际模型才需要在登记后额外重放。
      changed = Boolean(observedModel);
      // 已上终态闩的卡,新并入的线程直接算失败,别让它把卡拉回 running。
      card.threads.set(childThreadId, {
        status: card.spawnFailed || latchSpawnFailure ? 'failed' : 'running',
        totalTokens: 0,
        observedLiveTurnIds: new Set<string>(),
        ...(initialModel ? { model: initialModel } : {}),
        ...(initialModelSource ? { modelSource: initialModelSource } : {}),
        spawnFailed: latchSpawnFailure,
      });
    } else if (spawnModel) {
      changed = updateThreadModel(card.threads.get(childThreadId)!, {
        model: spawnModel,
        source: spawnModelSource,
      }) || changed;
    }
    taskIdByThread.set(childThreadId, card.taskId);
    const thread = card.threads.get(childThreadId)!;
    if (latchSpawnFailure) {
      thread.spawnFailed = true;
      thread.status = 'failed';
    }

    const queued = pending.get(childThreadId);
    if (queued) {
      pending.delete(childThreadId);
      for (const entry of queued) {
        if (applyNotification(card, thread, entry.method, entry.params)) changed = true;
      }
    }

    const descendants = pendingLineage.get(childThreadId);
    if (descendants) {
      pendingLineage.delete(childThreadId);
      for (const grandChildId of descendants) {
        if (attachThread(card, grandChildId, visited, undefined, 'inherited', false, thread.model)) changed = true;
      }
    }
    return changed;
  };

  return {
    noteSpawnItem(
      item: unknown,
      inheritedModel?: string,
      phase: SubagentSpawnItemPhase = 'started',
    ): SubagentLiveCardUpdate | null {
      const registration = readCodexSubagentSpawnRegistration(item);
      if (!registration) return null;
      // 锁定路由存在时，配置模型就是 Proxy 最终出站模型。Codex thread 元数据仍只会
      // 报告创建阶段继承的父模型，不能把它当作运行时事实覆盖配置。未锁定时保持原生
      // 优先级：显式参数 > 配置兜底 > 父线程继承，后续真实观测仍可覆盖。
      const spawnModel = lockSubagentModel
        ? subagentModelFallback
        : registration.model ?? subagentModelFallback ?? inheritedModel;
      const spawnModelSource: ThreadModelSource | undefined = lockSubagentModel
        ? 'configured'
        : registration.model
          ? 'explicit'
          : subagentModelFallback
            ? 'configured'
            : inheritedModel
              ? 'inherited'
              : undefined;

      const existing = cards.get(registration.taskId);
      const card: TrackedCard = existing ?? {
        taskId: registration.taskId,
        ...(registration.agentPath ? { agentPath: registration.agentPath } : {}),
        startedAt: earliestSeen(registration.childThreadIds),
        toolUses: 0,
        countedItemIds: new Set<string>(),
        threads: new Map<string, ThreadState>(),
        spawnFailed: false,
      };
      if (!existing) {
        pruneCards();
        cards.set(card.taskId, card);
      }

      // spawn **本身**收口为失败:translator 已推过 failed 帧,这里绝不能再补一帧聚合快照
      // —— 那时子线程还标着 running,会把真实的失败终态盖回成运行中。上终态闩(而不是只把
      // 当下已知的线程标 failed):迟到的 turn/started / turn/completed 会把线程状态改回
      // running/completed,只标线程状态挡不住(review)。闩上之后仍继续吸收 token / 工具计数
      // —— 派发失败但子线程已经烧掉的量该算进去,只是状态恒为 failed。
      if (registration.failed) {
        card.spawnFailed = true;
        const visited = new Set<string>();
        let replayedOnFailure = false;
        for (const childThreadId of registration.childThreadIds) {
          if (attachThread(card, childThreadId, visited, spawnModel, spawnModelSource)) replayedOnFailure = true;
          const thread = card.threads.get(childThreadId);
          if (thread) thread.status = 'failed';
        }
        // started phase 缺失或晚到时,子线程的工具/token 通知会先进缓冲、由上面的 attachThread
        // 重放出来;若此后再无通知,无条件返回 null 就意味着这些用量永远不显示 —— 而 translator
        // 的 failed 帧本身不带 usage(review)。有了 spawnFailed 闩,snapshot() 恒为 failed,
        // 补发这一帧不会重现"把失败盖回运行中"的老问题。
        return replayedOnFailure ? snapshot(card) : null;
      }

      const visited = new Set<string>();
      let replayed = false;
      for (const childThreadId of registration.childThreadIds) {
        if (attachThread(card, childThreadId, visited, spawnModel, spawnModelSource)) replayed = true;
      }

      // completed 的 agentsStates 是子线程状态证据，无论本卡是刚补建还是 started 阶段
      // 已经存在都必须同步。只在 fresh completed-only 路径处理会漏掉常见的
      // started → completed(done)，shutdown 仍会把它错误持久化成 stopped。
      let terminalObserved = false;
      if (phase === 'completed') {
        const states = (item as { agentsStates?: unknown }).agentsStates;
        const stateByThread = states && typeof states === 'object' && !Array.isArray(states)
          ? states as Record<string, unknown>
          : undefined;
        for (const childThreadId of registration.childThreadIds) {
          const thread = card.threads.get(childThreadId);
          if (!thread || thread.spawnFailed) continue;
          const terminal = stateByThread ? agentStateTerminalStatus(stateByThread[childThreadId]) : undefined;
          if (terminal && terminal !== 'running') {
            thread.status = terminal;
            terminalObserved = true;
          }
        }
      }

      // 已登记过的 spawn(同一 collabAgentToolCall 的 started/completed 两个 phase 都会到
      // 这里)**必须无条件回传快照**:translator 在 completed phase 会无条件推一帧
      // status=completed —— 那是 spawn 工具调用自己收口,不代表子代理跑完。调用方在
      // translator 之后重发本快照,真实聚合状态才不会被那帧合成的 completed 覆盖,否则仍在
      // 跑的子线程会被提前标成完成,先到的 failed/stopped 也会被抹掉。
      // (attachThread 幂等:已在卡上的线程不会被重置计数。)
      if (existing) return snapshot(card);
      // app-server 可能省略 started/updated，首个可见帧直接是 completed。此时
      // collabAgentToolCall 的完成只代表 spawn 工具已返回；agentsStates 仍明确 running
      // 时必须让 tracker 发出 running 快照，覆盖 translator 合成的 completed。
      if (phase === 'completed') {
        if (spawnItemHasRunningAgentState(item)) return snapshot(card);
        if (terminalObserved) return snapshot(card);
      }
      return replayed ? snapshot(card) : null;
    },

    noteDescendantThread(
      childThreadId: string,
      parentThreadId: string,
      model?: string,
      spawnFailed = false,
      inheritParentModel = false,
    ): SubagentLiveCardUpdate | null {
      if (!childThreadId || !parentThreadId || childThreadId === parentThreadId) return null;
      const parentTaskId = taskIdByThread.get(parentThreadId);
      const parentModel = parentTaskId === undefined
        ? undefined
        : cards.get(parentTaskId)?.threads.get(parentThreadId)?.model;
      // 嵌套 spawn 没有显式 model 时遵循同一优先级：个性化默认优先，否则继承直接父线程。
      // 普通 thread/started 观测不走此兜底，避免把“没上报”误当成一次覆盖。
      const effectiveModel = lockSubagentModel
        ? subagentModelFallback
        : model ?? (inheritParentModel ? subagentModelFallback ?? parentModel : undefined);
      const effectiveModelSource: ThreadModelSource | undefined = lockSubagentModel
        ? 'configured'
        : model
          ? inheritParentModel ? 'explicit' : 'runtime'
          : inheritParentModel && subagentModelFallback
            ? 'configured'
            : inheritParentModel && parentModel
              ? 'inherited'
              : undefined;
      const directTaskId = taskIdByThread.get(childThreadId);
      if (directTaskId !== undefined) {
        pendingThreadModels.delete(childThreadId);
        pendingFailedThreads.delete(childThreadId);
        const directCard = cards.get(directTaskId);
        const directThread = directCard?.threads.get(childThreadId);
        if (directCard && directThread) {
          let changed = false;
          if (effectiveModel && effectiveModelSource) {
            changed = updateThreadModel(directThread, {
              model: effectiveModel,
              source: effectiveModelSource,
            }) || changed;
          }
          if (spawnFailed && !directThread.spawnFailed) {
            directThread.spawnFailed = true;
            directThread.status = 'failed';
            changed = true;
          }
          if (changed) return snapshot(directCard);
        }
        return null;
      }
      if (effectiveModel && effectiveModelSource) {
        bufferThreadModel(childThreadId, {
          model: effectiveModel,
          source: effectiveModelSource,
        });
      }
      if (spawnFailed) {
        if (!pendingFailedThreads.has(childThreadId) && pendingFailedThreads.size >= MAX_PENDING_THREAD_MODELS) {
          const oldest = pendingFailedThreads.values().next();
          if (!oldest.done) pendingFailedThreads.delete(oldest.value);
        }
        pendingFailedThreads.add(childThreadId);
      }
      const taskId = parentTaskId;
      if (taskId === undefined) {
        // 父线程还没归属:**不能丢**。它可能只是 spawn item 尚未到达(乱序),而本次血缘正是
        // 孙线程唯一的入卡途径 —— 丢了就再没有第二次机会。先缓冲,父线程归属时递归补绑。
        bufferLineage(childThreadId, parentThreadId);
        return null;
      }
      const card = cards.get(taskId);
      if (!card) return null;
      // 已并入同一张卡:幂等,不重置计数。
      // 新线程并入会改变聚合状态(比如把已显示完成的卡拉回 running —— 孙线程还在跑,卡片就
      // 不该说完成),所以发帧条件不只看有没有重放内容,还看聚合状态是否因此改变。
      const beforeStatus = aggregateStatus(card);
      const beforeModel = aggregateModel(card);
      const replayed = attachThread(
        card,
        childThreadId,
        new Set<string>(),
        effectiveModel,
        effectiveModelSource,
        spawnFailed,
      );
      return replayed
        || aggregateStatus(card) !== beforeStatus
        || aggregateModel(card) !== beforeModel
        ? snapshot(card)
        : null;
    },

    handleDescendantNotification(
      childThreadId: string,
      method: string,
      params: unknown,
    ): SubagentLiveCardUpdate | null {
      const taskId = taskIdByThread.get(childThreadId);
      if (taskId === undefined) {
        // spawn item 还没被处理(乱序):缓冲等重放,别丢掉首个工具调用或终态。
        bufferPending(childThreadId, method, params);
        return null;
      }
      const card = cards.get(taskId);
      const thread = card?.threads.get(childThreadId);
      if (!card || !thread) return null;
      if (!applyNotification(card, thread, method, params)) return null;
      return snapshot(card);
    },

    drainRunningForShutdown(): SubagentLiveCardUpdate[] {
      const out: SubagentLiveCardUpdate[] = [];
      for (const card of cards.values()) {
        if (isTerminal(aggregateStatus(card))) continue;
        // 会话没了不代表子代理"失败"了 —— 它是被中断的,所以报 stopped 而不是 failed。
        // 直接改线程状态而不是在 snapshot 里特判:这样 aggregateStatus 自然收敛到 stopped,
        // 也保住了 spawnFailed 闩的优先级(派发本身失败过的卡仍报 failed)。
        for (const thread of card.threads.values()) {
          if (thread.status === 'running') thread.status = 'stopped';
        }
        if (card.threads.size === 0) {
          // 一个线程都还没登记上的卡(spawn 刚认出、子线程尚未 started):补一个占位线程,
          // 否则 aggregateStatus 对空集合返回 running,这张卡还是会留在转圈状态。
          card.threads.set('__shutdown__', {
            status: 'stopped',
            totalTokens: 0,
            observedLiveTurnIds: new Set<string>(),
            spawnFailed: false,
          });
        }
        out.push(snapshot(card));
      }
      return out;
    },

    clear(): void {
      cards.clear();
      taskIdByThread.clear();
      pending.clear();
      pendingLineage.clear();
      pendingThreadModels.clear();
      pendingFailedThreads.clear();
      firstSeenAt.clear();
    },

    get size(): number {
      return cards.size;
    },
  };
}
