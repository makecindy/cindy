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
 * TaskOutput 是 SDK 明确定义的等待/轮询工具。状态文本不变只代表任务仍在等待,
 * 不能作为模型死循环证据。它本身不进入指纹,但也不重置普通工具的轨迹,
 * 避免模型通过在重复调用间插入轮询来绕过检测。
 */
const LOOP_GUARD_EXEMPT_TOOL_NAMES = new Set(['TaskOutput']);

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
}

/** 命中哪一层判据。consecutive=机械重复 / pingpong=短循环。 */
export type ToolLoopReason = 'consecutive' | 'pingpong';

export type ToolLoopGuardVerdict =
  | { kind: 'ok' }
  | { kind: 'hard'; reason: ToolLoopReason; count: number; toolName: string };

/**
 * Result-aware tool loop detector(两层防御)。
 *
 * 只在非轮询工具结果返回后判断。任一层命中即返回 hard, 由调用方决定如何中断:
 *   1. 连续完全相同(name+input+output)—— 快路径, 零误判;
 *   2. name+input 滑动窗口多样性坍缩 —— 抓 ABAB 交替 / output 易变的重复;
 *
 * 不按调用总数或任意长度的重复序列硬中断:仅凭工具 trace 无法区分合法批处理、
 * 稳定状态轮询与死循环,有限窗口也只能移动误判/漏判边界。
 *
 * 类本身不依赖 Electron / SDK / provider, 也不做 IO;调用方决定何时启用和如何中断。
 */
export class ToolLoopGuard {
  readonly consecutiveLimit: number;
  readonly windowSize: number;
  readonly windowDistinctLimit: number;

  private pendingToolUses = new Map<string, PendingToolUse>();

  // 第 1 层状态
  private lastFullFingerprint: string | null = null;
  private consecutiveStreak = 0;

  // 第 2 层状态: 最近 windowSize 个 name+input 指纹
  private callWindow: string[] = [];

  constructor(options: ToolLoopGuardOptions = {}) {
    this.consecutiveLimit = options.consecutiveLimit ?? DEFAULT_CONSECUTIVE_LIMIT;
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.windowDistinctLimit = options.windowDistinctLimit ?? DEFAULT_WINDOW_DISTINCT_LIMIT;
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
   * 工具结果到达后配对并按两层判据判断。没有配到完整 tool_use 时直接放行,
   * 避免用不完整信息误判。
   */
  onToolResult(toolUseId: string, output: string): ToolLoopGuardVerdict {
    const toolUse = this.pendingToolUses.get(toolUseId);
    this.pendingToolUses.delete(toolUseId);
    if (!toolUse) return { kind: 'ok' };
    if (LOOP_GUARD_EXEMPT_TOOL_NAMES.has(toolUse.name)) return { kind: 'ok' };

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
    this.resetPatternState();
  }

  private resetPatternState(): void {
    this.lastFullFingerprint = null;
    this.consecutiveStreak = 0;
    this.callWindow = [];
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
