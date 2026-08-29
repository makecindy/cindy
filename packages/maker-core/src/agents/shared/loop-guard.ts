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
 * 第 3 层(轮转):更长窗口 + 更宽 distinct 上限,抓第 2 层漏掉的 3-4 个调用
 * 轮转(ABCDABCD…)。实锤:xai/grok 单 turn 在 4 个不同 Grep 里轮转一千多次
 * 调用(2026-08),distinct=4 > 2 从第 2 层漏网。16/4 = 每种指纹平均重复 4 次
 * 才判,比直接把第 2 层 distinct 提到 4 的误判面小;连续 16 次调用零新指纹
 * 的合法工作流(纯读排查也会穿插不同参数)实践中几乎不存在。
 */
const DEFAULT_ROTATION_WINDOW_SIZE = 16;
/** 第 3 层:轮转窗口填满后, distinct 指纹数 ≤ 此值即判循环。 */
const DEFAULT_ROTATION_DISTINCT_LIMIT = 4;
/**
 * 第 4 层(契约错误):同一工具连续多少次因**同类参数契约错误**被拒即止损。
 * 与 1-3 层互补:那三层按 name+input 指纹抓"重复同一调用",而 malformed 参数每次
 * input 都不同(2026-08 实锤:xai/grok 单 session 16 次 Edit 缺 file_path,
 * old/new_string 各不相同 → 指纹恒新,三层全部漏网)。本层按 name+错误类别聚合,
 * 阈值低于第 1 层:同类契约错误第 3 次就该停,不值得等第 4 次机械重复。
 */
const DEFAULT_CONTRACT_CONSECUTIVE_LIMIT = 3;

/**
 * 参与契约错误分类的输出长度上限。这类错误全是短文本;成功输出(文件内容、
 * 编辑回显、测试文件里恰好写着同款错误文案)可能包含相同短语,长度门把它们挡在
 * 分类之外,避免"连续编辑三个含错误文案的文件"被误判成契约错误风暴。
 */
const CONTRACT_ERROR_MAX_OUTPUT_LENGTH = 600;

/** 稳定的契约错误类别。认不出的错误(other)一律不参与熔断,防 CC 文案漂移造成误伤。 */
export type ToolContractErrorCategory =
  | 'missing_required_field'
  | 'invalid_pages'
  | 'stale_locator'
  | 'ambiguous_locator'
  | 'no_changes';

/**
 * 逐类别匹配器:只认专一、跨版本稳定的错误文案;tools 限定该类别只对哪些工具生效
 * (缺省 = 任意工具),进一步压误分类面。
 */
const CONTRACT_ERROR_MATCHERS: ReadonlyArray<{
  category: ToolContractErrorCategory;
  tools?: ReadonlySet<string>;
  pattern: RegExp;
}> = [
  {
    category: 'missing_required_field',
    // 只限有结构化参数校验的内置工具:Bash 会原样转发任意 CLI 的
    // "missing required parameter --xxx" 输出,不限定工具会把用户脚本的正常
    // 报错迭代误判成契约错误风暴。
    tools: new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'AskUserQuestion']),
    pattern: /required parameter[\s\S]{0,80}\bmissing\b|missing required parameter/i,
  },
  {
    category: 'invalid_pages',
    tools: new Set(['Read']),
    pattern: /\bpages?\b[\s\S]{0,80}\b(invalid|only applicable|not applicable|out of range|must)\b|\binvalid\b[\s\S]{0,40}\bpages?\b/i,
  },
  {
    category: 'stale_locator',
    tools: new Set(['Edit', 'NotebookEdit']),
    pattern: /string to replace not found|old_string[\s\S]{0,60}not found/i,
  },
  {
    category: 'ambiguous_locator',
    tools: new Set(['Edit', 'NotebookEdit']),
    pattern: /found \d+ matches of the string/i,
  },
  {
    category: 'no_changes',
    tools: new Set(['Edit', 'NotebookEdit']),
    pattern: /old_string and new_string are exactly the same|no changes to make/i,
  },
];

/**
 * 把一次工具结果分类成契约错误类别;认不出或输出超长(多半是成功输出)返回 null。
 * 导出仅为单测;熔断逻辑在 ToolLoopGuard 内。
 */
export function classifyToolContractError(
  toolName: string,
  output: string,
): ToolContractErrorCategory | null {
  if (output.length === 0 || output.length > CONTRACT_ERROR_MAX_OUTPUT_LENGTH) return null;
  for (const matcher of CONTRACT_ERROR_MATCHERS) {
    if (matcher.tools && !matcher.tools.has(toolName)) continue;
    if (matcher.pattern.test(output)) return matcher.category;
  }
  return null;
}

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

interface ContractObservation {
  toolName: string;
  category: ToolContractErrorCategory;
}

export interface ToolLoopGuardOptions {
  /** 第 1 层:连续完全相同(name+input+output)多少次判循环。 */
  consecutiveLimit?: number;
  /** 第 2 层:name+input 滑动窗口大小。 */
  windowSize?: number;
  /** 第 2 层:窗口内 distinct 指纹 ≤ 此值判循环。 */
  windowDistinctLimit?: number;
  /** 第 3 层:轮转检测的滑动窗口大小。 */
  rotationWindowSize?: number;
  /** 第 3 层:轮转窗口内 distinct 指纹 ≤ 此值判循环。 */
  rotationDistinctLimit?: number;
  /** 第 4 层:同工具同类契约错误连续多少次判止损。 */
  contractConsecutiveLimit?: number;
}

/**
 * 命中哪一层判据。consecutive=机械重复 / pingpong=短循环 / rotation=3-4 调用轮转 /
 * contract=同类参数契约错误连续被拒(input 各不相同也计)。
 */
export type ToolLoopReason = 'consecutive' | 'pingpong' | 'rotation' | 'contract';

export type ToolLoopGuardVerdict =
  | { kind: 'ok' }
  | {
    kind: 'hard';
    reason: ToolLoopReason;
    count: number;
    toolName: string;
    /** 仅 reason='contract' 时存在:命中的契约错误类别。 */
    contractCategory?: ToolContractErrorCategory;
  };

/**
 * Result-aware tool loop detector(四层防御)。
 *
 * 只在非轮询工具结果返回后判断。任一层命中即返回 hard, 由调用方决定如何中断:
 *   1. 连续完全相同(name+input+output)—— 快路径, 零误判;
 *   2. name+input 滑动窗口多样性坍缩 —— 抓 ABAB 交替 / output 易变的重复;
 *   3. 更长窗口的轮转检测 —— 抓 3-4 个调用的 ABCD 轮转(第 2 层 distinct 上限盖不住);
 *   4. 同工具同类契约错误连续被拒 —— 抓 input 各不相同、指纹层抓不到的 malformed 重试。
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
  readonly rotationWindowSize: number;
  readonly rotationDistinctLimit: number;
  readonly contractConsecutiveLimit: number;

  private pendingToolUses = new Map<string, PendingToolUse>();

  // 第 1 层状态
  private lastFullFingerprint: string | null = null;
  private consecutiveStreak = 0;

  // 第 2/3 层共用状态: 最近 max(windowSize, rotationWindowSize) 个 name+input 指纹
  private callWindow: string[] = [];

  // 第 4 层无批次兼容状态: 最近一次契约错误的 name+类别键与连续计数
  private lastContractKey: string | null = null;
  private contractStreak = 0;

  // 第 4 层批次状态: 一批 tool_result 是同一轮模型回应,不能按结果到达顺序
  // 把批次内的成功/其它工具误当成新的模型轮次。只保留当前批次和上一批次
  // 的 key, 让状态有界且按每个工具+错误类别分别累计。
  private activeContractBatchId: string | null = null;
  private activeContractKeys = new Set<string>();
  private previousContractKeys = new Set<string>();
  private contractStreakByKey = new Map<string, number>();

  constructor(options: ToolLoopGuardOptions = {}) {
    this.consecutiveLimit = options.consecutiveLimit ?? DEFAULT_CONSECUTIVE_LIMIT;
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.windowDistinctLimit = options.windowDistinctLimit ?? DEFAULT_WINDOW_DISTINCT_LIMIT;
    this.rotationWindowSize = options.rotationWindowSize ?? DEFAULT_ROTATION_WINDOW_SIZE;
    this.rotationDistinctLimit = options.rotationDistinctLimit ?? DEFAULT_ROTATION_DISTINCT_LIMIT;
    this.contractConsecutiveLimit = options.contractConsecutiveLimit ?? DEFAULT_CONTRACT_CONSECUTIVE_LIMIT;
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
   * 工具结果到达后配对并按四层判据判断。没有配到完整 tool_use 时直接放行,
   * 避免用不完整信息误判。契约错误层只接受明确标记为失败的结果；有批次标识时
   * 先按完整批次聚合,由下一批次到达时提交重置,避免结果顺序影响 streak。
   */
  onToolResult(
    toolUseId: string,
    output: string,
    isError = false,
    toolResultBatchId?: string,
  ): ToolLoopGuardVerdict {
    const toolUse = this.pendingToolUses.get(toolUseId);
    this.pendingToolUses.delete(toolUseId);
    if (!toolUse) return { kind: 'ok' };
    if (LOOP_GUARD_EXEMPT_TOOL_NAMES.has(toolUse.name)) return { kind: 'ok' };

    // 第 4 层: 同工具同类契约错误连续出现(input 各不相同也计)。放在 1-3 层之前:
    // 它的阈值(3)低于第 1 层(4),同 input 的重复契约错误也应更早止损。
    // 有 batch id 时按“连续批次”计数, 同一批次每个 key 最多计一次; 成功/其它
    // 工具结果不能因到达顺序把同批次的契约错误抹掉。没有 batch id 的旧调用方
    // 保留原先逐结果计数语义。
    const contractCategory = isError ? classifyToolContractError(toolUse.name, output) : null;
    if (toolResultBatchId !== undefined) {
      this.beginContractBatch(toolResultBatchId);
      if (contractCategory !== null) {
        const contractKey = `${toolUse.name}\n${contractCategory}`;
        // Parallel results in one user message are one model attempt. Count this
        // key only on its first result in the batch, regardless of result order.
        if (!this.activeContractKeys.has(contractKey)) {
          this.activeContractKeys.add(contractKey);
          const streak = this.previousContractKeys.has(contractKey)
            ? (this.contractStreakByKey.get(contractKey) ?? 0) + 1
            : 1;
          this.contractStreakByKey.set(contractKey, streak);
          if (streak >= this.contractConsecutiveLimit) {
            return {
              kind: 'hard',
              reason: 'contract',
              count: streak,
              toolName: toolUse.name,
              contractCategory,
            };
          }
        }
      }
    } else {
      // Legacy callers do not provide batch ids; preserve the original
      // adjacent-result streak semantics for them.
      this.resetContractBatchState();
      if (contractCategory !== null) {
        const contractKey = `${toolUse.name}\n${contractCategory}`;
        this.contractStreak = contractKey === this.lastContractKey ? this.contractStreak + 1 : 1;
        this.lastContractKey = contractKey;
        if (this.contractStreak >= this.contractConsecutiveLimit) {
          return {
            kind: 'hard',
            reason: 'contract',
            count: this.contractStreak,
            toolName: toolUse.name,
            contractCategory,
          };
        }
      } else {
        this.lastContractKey = null;
        this.contractStreak = 0;
      }
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

    // 第 2/3 层: name+input 滑动窗口多样性坍缩(指纹不含 output)
    const callFingerprint = fingerprintToolCall(toolUse.name, toolUse.input, null);
    this.callWindow.push(callFingerprint);
    const bufferSize = Math.max(this.windowSize, this.rotationWindowSize);
    if (this.callWindow.length > bufferSize) this.callWindow.shift();

    // 第 2 层: 短窗口 ping-pong(≤2 种调用来回打转)
    if (this.callWindow.length >= this.windowSize) {
      const recent = this.callWindow.slice(-this.windowSize);
      const distinct = new Set(recent).size;
      if (distinct <= this.windowDistinctLimit) {
        return {
          kind: 'hard',
          reason: 'pingpong',
          count: recent.length,
          toolName: toolUse.name,
        };
      }
    }

    // 第 3 层: 长窗口轮转(3-4 种调用 ABCD 轮转,第 2 层 distinct 上限盖不住)
    if (this.callWindow.length >= this.rotationWindowSize) {
      const recent = this.callWindow.slice(-this.rotationWindowSize);
      const distinct = new Set(recent).size;
      if (distinct <= this.rotationDistinctLimit) {
        return {
          kind: 'hard',
          reason: 'rotation',
          count: recent.length,
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
    this.lastContractKey = null;
    this.contractStreak = 0;
    this.resetContractBatchState();
  }

  private beginContractBatch(batchId: string): void {
    if (this.activeContractBatchId === batchId) return;

    // A batch-id stream and the legacy no-id stream must never share a streak.
    // Reset the compatibility counters when a new batch becomes authoritative.
    this.lastContractKey = null;
    this.contractStreak = 0;
    this.previousContractKeys = this.activeContractKeys;
    this.activeContractKeys = new Set<string>();
    // A key only remains eligible to continue if it occurred in the immediately
    // previous batch. This bounds memory and makes an intervening clean batch
    // break the contract streak.
    for (const key of this.contractStreakByKey.keys()) {
      if (!this.previousContractKeys.has(key)) this.contractStreakByKey.delete(key);
    }
    this.activeContractBatchId = batchId;
  }

  private resetContractBatchState(): void {
    this.activeContractBatchId = null;
    this.activeContractKeys = new Set<string>();
    this.previousContractKeys = new Set<string>();
    this.contractStreakByKey = new Map<string, number>();
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
