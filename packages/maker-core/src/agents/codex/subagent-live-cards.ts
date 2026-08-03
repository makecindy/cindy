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
 * 两条容易踩空的语义,单测各有覆盖:
 *  - **一次 spawn 可能扇出多个子线程**(V1 `spawnAgent` 的 `receiverThreadIds`),但它们
 *    共用同一张卡。聚合状态必须挂在 taskId 上、按 thread 分量累计,否则各线程用自己的
 *    计数器发同一个 taskId,后到的快照会把先到的覆盖成更小的值(token/工具数回退),
 *    且任一 sibling 先收口就会把整张卡误报成完成。
 *  - **通知可能早于 spawn 登记到达**(子线程 `thread/started` 建立 lineage 后,父线程的
 *    spawn item 还没被处理)。这类通知先缓冲,登记后重放,否则首个工具调用、初始 token
 *    甚至终态会永久缺失。
 *
 * 设计约束:
 * - **纯聚合、零 IO**:落在 translator/event-loop 热路径上,每条通知只做 Map 查 + 计数。
 * - **有界**:跟踪条目与缓冲都封顶,长会话大量 spawn 不无界增长。
 * - **不猜**:认不出的 method / item 一律忽略并返回 null,不合成任何状态。
 */

import { readCodexSubagentSpawnRegistration } from './translator.js';

export type SubagentLiveCardStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** 一次聚合结果:调用方据此发 `agent_task_update`(字段与 `AgentTaskUsage` 对齐)。 */
export interface SubagentLiveCardUpdate {
  taskId: string;
  status: SubagentLiveCardStatus;
  agentPath?: string;
  /** 本卡全部子线程的累计 token 之和;未知为 0。 */
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
   * 声明一次(两种情形:有早到通知被重放出状态;或该 spawn 已登记 —— 此时 translator 的
   * 合成 `completed` 帧必须被真实聚合状态盖回去)。返回 null = 非 spawn item。
   */
  noteSpawnItem(item: unknown): SubagentLiveCardUpdate | null;
  /**
   * 登记「子线程 → 其父线程」的血缘(host 的 `descendantThreadStarted` 对**每一代**都触发)。
   *
   * 嵌套子代理必须靠它:孙线程的 spawn item 出现在**子线程自己**的事件流里,主线程的
   * itemStarted 钩子永远看不到,所以 noteSpawnItem 不可能登记孙线程。父线程已归属某张卡时,
   * 把子线程并入同一张卡并重放其早到缓冲;父线程与子代理无关时无副作用。
   *
   * 返回聚合快照 = 有早到通知被重放出状态,调用方应发一帧;否则 null。
   */
  noteDescendantThread(childThreadId: string, parentThreadId: string): SubagentLiveCardUpdate | null;
  /**
   * 消费一条子线程通知。返回聚合快照表示卡片需要刷新;返回 null = 与子代理卡无关
   * (不关心的 method、无效载荷),或该子线程尚未登记(已缓冲,等 spawn 到达后重放)。
   */
  handleDescendantNotification(
    childThreadId: string,
    method: string,
    params: unknown,
  ): SubagentLiveCardUpdate | null;
  /** 会话收口时清空(与 descendant MCP context 注销同点调用)。 */
  clear(): void;
  /** 诊断/测试用:当前跟踪的子代理卡数。 */
  readonly size: number;
}

/** 计入「工具调用次数」的子线程 item 类型(排除 agentMessage / reasoning / plan 等非工具产出)。 */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'fileChange',
  'imageView',
  'imageGeneration',
  'collabAgentToolCall',
]);

/** 我们会消费的 method —— 只有这些值得在 spawn 登记前缓冲。 */
const CONSUMED_METHODS = new Set([
  'item/started',
  'item/completed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
]);

const DEFAULT_MAX_TRACKED_CARDS = 64;
/** 早到通知的缓冲上限(线程数 × 每线程条数),防永不登记的线程无界堆积。 */
const MAX_PENDING_THREADS = 32;
const MAX_PENDING_PER_THREAD = 64;

interface ThreadState {
  status: SubagentLiveCardStatus;
  /** 该子线程最新的**累计** token(tokenUsage.total 是快照,按线程覆盖而非相加)。 */
  totalTokens: number;
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
}

interface PendingNotification {
  method: string;
  params: unknown;
}

export function createSubagentLiveCardTracker(opts: {
  now?: () => number;
  maxTrackedCards?: number;
} = {}): SubagentLiveCardTracker {
  const now = opts.now ?? (() => Date.now());
  const maxTrackedCards = opts.maxTrackedCards ?? DEFAULT_MAX_TRACKED_CARDS;
  const cards = new Map<string, TrackedCard>();
  const taskIdByThread = new Map<string, string>();
  const pending = new Map<string, PendingNotification[]>();

  const isTerminal = (status: SubagentLiveCardStatus): boolean => status !== 'running';

  const aggregateStatus = (card: TrackedCard): SubagentLiveCardStatus => {
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

  const snapshot = (card: TrackedCard): SubagentLiveCardUpdate => {
    let totalTokens = 0;
    for (const thread of card.threads.values()) totalTokens += thread.totalTokens;
    const status = aggregateStatus(card);
    // 全部收口后释放本卡的 item 登记(计数值保留),长跑子代理不把 id 攒到会话结束。
    if (isTerminal(status)) card.countedItemIds.clear();
    return {
      taskId: card.taskId,
      status,
      ...(card.agentPath ? { agentPath: card.agentPath } : {}),
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

  /** 应用一条通知到卡上;返回是否产生了变化(无变化不必发帧)。 */
  const applyNotification = (
    card: TrackedCard,
    thread: ThreadState,
    method: string,
    params: unknown,
  ): boolean => {
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const item = (params as { item?: { type?: unknown; id?: unknown } } | null)?.item;
        const itemType = typeof item?.type === 'string' ? item.type : '';
        const itemId = typeof item?.id === 'string' ? item.id : '';
        if (!itemId || !TOOL_ITEM_TYPES.has(itemType)) return false;
        if (card.countedItemIds.has(itemId)) return false;
        card.countedItemIds.add(itemId);
        card.toolUses += 1;
        return true;
      }
      case 'thread/tokenUsage/updated': {
        const total = (params as { tokenUsage?: { total?: { totalTokens?: unknown } } } | null)
          ?.tokenUsage?.total?.totalTokens;
        if (typeof total !== 'number' || !Number.isFinite(total)) return false;
        // total 是该线程的累计快照 → 覆盖本线程分量,卡片总量由各线程求和。
        thread.totalTokens = total;
        return true;
      }
      case 'turn/started':
        thread.status = 'running';
        return true;
      case 'turn/completed': {
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

  return {
    noteSpawnItem(item: unknown): SubagentLiveCardUpdate | null {
      const registration = readCodexSubagentSpawnRegistration(item);
      if (!registration) return null;

      const existing = cards.get(registration.taskId);
      // 同一 spawn 的 started/completed 两个 phase 都会走到这里:已登记且线程集合一致
      // 就不重置计数(否则第二个 phase 会把已聚合的用量清零)。但**必须回传当前快照** ——
      // V1 的 spawn 是 collabAgentToolCall,translator 在 completed phase 会无条件推一帧
      // status=completed(那是 spawn 工具调用自己收口,不代表子代理跑完)。调用方在
      // translator 之后重发本快照,真实聚合状态才不会被那帧合成的 completed 覆盖 ——
      // 否则仍在跑的子线程会被提前标成完成,先到的 failed/stopped 也会被抹掉。
      if (
        existing
        && registration.childThreadIds.every((childThreadId) => existing.threads.has(childThreadId))
      ) {
        return snapshot(existing);
      }

      const card: TrackedCard = existing ?? {
        taskId: registration.taskId,
        ...(registration.agentPath ? { agentPath: registration.agentPath } : {}),
        startedAt: now(),
        toolUses: 0,
        countedItemIds: new Set<string>(),
        threads: new Map<string, ThreadState>(),
      };
      if (!existing) {
        pruneCards();
        cards.set(card.taskId, card);
      }

      let replayed = false;
      for (const childThreadId of registration.childThreadIds) {
        if (taskIdByThread.get(childThreadId) !== card.taskId) unbindThread(childThreadId);
        if (!card.threads.has(childThreadId)) {
          card.threads.set(childThreadId, { status: 'running', totalTokens: 0 });
        }
        taskIdByThread.set(childThreadId, card.taskId);

        // 早到通知重放:登记前到达的 item / tokenUsage / turn 事件在此补进聚合。
        const queued = pending.get(childThreadId);
        if (!queued) continue;
        pending.delete(childThreadId);
        const thread = card.threads.get(childThreadId)!;
        for (const entry of queued) {
          if (applyNotification(card, thread, entry.method, entry.params)) replayed = true;
        }
      }

      return replayed ? snapshot(card) : null;
    },

    noteDescendantThread(childThreadId: string, parentThreadId: string): SubagentLiveCardUpdate | null {
      if (!childThreadId || !parentThreadId || childThreadId === parentThreadId) return null;
      // 父线程不属于任何子代理卡 → 与子代理无关(例如主线程自己的后代未经 spawn 登记)。
      const taskId = taskIdByThread.get(parentThreadId);
      if (taskId === undefined) return null;
      const card = cards.get(taskId);
      if (!card) return null;
      // 已并入同一张卡:幂等,不重置计数。
      if (taskIdByThread.get(childThreadId) === taskId && card.threads.has(childThreadId)) return null;

      if (taskIdByThread.get(childThreadId) !== taskId) unbindThread(childThreadId);
      if (!card.threads.has(childThreadId)) {
        card.threads.set(childThreadId, { status: 'running', totalTokens: 0 });
      }
      taskIdByThread.set(childThreadId, taskId);

      // 孙线程的通知可能早于本次血缘登记到达(已缓冲),在此补进聚合。
      const queued = pending.get(childThreadId);
      if (!queued) return null;
      pending.delete(childThreadId);
      const thread = card.threads.get(childThreadId)!;
      let replayed = false;
      for (const entry of queued) {
        if (applyNotification(card, thread, entry.method, entry.params)) replayed = true;
      }
      return replayed ? snapshot(card) : null;
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

    clear(): void {
      cards.clear();
      taskIdByThread.clear();
      pending.clear();
    },

    get size(): number {
      return cards.size;
    },
  };
}
