import { createHash, type Hash } from 'node:crypto';

/**
 * 第 1 层(快路径,零误判):连续多少次 name+input+output 完全一字不差,判死循环。
 * output 也参与, 所以只会抓"同工具同参数同输出"的机械重复, 轮询(输出在变)不会误判。
 */
const DEFAULT_CONSECUTIVE_LIMIT = 4;
/**
 * 第 2 层(核心):按 name+input 指纹(不含 output)维护的滑动窗口大小。
 * 配合 distinct 阈值抓两类第 1 层抓不到的循环:
 *   - output 每次都变的重复(p4 / 带时间戳的命令反复跑);
 *   - ABAB 交替的 ping-pong(模型在两三个调用间来回打转)。
 * 12 ≈ OpenHands Stuck Detector 的 6-cycle ping-pong 阈值。
 */
const DEFAULT_WINDOW_SIZE = 12;
/** 第 2 层:窗口填满后, distinct 指纹数 ≤ 此值即判循环(2 = 一直在 ≤2 种调用里转)。 */
const DEFAULT_WINDOW_DISTINCT_LIMIT = 2;
/**
 * 第 3 层(兜底):单个 user turn 内 tool result 总数硬上限。
 * 不做任何指纹判断, 对一切循环形态有效, 纯粹防止烧爆 context / token。
 * 设得高, 正常复杂任务一个 turn 调几十个工具很常见, 这里只兜"绝不可能是正常行为"。
 */
const DEFAULT_TURN_HARD_CAP = 100;

interface PendingToolUse {
  name: string;
  input: unknown;
}

export interface ToolLoopGuardOptions {
  /** 第 1 层:连续完全相同(name+input+output)多少次判循环。 */
  consecutiveLimit?: number;
  /** 第 2 层:name+input 滑动窗口大小。 */
  windowSize?: number;
  /** 第 2 层:窗口内 distinct 指纹 ≤ 此值判循环。 */
  windowDistinctLimit?: number;
  /** 第 3 层:单 turn tool result 总数硬上限。 */
  turnHardCap?: number;
}

/** 命中哪一层判据。consecutive=机械重复 / pingpong=交替或输出易变的重复 / turn-cap=硬上限兜底。 */
export type ToolLoopReason = 'consecutive' | 'pingpong' | 'turn-cap';

export type ToolLoopGuardVerdict =
  | { kind: 'ok' }
  | { kind: 'hard'; reason: ToolLoopReason; count: number; toolName: string };

/**
 * Result-aware tool loop detector(三层防御)。
 *
 * 只在工具结果返回后计数。三层任一命中即返回 hard, 由调用方决定如何中断:
 *   1. 连续完全相同(name+input+output)—— 快路径, 零误判;
 *   2. name+input 滑动窗口多样性坍缩 —— 抓 ABAB 交替 / output 易变的重复;
 *   3. 单 turn tool result 硬上限 —— 兜一切形态。
 *
 * 类本身不依赖 Electron / SDK / provider, 也不做 IO;调用方决定何时启用和如何中断。
 */
export class ToolLoopGuard {
  readonly consecutiveLimit: number;
  readonly windowSize: number;
  readonly windowDistinctLimit: number;
  readonly turnHardCap: number;

  private pendingToolUses = new Map<string, PendingToolUse>();

  // 第 1 层状态
  private lastFullFingerprint: string | null = null;
  private consecutiveStreak = 0;

  // 第 2 层状态: 最近 windowSize 个 name+input 指纹
  private callWindow: string[] = [];

  // 第 3 层状态: 本 turn 已配对的 tool result 数
  private turnToolResultCount = 0;

  constructor(options: ToolLoopGuardOptions = {}) {
    this.consecutiveLimit = options.consecutiveLimit ?? DEFAULT_CONSECUTIVE_LIMIT;
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.windowDistinctLimit = options.windowDistinctLimit ?? DEFAULT_WINDOW_DISTINCT_LIMIT;
    this.turnHardCap = options.turnHardCap ?? DEFAULT_TURN_HARD_CAP;
  }

  /**
   * 记录工具调用开始。stream_event 可能只有 id, 这种半信息不缓存;
   * 后续 assistant 完整 tool_use 到达时会用 name/input 补齐。
   */
  onToolUse(toolUseId: string, toolName: unknown, input: unknown): void {
    if (toolUseId.length === 0) return;
    if (typeof toolName !== 'string' || toolName.length === 0) return;
    this.pendingToolUses.set(toolUseId, { name: toolName, input });
  }

  /**
   * 工具结果到达后配对并按三层判据计数。没有配到完整 tool_use 时直接放行,
   * 避免用不完整信息误判。
   */
  onToolResult(toolUseId: string, output: string): ToolLoopGuardVerdict {
    const toolUse = this.pendingToolUses.get(toolUseId);
    this.pendingToolUses.delete(toolUseId);
    if (!toolUse) return { kind: 'ok' };

    // 第 3 层: turn 硬上限(先数, 任何形态兜底)
    this.turnToolResultCount += 1;
    if (this.turnToolResultCount > this.turnHardCap) {
      return { kind: 'hard', reason: 'turn-cap', count: this.turnToolResultCount, toolName: toolUse.name };
    }

    // 第 1 层: 连续 name+input+output 完全相同
    const fullFingerprint = fingerprintToolCall(toolUse.name, toolUse.input, output);
    if (fullFingerprint === this.lastFullFingerprint) {
      this.consecutiveStreak += 1;
    } else {
      this.lastFullFingerprint = fullFingerprint;
      this.consecutiveStreak = 1;
    }
    if (this.consecutiveStreak >= this.consecutiveLimit) {
      return {
        kind: 'hard',
        reason: 'consecutive',
        count: this.consecutiveStreak,
        toolName: toolUse.name,
      };
    }

    // 第 2 层: name+input 滑动窗口多样性坍缩(指纹不含 output)
    const callFingerprint = fingerprintToolCall(toolUse.name, toolUse.input, null);
    this.callWindow.push(callFingerprint);
    if (this.callWindow.length > this.windowSize) this.callWindow.shift();
    if (this.callWindow.length >= this.windowSize) {
      const distinct = new Set(this.callWindow).size;
      if (distinct <= this.windowDistinctLimit) {
        return {
          kind: 'hard',
          reason: 'pingpong',
          count: this.callWindow.length,
          toolName: toolUse.name,
        };
      }
    }

    return { kind: 'ok' };
  }

  /** 每个 user turn 开始时重置, 避免跨 turn 的合法重复被累计。 */
  resetTurn(): void {
    this.pendingToolUses.clear();
    this.lastFullFingerprint = null;
    this.consecutiveStreak = 0;
    this.callWindow = [];
    this.turnToolResultCount = 0;
  }
}

/**
 * 指纹: tool name + 稳定序列化 input (+ 可选 output)。
 * output 传 null 时不参与 —— 第 2 层靠这个忽略易变输出, 只比 name+input。
 */
function fingerprintToolCall(toolName: string, input: unknown, output: string | null): string {
  const hash = createHash('sha256');
  hash.update('tool:');
  hash.update(toolName);
  hash.update('\ninput:');
  writeStableValue(hash, input, new WeakSet<object>());
  if (output !== null) {
    hash.update('\noutput:');
    hash.update(output);
  }
  return hash.digest('hex');
}

/**
 * 稳定序列化到 hasher: 对象 key 排序, 不深拷贝、不构造大中间对象。
 * Tool input 正常来自 JSON;遇到循环引用时写入占位符, 保证 guard 不抛错。
 */
function writeStableValue(hash: Hash, value: unknown, seen: WeakSet<object>): void {
  if (value === null) {
    hash.update('null');
    return;
  }

  const t = typeof value;
  if (t === 'string') {
    hash.update(JSON.stringify(value));
    return;
  }
  if (t === 'number' || t === 'boolean') {
    hash.update(String(value));
    return;
  }
  if (t === 'undefined') {
    hash.update('undefined');
    return;
  }
  if (t === 'bigint') {
    hash.update(`bigint:${String(value)}`);
    return;
  }
  if (t === 'symbol' || t === 'function') {
    hash.update(t);
    return;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    hash.update('"[Circular]"');
    return;
  }
  seen.add(obj);

  if (Array.isArray(value)) {
    hash.update('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) hash.update(',');
      writeStableValue(hash, value[i], seen);
    }
    hash.update(']');
    seen.delete(obj);
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  hash.update('{');
  keys.forEach((key, index) => {
    if (index > 0) hash.update(',');
    hash.update(JSON.stringify(key));
    hash.update(':');
    writeStableValue(hash, record[key], seen);
  });
  hash.update('}');
  seen.delete(obj);
}
