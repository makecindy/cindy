/**
 * 响应流 tool_use id 去重改写 —— 让**运行中**的会话在 kimi 铸出撞车 id 时自愈,
 * 不必重启 / 重开会话。
 *
 * 背景(2026-07-31 moonshot/kimi-k3「空消息」事故,全链路证据见
 * maker-core/src/agents/claude-code/jsonl-tool-id-normalize.ts 头注):
 *   1. kimi 模型按「当前上下文可见的 tool 调用数」生成递增序号的 tool_call id
 *      (原生形态 `functions.{name}:{idx}`,经 LiteLLM/Moonshot anthropic 端点
 *      清洗为 `${ToolName}_${index}`);会话 rewind/中断导致可见数回落后,新铸
 *      id 与历史撞车 —— **不需要重启,会话运行中(如中途 rewind)同样会发生**。
 *   2. CC CLI 的 ensureToolResultPairing 把重复 id 的 tool exchange 从后续请求
 *      里整段丢弃,掏空的 user 消息以 "(no content)" 占位,模型上下文被腐蚀。
 *   3. resume 前的转录归一化只能清理存量;已经运行中的 CLI 进程持有的内存态
 *      历史不受影响,腐蚀会持续到进程结束。
 *
 * 本层在响应流到达 CLI 之前把撞车 id 改名(`${id}_dup${N}`,后缀语义与请求侧
 * dedupeDuplicateToolUseIds / 转录归一化一致):CLI 记录进转录的历史**从不带
 * 重复**,ensureToolResultPairing 无可丢之物,腐蚀无从发生。与转录归一化互补:
 * 它治存量(下次 resume),本层防新发(当前进程立即生效)。
 *
 * 判定集合必须是**全量** tool_use id(不只铸造形态):改名产物 `_dupN` 也会进
 * 转录,同一底 id 第二次撞车时,若集合里没有它,改写器会再次给出同一个
 * `_dupN` 与历史撞车(Fable-5 review P1-A:事故数据里同一 id 被重铸 9×/27×,
 * 多次撞车是主态而非角例)。「是否接管响应流」的开关才看铸造形态。
 *
 * 成本纪律(SSE 是延迟命脉,见 server.ts 头注):
 *   - 历史不含铸造形态 id 时(纯 Anthropic 会话 / 无 tool 调用)返回 null,
 *     调用方完全不改管响应路径 —— 零成本;
 *   - 命中时按行扫 SSE,只对以 `data:` 开头且行首内含 `"content_block_start"`
 *     的行做 JSON 解析(每响应寥寥数行),text delta 行只做一次字节级比较;
 *   - 行匹配不假设上游的 JSON 序列化风格(空格/键序):`data:` + 任意空白 +
 *     `{` 且前缀窗口内含标记子串即解析,结构校验(content_block.type)才是
 *     真正的门(Fable-5 review P1-D:逐字节前缀假设在 Python json.dumps 风格
 *     上游下会整体静默失效)。
 *
 * 只处理 Anthropic SSE;非流式 JSON 响应不改写(CC 主循环恒走流式,未实测到
 * 非流式携带 tool_use 的上游,fail-open 与扩展前行为一致)。
 */

import { Transform, type TransformCallback } from 'node:stream';

/**
 * kimi 铸造器形态的 tool_call id:末段为纯数字(`Bash_210` / `TaskCreate_35` /
 * `mcp__cindy_memory__call_tool_5` —— MCP 工具名带下划线,实测 MCP id 当前为
 * `call_<random>` 无撞车风险,此处按威胁面放宽防御,Fable-5 review P1-E)。
 */
const MINTED_TOOL_USE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*_\d+$/;

/** SSE data 行前缀。 */
const SSE_DATA_PREFIX = 'data: ';
/**
 * `"content_block_start"` 的扫描窗口:扫描本身限界在行前 512 字节
 * (Buffer.indexOf 原生实现,成本可忽略;text delta 行不付全行扫描)。
 * 512 按威胁面取:content_block_start 行 = 事件头 + id + name + 空 input,
 * pydantic/model_dump 字段序(content_block、index、type 末尾)+ MCP 最长
 * 工具名(64 字符)+ json.dumps 空格风格合计 ~300 字节,512 给足余量;
 * 再大就是破坏流式约定的内联大 input,fail-open 与扩展前一致。
 * (Fable-5 review:120 字节窗口是按短名 Bash 的测试擦线校准,type 末尾键序
 * + MCP 长名时 marker 落到 ~150 → 静默 no-op,专漏 P1-E 要保护的 MCP 场景。)
 */
const CONTENT_BLOCK_START_SCAN_WINDOW = 512;
/** 不完整行的缓冲上限:病态上游发无 \n 长流时直接透传放弃改写,防内存膨胀。 */
const MAX_PENDING_LINE_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从已解析请求体收集响应改写的判定集合。
 *
 * @returns 历史含铸造形态 id(撞车可能发生)→ **全量** tool_use id 集合;
 *          否则(纯 Anthropic / 无 tool 调用 / 非 messages 请求)→ null
 *          (调用方据此完全跳过响应改写)。
 */
export function collectToolUseIdsForResponseRewrite(body: unknown): Set<string> | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  let ids: Set<string> | null = null;
  let hasMintedShape = false;
  for (const msg of body.messages) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      if (typeof block.id !== 'string' || block.id.length === 0) continue;
      (ids ??= new Set()).add(block.id);
      if (MINTED_TOOL_USE_ID_RE.test(block.id)) hasMintedShape = true;
    }
  }
  return hasMintedShape ? ids : null;
}

/**
 * 单个响应流的去重改写器:以**全量**历史 id 为种子,叠加本响应已见 id。
 * 撞上已见集合的 id 改写为 `${id}_dup${N}`(N 取未占用的最小值 ≥ 2)。
 */
export class ToolUseIdDedupeRewriter {
  private readonly usedIds: Set<string>;
  /** 已改写的 id 个数(诊断 / 测试用)。 */
  renameCount = 0;

  constructor(
    historyIds: ReadonlySet<string>,
    private readonly onRename?: (from: string, to: string) => void,
    /** 每个 resolve 的 id(无论是否撞车)都回调 —— 线程缓存据此记录 fresh id。 */
    private readonly onObserved?: (id: string) => void,
    /**
     * 共享缓存检查:同一 thread 的并发响应流(如同步 subagent)各自持有本 rewriter,
     * 都从请求开始时的快照构建 usedIds —— 若两个快照都空, 流 A 放行并缓存 Bash_210
     * 后, 流 B 仍把它当 fresh 放行, CLI 追加重复 id 重新引入腐蚀。resolve 每个 id
     * 时先问共享缓存: 别处已见过 → 按碰撞改名, 不重复放行(codex-connector P1:
     * Check the live cache before accepting fresh IDs)。
     */
    private readonly sharedSeen?: (id: string) => boolean,
  ) {
    this.usedIds = new Set(historyIds);
  }

  /** 返回(可能)改写后的 id;不改写时返回原字符串(同引用)。 */
  resolve(id: string): string {
    // 本 rewriter usedIds 已见, 或共享缓存(别的并发流)已见 → 碰撞路径改名。
    if (!this.usedIds.has(id) && !(this.sharedSeen ? this.sharedSeen(id) : false)) {
      this.usedIds.add(id);
      this.onObserved?.(id);
      return id;
    }
    let k = 2;
    let candidate = `${id}_dup${k}`;
    while (this.usedIds.has(candidate) || (this.sharedSeen ? this.sharedSeen(candidate) : false)) {
      k += 1;
      candidate = `${id}_dup${k}`;
    }
    this.usedIds.add(candidate);
    this.renameCount += 1;
    this.onRename?.(id, candidate);
    this.onObserved?.(candidate);
    return candidate;
  }

  /**
   * 处理一行 SSE 字节(含或不含行尾换行),返回改写后的行(无改动返回原 Buffer)。
   * 只对 `data:` 开头、前缀窗口内含 `"content_block_start"` 的行做 JSON 解析;
   * 其它行字节透传。JSON 解析失败 / 结构不符 → fail-open 返回原行。
   */
  rewriteSseLine(line: Buffer): Buffer {
    // 行尾剥离(保留用于复原),容忍 \n / \r\n / 无尾行。
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
    // `data:` + 任意空白 + `{`;JSON 序列化风格(空格/键序)不做假设。
    // 字节级比较,热路径不为每行分配字符串。
    if (
      end <= SSE_DATA_PREFIX.length ||
      line[0] !== 0x64 /* d */ ||
      line[1] !== 0x61 /* a */ ||
      line[2] !== 0x74 /* t */ ||
      line[3] !== 0x61 /* a */ ||
      line[4] !== 0x3a /* : */
    ) {
      return line;
    }
    let jsonStart = 5;
    while (jsonStart < end && (line[jsonStart] === 0x20 || line[jsonStart] === 0x09)) jsonStart += 1;
    // UTF-8 BOM(\xEF\xBB\xBF):上游可能在最前面插入 BOM 前缀;跳过 BOM 后 { 才是 JSON 开头
    if (
      jsonStart + 2 < end &&
      line[jsonStart] === 0xef &&
      line[jsonStart + 1] === 0xbb &&
      line[jsonStart + 2] === 0xbf
    ) {
      jsonStart += 3;
    }
    if (jsonStart >= end || line[jsonStart] !== 0x7b /* { */) return line;
    // 扫描本身限界在窗口内(不是先全行扫再判窗口 —— 那种写法既付全行成本
    // 又留漏命中,两头不占,Fable-5 复核指出)。
    const markerAt = line
      .subarray(jsonStart, Math.min(end, jsonStart + CONTENT_BLOCK_START_SCAN_WINDOW))
      .indexOf('"content_block_start"');
    if (markerAt === -1) return line; // ← 廉价门:非 start 帧(text delta / input delta)不透
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf8', jsonStart, end));
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
 * SSE 字节流改写 Transform:按 `\n` 切行,不完整行缓冲到下一 chunk / flush;
 * 缓冲超 MAX_PENDING_LINE_BYTES 时原样放行该行并继续(病态长行不拖垮内存)。
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
      const rest = buf.subarray(start);
      if (rest.length > MAX_PENDING_LINE_BYTES) {
        // 病态超长行(无 \n):不做改写直接放行,防止 pending 无限增长。
        this.push(rest);
        this.pending = Buffer.alloc(0);
      } else {
        this.pending = rest;
      }
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
