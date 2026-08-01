/**
 * 响应流 tool_use id 去重改写 —— 让**运行中**的会话在 kimi 铸出撞车 id 时自愈,
 * 不必重启 / 重开会话。
 *
 * 背景(2026-07-31 moonshot/kimi-k3「空消息」事故,全链路证据见
 * maker-core/src/agents/claude-code/jsonl-tool-id-normalize.ts 头注):
 *   1. moonshot 按「当前请求历史可见的 tool 调用数」铸造 tool_call id
 *      (`${ToolName}_${index}`);会话 rewind/中断导致可见数回落后,新铸 id
 *      与历史撞车 —— **不需要重启,会话运行中(如中途 rewind)同样会发生**。
 *   2. CC CLI 的 ensureToolResultPairing 把重复 id 的 tool exchange 从后续请求
 *      里整段丢弃,掏空的 user 消息以 "(no content)" 占位,模型上下文被腐蚀。
 *   3. resume 前的转录归一化只能清理存量;已经运行中的 CLI 进程持有的内存态
 *      历史不受影响,腐蚀会持续到进程结束。
 *
 * 本层在响应流到达 CLI 之前把撞车 id 改名(`${id}_dup${N}`,与请求侧
 * dedupeDuplicateToolUseIds / 转录归一化的后缀语义一致):CLI 记录进转录的
 * 历史**从不带重复**,ensureToolResultPairing 无可丢之物,腐蚀无从发生。
 * 与转录归一化互补:它治存量(下次 resume),本层防新发(当前进程立即生效)。
 *
 * 成本纪律(SSE 是延迟命脉,见 server.ts 头注):
 *   - 历史不含铸造形态 id 时(纯 Anthropic 会话 / 无 tool 调用)返回 null,
 *     调用方完全不改管响应路径 —— 零成本;
 *   - 命中时只按行扫 SSE,且仅对 `data: {"type":"content_block_start"` 前缀的
 *     行做 JSON 解析(每响应寥寥数行),text delta 行只做一次字节级前缀比较。
 *
 * 只处理 Anthropic SSE;非流式 JSON 响应不改写(CC 主循环恒走流式,未实测到
 * 非流式携带 tool_use 的上游,fail-open 与扩展前行为一致)。
 */

import { Transform, type TransformCallback } from 'node:stream';

/** moonshot/kimi 铸造器形态的 tool_call id:`${ToolName}_${纯数字}`。 */
const MINTED_TOOL_USE_ID_RE = /^([A-Za-z][A-Za-z0-9]*)_(\d+)$/;

/** SSE data 行前缀(Anthropic 规范形态: `data: {<json>`)。 */
const SSE_DATA_PREFIX = 'data: ';
/** 需要解析的行:字节级前缀,避免对 text delta 行做字符串扫描。 */
const CONTENT_BLOCK_START_LINE_PREFIX = Buffer.from(
  'data: {"type":"content_block_start"',
  'utf8',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从已解析请求体收集「铸造形态」的 tool_use id 集合 —— 响应改写的命中判定集。
 * 只有历史里存在这种 id,响应里才可能出现与之撞车的新铸 id。
 *
 * @returns 有命中 → id 集合;无命中(纯 Anthropic / 无 tool 调用 / 非 messages
 *          请求)→ null(调用方据此完全跳过响应改写)。
 */
export function collectMintedToolUseIds(body: unknown): Set<string> | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  let ids: Set<string> | null = null;
  for (const msg of body.messages) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      if (typeof block.id !== 'string' || !MINTED_TOOL_USE_ID_RE.test(block.id)) continue;
      (ids ??= new Set()).add(block.id);
    }
  }
  return ids;
}

/**
 * 单个响应流的去重改写器:历史 id 集合 + 本响应已见 id。
 * 撞上已见集合的 id 改写为 `${id}_dup${N}`(N 取未占用的最小值 ≥ 2)。
 */
export class ToolUseIdDedupeRewriter {
  private readonly usedIds: Set<string>;
  /** 已改写的 id 个数(诊断 / 测试用)。 */
  renameCount = 0;

  constructor(
    historyIds: ReadonlySet<string>,
    private readonly onRename?: (from: string, to: string) => void,
  ) {
    this.usedIds = new Set(historyIds);
  }

  /** 返回(可能)改写后的 id;不改写时返回原字符串(同引用)。 */
  resolve(id: string): string {
    if (!this.usedIds.has(id)) {
      this.usedIds.add(id);
      return id;
    }
    let k = 2;
    let candidate = `${id}_dup${k}`;
    while (this.usedIds.has(candidate)) {
      k += 1;
      candidate = `${id}_dup${k}`;
    }
    this.usedIds.add(candidate);
    this.renameCount += 1;
    this.onRename?.(id, candidate);
    return candidate;
  }

  /**
   * 处理一行 SSE 字节(含或不含行尾换行),返回改写后的行(无改动返回原 Buffer)。
   * 只解析 `data: {"type":"content_block_start"` 前缀的行;其它行字节透传。
   * JSON 解析失败 / 结构不符 → fail-open 返回原行(不比扩展前更糟)。
   */
  rewriteSseLine(line: Buffer): Buffer {
    if (
      line.length <= CONTENT_BLOCK_START_LINE_PREFIX.length ||
      !line.subarray(0, CONTENT_BLOCK_START_LINE_PREFIX.length).equals(CONTENT_BLOCK_START_LINE_PREFIX)
    ) {
      return line;
    }
    let end = line.length;
    let newline = '';
    if (line[end - 1] === 0x0a /* \n */) {
      end -= 1;
      newline = '\n';
      if (line[end - 1] === 0x0d /* \r */) {
        end -= 1;
        newline = '\r\n';
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf8', SSE_DATA_PREFIX.length, end));
    } catch {
      return line;
    }
    if (!isRecord(parsed)) return line;
    const block = parsed.content_block;
    if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string') return line;
    const next = this.resolve(block.id);
    if (next === block.id) return line;
    block.id = next;
    return Buffer.from(`${SSE_DATA_PREFIX}${JSON.stringify(parsed)}${newline}`, 'utf8');
  }
}

/**
 * SSE 字节流改写 Transform:按 `\n` 切行,不完整行缓冲到下一 chunk / flush。
 * 只重写命中的 data 行,其余字节原样通过(事件边界、注释、心跳行零干预)。
 */
export class ToolUseIdRewriteTransform extends Transform {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly rewriter: ToolUseIdDedupeRewriter) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    try {
      const buf = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
      let start = 0;
      let nl = buf.indexOf(0x0a, start);
      while (nl !== -1) {
        this.push(this.rewriter.rewriteSseLine(buf.subarray(start, nl + 1)));
        start = nl + 1;
        nl = buf.indexOf(0x0a, start);
      }
      this.pending = buf.subarray(start);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.pending.length > 0) {
        this.push(this.rewriter.rewriteSseLine(this.pending));
        this.pending = Buffer.alloc(0);
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}
