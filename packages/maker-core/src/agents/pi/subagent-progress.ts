/**
 * PI 子代理进度:把工具流式中间结果翻成统一的子代理卡更新。
 *
 * pi 原生没有子代理(上游 usage/security 文档明说刻意不做),社区实现一律是「扩展 + 子
 * pi 进程」。Cindy 不整包引入外部扩展 —— 那会把第三方代码塞进 `pi-harness.md` §4.2 划定
 * 的自包含注入边界,还要跟着上游版本跑。做法是参考社区设计,在 Cindy 自有扩展里重做。
 *
 * 通道选的是 pi 工具**原生的** `onUpdate` 流(→ `tool_execution_update` 事件),不另开
 * 侧信道:
 *  - `tool_execution_start` / `_end` 已由 translator 推成 `tool_use` / `tool_result`,
 *    工具名 `subagent` 命中 `isAgentTaskToolName` → 卡片生命周期本就成立;
 *  - 缺的只是运行期的 tokens / 工具调用数 / 耗时,正好由 `_update` 的 partialResult 带。
 *  - `_update` 此前是空处理,挂进来是纯增量,不改任何既有行为。
 *
 * 卡片本体与 Claude / Codex 子代理共用 `AgentTaskCard`,这里只补齐 pi 侧数据,不引入新
 * 的 UI 概念。
 */

import type { AgentTaskUpdateEventData } from '../../types/events.js';

/** 子代理卡状态(`AgentTaskStatus` 的子集)。 */
export type PiSubagentStatus = 'running' | 'completed' | 'failed' | 'stopped';

const STATUSES = new Set<PiSubagentStatus>(['running', 'completed', 'failed', 'stopped']);

/** 单条上报的最大字符数:防子代理把长输出经进度帧灌进事件流。 */
const MAX_TEXT = 2_000;

/** 扩展与本模块共用的载荷标记 —— 扩展源码里逐字使用同一个键名。 */
export const PI_SUBAGENT_PROGRESS_MARKER = '__cindySubagent';

/**
 * 子代理的**累计**用量分量(与 pi 自己的 `message_end.usage` 同形)。
 *
 * 子代理是独立 pi 进程,它的请求不经过父进程的 usage 流 —— 不显式并进来,父 turn 的记账
 * 与 register.ts 持久化的 session token/cost 就会漏掉全部委派用量(review)。
 */
export interface PiSubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/**
 * parse 结果:卡片更新 + 可选的委派用量。
 *
 * 字段刻意叫 `delegatedUsage` 而不是 `usage`:`update.usage` 已经是**卡片**要显示的
 * {totalTokens, toolUses, durationMs},两个都叫 usage 极易读错(我自己在改测试时就先踩了
 * 一次)。这里是给父 turn 记账用的 token/cost 分量,语义完全不同。
 */
export interface PiSubagentProgress {
  update: AgentTaskUpdateEventData;
  /** 累计值,不是增量。调用方按 taskId 记住上次值再作差。 */
  delegatedUsage?: PiSubagentUsage;
}

function readUsage(value: unknown): PiSubagentUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const read = (key: string): number => {
    const n = raw[key];
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  };
  const usage: PiSubagentUsage = {
    input: read('input'),
    output: read('output'),
    cacheRead: read('cacheRead'),
    cacheWrite: read('cacheWrite'),
    cost: read('cost'),
  };
  // 全零就当没有:避免为无意义的帧在父侧建立 taskId 记账条目。
  if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost) {
    return undefined;
  }
  return usage;
}

function readString(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function readCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * 从 `tool_execution_update` 的 partialResult 里取子代理进度。
 *
 * 入参是工具中间结果本体(`{ content?, details? }`);标记与数据都在 `details` 下。
 * 返回 null = 与子代理无关(别的工具在流式、载荷不带标记、缺 taskId),调用方原样忽略。
 *
 * 刻意不猜:状态不在白名单内一律按 running,而不是编造终态 —— 把仍在跑的子代理显示成
 * 已完成比没有状态更糟。
 */
export function parsePiSubagentProgress(partialResult: unknown): PiSubagentProgress | null {
  const raw = readProgressDetails(partialResult);
  if (!raw) return null;

  // taskId 是卡片/tool_use 的关联键,**只 trim 不截断**:截断+省略号会改写 id,
  // 后续 update 再也命中不到同一张卡(表现为卡片不更新或另开一张)。
  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : '';
  if (!taskId) return null;

  const status: PiSubagentStatus = STATUSES.has(raw.status as PiSubagentStatus)
    ? (raw.status as PiSubagentStatus)
    : 'running';

  const totalTokens = readCount(raw.totalTokens);
  const toolUses = readCount(raw.toolUses);
  const durationMs = readCount(raw.durationMs);
  const usage = totalTokens !== undefined || toolUses !== undefined || durationMs !== undefined
    ? {
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(toolUses !== undefined ? { toolUses } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }
    : undefined;

  const title = readString(raw.agentName, 96);
  const description = readString(raw.task);
  const summary = readString(raw.summary);
  const model = readString(raw.model, 200);

  const delegatedUsage = readUsage(raw.usage);

  return {
    update: {
      provider: 'pi',
      taskId,
      parentToolUseId: taskId,
      status,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(summary ? { summary } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
    },
    ...(delegatedUsage ? { delegatedUsage } : {}),
  };
}

function readProgressDetails(partialResult: unknown): Record<string, unknown> | null {
  if (!partialResult || typeof partialResult !== 'object' || Array.isArray(partialResult)) return null;
  const details = (partialResult as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const raw = details as Record<string, unknown>;
  // 标记必须逐字命中:别的工具流式上报恰好带 details 时不得被误认成子代理进度。
  if (raw[PI_SUBAGENT_PROGRESS_MARKER] !== 1) return null;
  return raw;
}
