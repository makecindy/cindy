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
 * 设计约束:
 * - **纯聚合、零 IO**:落在 translator/event-loop 热路径上,每条通知只做 Map 查 + 计数。
 * - **有界**:跟踪条目数封顶,优先淘汰已收口的最早条目(长会话大量 spawn 不无界增长)。
 * - **不猜**:认不出的 method / item 一律忽略并返回 null,不合成任何状态。
 */

import { readCodexSubagentSpawnRegistration } from './translator.js';

export type SubagentLiveCardStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** 一次聚合结果:调用方据此发 `agent_task_update`(字段与 `AgentTaskUsage` 对齐)。 */
export interface SubagentLiveCardUpdate {
  taskId: string;
  status: SubagentLiveCardStatus;
  agentPath?: string;
  /** 子线程累计 token(thread/tokenUsage/updated 的 total);未知为 0。 */
  totalTokens: number;
  /** 子线程内的工具类 item 数;未知为 0。 */
  toolUses: number;
  durationMs: number;
}

export interface SubagentLiveCardTracker {
  /** 主线程 item 里认出 spawn → 登记「子线程 id → 子代理卡 taskId」。非 spawn 时无副作用。 */
  noteSpawnItem(item: unknown): void;
  /**
   * 消费一条子线程通知。返回聚合快照表示卡片需要刷新;返回 null = 与子代理卡无关
   * (未登记的线程、不关心的 method、无效载荷),调用方直接忽略。
   */
  handleDescendantNotification(
    childThreadId: string,
    method: string,
    params: unknown,
  ): SubagentLiveCardUpdate | null;
  /** 会话收口时清空(与 descendant MCP context 注销同点调用)。 */
  clear(): void;
  /** 诊断/测试用:当前跟踪的子线程数。 */
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

const DEFAULT_MAX_TRACKED_THREADS = 64;

interface TrackedCard {
  taskId: string;
  agentPath?: string;
  startedAt: number;
  toolUses: number;
  totalTokens: number;
  status: SubagentLiveCardStatus;
  /** 已计数的 item id:部分 item 只发 completed(如 imageView),据此防重复计数。 */
  countedItemIds: Set<string>;
}

export function createSubagentLiveCardTracker(opts: {
  now?: () => number;
  maxTrackedThreads?: number;
} = {}): SubagentLiveCardTracker {
  const now = opts.now ?? (() => Date.now());
  const maxTrackedThreads = opts.maxTrackedThreads ?? DEFAULT_MAX_TRACKED_THREADS;
  const cards = new Map<string, TrackedCard>();

  const prune = (): void => {
    if (cards.size < maxTrackedThreads) return;
    for (const [childThreadId, card] of cards) {
      if (card.status !== 'running') {
        cards.delete(childThreadId);
        return;
      }
    }
    // 全在跑:淘汰最早插入的一条(Map 保序)。宁可丢最老的实时数据也不无界增长。
    const oldest = cards.keys().next();
    if (!oldest.done) cards.delete(oldest.value);
  };

  const snapshot = (card: TrackedCard): SubagentLiveCardUpdate => ({
    taskId: card.taskId,
    status: card.status,
    ...(card.agentPath ? { agentPath: card.agentPath } : {}),
    totalTokens: card.totalTokens,
    toolUses: card.toolUses,
    durationMs: Math.max(0, now() - card.startedAt),
  });

  return {
    noteSpawnItem(item: unknown): void {
      const registration = readCodexSubagentSpawnRegistration(item);
      if (!registration) return;
      for (const childThreadId of registration.childThreadIds) {
        const existing = cards.get(childThreadId);
        // 同一 spawn 的 started/completed 两个 phase 都会走到这里,已登记就不重置计数。
        if (existing && existing.taskId === registration.taskId) continue;
        prune();
        // 同一子线程被 resume / 再次 spawn 时改绑到最新那张卡,计数从新卡重新起算。
        cards.set(childThreadId, {
          taskId: registration.taskId,
          ...(registration.agentPath ? { agentPath: registration.agentPath } : {}),
          startedAt: now(),
          toolUses: 0,
          totalTokens: 0,
          status: 'running',
          countedItemIds: new Set(),
        });
      }
    },

    handleDescendantNotification(
      childThreadId: string,
      method: string,
      params: unknown,
    ): SubagentLiveCardUpdate | null {
      const card = cards.get(childThreadId);
      if (!card) return null;
      switch (method) {
        case 'item/started':
        case 'item/completed': {
          const item = (params as { item?: { type?: unknown; id?: unknown } } | null)?.item;
          const itemType = typeof item?.type === 'string' ? item.type : '';
          const itemId = typeof item?.id === 'string' ? item.id : '';
          if (!itemId || !TOOL_ITEM_TYPES.has(itemType)) return null;
          if (card.countedItemIds.has(itemId)) return null;
          card.countedItemIds.add(itemId);
          card.toolUses += 1;
          break;
        }
        case 'thread/tokenUsage/updated': {
          const total = (params as { tokenUsage?: { total?: { totalTokens?: unknown } } } | null)
            ?.tokenUsage?.total?.totalTokens;
          if (typeof total !== 'number' || !Number.isFinite(total)) return null;
          card.totalTokens = total;
          break;
        }
        case 'turn/started':
          card.status = 'running';
          break;
        case 'turn/completed': {
          const turnStatus = (params as { turn?: { status?: unknown } } | null)?.turn?.status;
          card.status = turnStatus === 'failed'
            ? 'failed'
            : turnStatus === 'interrupted'
              ? 'stopped'
              : turnStatus === 'inProgress'
                ? 'running'
                : 'completed';
          // 收口即释放本轮 item 登记(计数值保留),长跑子代理不把 id 攒到会话结束。
          if (card.status !== 'running') card.countedItemIds.clear();
          break;
        }
        default:
          return null;
      }
      return snapshot(card);
    },

    clear(): void {
      cards.clear();
    },

    get size(): number {
      return cards.size;
    },
  };
}
