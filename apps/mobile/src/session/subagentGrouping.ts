/**
 * 真·子 agent 嵌套分组(手机端净新能力,桌面没有)。
 *
 * 用已下发到手机的 `agentMeta.parentUuid`(= SDK 的 `parent_tool_use_id`)把子 agent(`Agent` 工具派生)
 * 的内层消息按父子折叠成嵌套卡片。坐实自真实 desktop DB:`Agent` tool_use 的 `tool_use_id` == 其内层
 * 消息的 `agentMeta.parentUuid`;Agent 的最终 tool_result(子 agent 终稿)经 tool_use_id 配对;codex
 * 无 parentUuid → 自然不触发;嵌套真实存在(深度通常 1,极少 2)。
 *
 * 纯函数,可单测。归一化 / 分桶不靠模型判断(规则 9):全程按 parentUuid 精确归属 + createdAt 定序。
 */
import {
  buildMessageRenderItems,
  type MessageRenderOptions,
} from '@cindy/maker-shared/message-render';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import type { RemoteMessage } from '@/session/types';
import type { MobileMessageRenderItem, MobileSubagentGroupItem } from '@/session/messageRenderModel';

// 子 agent 派生工具名(坐实:本仓库叫 Agent,不是 Task)。
const SUBAGENT_TOOL_NAME = 'Agent';
// 递归深度上限,防异常数据(理论环)爆栈;真实深度通常 1。
export const MAX_SUBAGENT_NEST_DEPTH = 5;

export interface SubagentResultMeta {
  createdAtMs: number;
}

/** 从原始消息建 `toolUseId → tool_result.createdAt(ms)` 映射(归一化层会丢弃 tool_result,故从 raw 取)。 */
export function buildSubagentResultMeta(messages: readonly RemoteMessage[]): Map<string, SubagentResultMeta> {
  const map = new Map<string, SubagentResultMeta>();
  for (const message of messages) {
    if (message.role !== 'tool_result') continue;
    const id = rawToolUseId(message);
    if (!id) continue;
    const ms = Date.parse(message.createdAt);
    if (Number.isFinite(ms)) map.set(id, { createdAtMs: ms });
  }
  return map;
}

/** 是否存在子 agent(Agent tool_use)——不存在时上层走原始路径,行为与改动前完全一致。 */
export function hasSubagentMessages(normalized: readonly NormalizedRemoteMessage[]): boolean {
  return normalized.some(isAgentToolUse);
}

/**
 * 把归一化消息按 parentUuid 分桶并构建带 subagent_group 的 render items:
 * 顶层 Agent tool_use 原位替换成 subagent_group,内层 children 递归分组(仍走 work_group/tool_group 折叠)。
 */
export function buildSubagentAwareRenderItems(
  normalized: readonly NormalizedRemoteMessage[],
  resultMeta: ReadonlyMap<string, SubagentResultMeta>,
  options: MessageRenderOptions,
): MobileMessageRenderItem[] {
  // 不变量:每条 normalized 消息在输出里恰好出现一次。
  // 生产是 80 条最近窗口(分页),Agent tool_use 的 createdAt 早于其 children → 窗口边界可能把某子 agent
  // 块劈开:父 Agent 落窗外、children 在窗内。这些 children 的 parentUuid 指向窗外父 → 若仍进桶则成为
  // 永不被消费的孤儿桶、整段消失(F1 内容丢失回归)。故先算窗内真实存在的 Agent id 集合,只有父在窗内
  // 才进桶;父不在窗内的孤儿回退进 topLevel,按 createdAt 自然回到顶层流 flat 渲染(匹配改动前行为)。
  const presentAgentIds = new Set<string>();
  for (const message of normalized) {
    if (!isAgentToolUse(message)) continue;
    const id = normalizedToolUseId(message);
    if (id) presentAgentIds.add(id);
  }

  const byParent = new Map<string, NormalizedRemoteMessage[]>();
  const topLevel: NormalizedRemoteMessage[] = [];
  for (const message of normalized) {
    const parent = parentUuidOf(message);
    if (parent && presentAgentIds.has(parent)) {
      const bucket = byParent.get(parent);
      if (bucket) bucket.push(message);
      else byParent.set(parent, [message]);
    } else {
      // 顶层消息,或父 Agent 不在窗内的孤儿 → flat(绝不丢)。
      topLevel.push(message);
    }
  }
  // 各桶按 createdAt 稳定定序,保证确定性(归一化已大致有序,这里兜底)。
  for (const bucket of byParent.values()) bucket.sort(compareByCreatedAt);

  const consumed = new Set<string>();
  const out = buildLevel(topLevel, byParent, resultMeta, options, 0, consumed);

  // F2 兜底:深度上限(MAX_SUBAGENT_NEST_DEPTH)导致未被任何 subagent_group 消费的桶。真实嵌套 ≤2 够不到
  // cap=5,纯防御异常数据;但绝不 silent drop —— 把这些 children 追加 flat 渲染,保住"恰好出现一次"不变量。
  const leftover: NormalizedRemoteMessage[] = [];
  for (const [parentId, bucket] of byParent) {
    if (!consumed.has(parentId)) leftover.push(...bucket);
  }
  if (leftover.length > 0) {
    leftover.sort(compareByCreatedAt);
    out.push(...buildMessageRenderItems(leftover, options));
  }
  return out;
}

// 单层构建:遇到 Agent tool_use 就 flush 当前 run 并插入 subagent_group;其余消息按 run 喂 shared buildMessageRenderItems。
function buildLevel(
  level: readonly NormalizedRemoteMessage[],
  byParent: ReadonlyMap<string, NormalizedRemoteMessage[]>,
  resultMeta: ReadonlyMap<string, SubagentResultMeta>,
  options: MessageRenderOptions,
  depth: number,
  consumed: Set<string>,
): MobileMessageRenderItem[] {
  const out: MobileMessageRenderItem[] = [];
  let run: NormalizedRemoteMessage[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.push(...buildMessageRenderItems(run, options));
    run = [];
  };
  for (const message of level) {
    if (isAgentToolUse(message) && depth < MAX_SUBAGENT_NEST_DEPTH) {
      flushRun();
      out.push(buildSubagentGroup(message, byParent, resultMeta, options, depth, consumed));
    } else {
      // 深度上限处的 Agent 走 flat(其 children 桶由上层 leftover 兜底 flush,不丢)。
      run.push(message);
    }
  }
  flushRun();
  return out;
}

function buildSubagentGroup(
  agent: NormalizedRemoteMessage,
  byParent: ReadonlyMap<string, NormalizedRemoteMessage[]>,
  resultMeta: ReadonlyMap<string, SubagentResultMeta>,
  options: MessageRenderOptions,
  depth: number,
  consumed: Set<string>,
): MobileSubagentGroupItem {
  const id = normalizedToolUseId(agent);
  if (id) consumed.add(id);
  const children = id ? (byParent.get(id) ?? []) : [];
  const childItems = buildLevel(children, byParent, resultMeta, options, depth + 1, consumed);
  const input = readRecord(readRecord(agent.source.content)?.input);
  const description = readString(input?.description);
  const subagentType = readString(input?.subagent_type);
  const summary = agent.secondaryBody && agent.secondaryBody.trim() ? agent.secondaryBody : null;
  const result = id ? resultMeta.get(id) : undefined;
  const status = computeStatus(
    agent.agentTaskStatus,
    !!result,
    options.isSessionStreaming === true,
  );
  const startMs = Date.parse(agent.createdAt);
  const durationMs = result && Number.isFinite(startMs) && result.createdAtMs >= startMs
    ? result.createdAtMs - startMs
    : undefined;
  return {
    type: 'subagent_group',
    key: `subagent-${id ?? agent.key}`,
    header: { description, subagentType },
    childItems,
    summary,
    status,
    durationMs,
  };
}

// 精确结构化终态优先；存量历史缺字段时保留原有 result/streaming 兼容兜底。
function computeStatus(
  persistedStatus: MobileSubagentGroupItem['status'] | undefined,
  hasResult: boolean,
  streaming: boolean,
): MobileSubagentGroupItem['status'] {
  if (persistedStatus) return persistedStatus;
  if (hasResult) return 'completed';
  return streaming ? 'running' : 'completed';
}

// 注:归一化层把 tool 的 label 逐字节设为原始 toolName(messageNormalize:`tool.toolName || 'tool_use'`),
// 故按 label 命中 'Agent' 等同于按 toolName 命中。若将来 label 被本地化/改格式,此处需改回读 source 的原始 toolName。
function isAgentToolUse(message: NormalizedRemoteMessage): boolean {
  return message.kind === 'tool' && message.label === SUBAGENT_TOOL_NAME;
}

function parentUuidOf(message: NormalizedRemoteMessage): string | null {
  const meta = message.source.agentMeta;
  if (!meta || typeof meta !== 'object') return null;
  const parent = (meta as Record<string, unknown>).parentUuid;
  return typeof parent === 'string' && parent ? parent : null;
}

function normalizedToolUseId(message: NormalizedRemoteMessage): string | null {
  const fromColumn = message.source.toolUseId;
  if (typeof fromColumn === 'string' && fromColumn) return fromColumn;
  const fromContent = readRecord(message.source.content)?.toolUseId;
  return typeof fromContent === 'string' && fromContent ? fromContent : null;
}

function rawToolUseId(message: RemoteMessage): string | null {
  if (typeof message.toolUseId === 'string' && message.toolUseId) return message.toolUseId;
  const fromContent = readRecord(message.content)?.toolUseId;
  return typeof fromContent === 'string' && fromContent ? fromContent : null;
}

function compareByCreatedAt(a: NormalizedRemoteMessage, b: NormalizedRemoteMessage): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  return (a.source.id || a.source.clientId || a.key).localeCompare(b.source.id || b.source.clientId || b.key);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
