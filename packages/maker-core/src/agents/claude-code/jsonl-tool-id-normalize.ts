/**
 * Claude Code 会话转录(jsonl)的 tool_use id 归一化 —— resume 前修复
 * kimi 系 tool_call id 与 CLI ensureToolResultPairing 冲突导致的上下文腐蚀。
 *
 * 背景(2026-07-31 moonshot/kimi-k3 实测事故,顺藤摸到的完整因果链):
 *   1. kimi 模型按「当前上下文可见的 tool 调用数」生成递增序号的 tool_call id
 *      (原生 `functions.{name}:{idx}`,经 LiteLLM 清洗为 `${ToolName}_${index}`)。
 *   2. 会话 rewind / 中断轮被 CLI 投影排除后,可见调用数 < 历史已用 id 上界,
 *      resume 后重铸出**与历史重复**的 id(实测:Bash_210 被铸 9 次、
 *      Bash_212 被铸 27 次)。
 *   3. CC CLI(2.1.219 起)的 ensureToolResultPairing 用全局 Set 去重:后出现的
 *      重复 id tool_use 块连同其 tool_result 一起从请求里丢弃;被掏空的 user
 *      消息以字面量 "(no content)" 占位进请求。模型于是看到自己的工具调用
 *      「被阻止」、用户不断「发空消息」,进入空转循环(inc-4977 同族)。
 *
 * 修复策略(resume/spawn 前对转录做一次性归一化,幂等):
 *   a. 去重:同一 id 的第 N 次出现改写为 `${id}_dup${N}`(后缀对**全量既有 id**
 *      查占用顺延;tool_result 按「最近未配对的同名 call」位置配对同步改写 ——
 *      孤儿 call + 重铸 call 并存时,result 属于真实执行的那次,Fable-5 review
 *      指出的出现序配对张冠李戴由此避免)。
 *   b. 移出铸造空间:所有末段纯数字 id 改写为 `${name}_x${digits}`(占用时追加
 *      x 顺延)。kimi 铸造器只产 `_数字` 后缀,改写后历史 id 与未来新铸 id 永不
 *      撞车;`_x` 形态不再匹配本规则 → 幂等,二次运行零改写。
 *   后缀一律查占用的原因(Fable-5 review P1-B/C):转录里可能已存在上一轮
 *   归一化/proxy 改名的产物(`_x210`/`_dup2`),不查占用会把新改写撞上去,
 *   「修复本身复发事故」。
 *
 * id 对模型与 API 均为不透明字符串,配对关系保持 → 改写不改变会话语义。
 * 未改动的行保持原始字节(与 fork-jsonl-repair 同约定);改写整文件前先备份,
 * 写入走 tmp+rename 原子替换(见 normalizeClaudeSessionJsonlToolIds)。
 */

import { promises as fs } from 'node:fs';

import { createClaudeJsonlBackup, isRecord } from './fork-jsonl-repair.js';

type JsonObject = Record<string, unknown>;

/**
 * kimi 铸造器形态的 id:末段为纯数字。MCP 工具名带下划线
 * (`mcp__cindy_memory__call_tool_5`),实测 MCP id 当前为 `call_<random>` 无撞车
 * 风险,此处按威胁面放宽防御(Fable-5 review P1-E)。
 */
const MINTED_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*_(\d+)$/;

/** 廉价预扫:文件里是否存在疑似铸造 id 的 tool_use / tool_result,无命中则跳过全量解析。 */
const SUSPECT_ID_RE = /"(?:id|tool_use_id)"\s*:\s*"[A-Za-z][A-Za-z0-9_-]*_\d+"/;

export interface NormalizeClaudeJsonlToolIdsResult {
  /** 归一化后的完整文本(changed=false 时与输入同引用)。 */
  text: string;
  changed: boolean;
  lineCount: number;
  /** 预扫未命中而跳过时为 true(此时 changed=false,未做解析)。 */
  skipped: boolean;
  /** 去重改写的块数(tool_use + tool_result 合计)。 */
  dedupedBlockCount: number;
  /** 移出铸造空间改写的块数(tool_use + tool_result 合计)。 */
  offsetBlockCount: number;
  /** 参与去重判定的重复 id 个数(诊断用)。 */
  duplicateIdCount: number;
  /** 尾部畸形残行被原样保留时为 true(诊断用)。 */
  keptMalformedTailLine: boolean;
}

function isToolUseBlock(block: unknown): block is JsonObject & { id: string } {
  return (
    isRecord(block) &&
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    block.id.length > 0
  );
}

function isToolResultBlock(block: unknown): block is JsonObject & { tool_use_id: string } {
  return (
    isRecord(block) &&
    block.type === 'tool_result' &&
    typeof block.tool_use_id === 'string' &&
    block.tool_use_id.length > 0
  );
}

function messageContentBlocks(entry: JsonObject): JsonObject[] | null {
  const message = entry.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  return content as JsonObject[];
}

function messageRole(entry: JsonObject): unknown {
  return isRecord(entry.message) ? entry.message.role : undefined;
}

/** `${id}_dup${k}` 查占用顺延,返回未占用的最小 k ≥ 2 候选。 */
function freeDupSuffix(id: string, used: ReadonlySet<string>): string {
  let k = 2;
  let candidate = `${id}_dup${k}`;
  while (used.has(candidate)) {
    k += 1;
    candidate = `${id}_dup${k}`;
  }
  return candidate;
}

/**
 * `${name}_x${digits}` 移出铸造空间;目标被占用时追加 x 顺延
 * (`_xx` / `_xxx` … 均不再匹配铸造规则,保持幂等)。非铸造形态返回 null。
 */
function offsetMintedId(id: string, used: ReadonlySet<string>): string | null {
  const match = MINTED_ID_RE.exec(id);
  if (!match) return null;
  const digits = match[1];
  const name = id.slice(0, id.length - digits.length - 1);
  let xCount = 1;
  let candidate = `${name}_${'x'.repeat(xCount)}${digits}`;
  while (used.has(candidate)) {
    xCount += 1;
    candidate = `${name}_${'x'.repeat(xCount)}${digits}`;
  }
  return candidate;
}

/**
 * 文本级归一化:解析 → 去重(位置配对)→ 移出铸造空间 → 仅重写有改动的行。
 *
 * 预扫未命中(纯 Anthropic toolu_* / OpenAI call_<random> 会话)直接返回原文,
 * 不做 JSON 解析 —— spawn 前路径上对绝大多数会话零成本。
 *
 * 畸形行容忍:仅**最后一行**允许解析失败(CLI 崩溃截断尾行是常态,这类会话
 * 恰恰最需要归一化),原样保留;中间行解析失败仍抛错,由调用方 best-effort
 * 兜底(放弃归一化也不阻断 resume)。
 */
export function normalizeClaudeJsonlToolIdsText(text: string): NormalizeClaudeJsonlToolIdsResult {
  const hadTrailingNewline = text.endsWith('\n');
  const rawLines = text.split('\n');
  if (hadTrailingNewline) rawLines.pop();
  const lineCount = rawLines.length;
  if (!SUSPECT_ID_RE.test(text)) {
    return {
      text,
      changed: false,
      lineCount,
      skipped: true,
      dedupedBlockCount: 0,
      offsetBlockCount: 0,
      duplicateIdCount: 0,
      keptMalformedTailLine: false,
    };
  }
  const entries: JsonObject[] = [];
  let keptMalformedTailLine = false;
  rawLines.forEach((line, index) => {
    try {
      entries.push(JSON.parse(line) as JsonObject);
    } catch (err) {
      if (index === rawLines.length - 1) {
        keptMalformedTailLine = true;
        entries.push({ __malformedTailLine: line });
        return;
      }
      // 错误信息不含原始行内容: 转录可能含用户粘贴的密钥/敏感信息, 拼进 error
      // message 会被调用方写入日志, 属数据暴露(Copilot review)。只留行号与长度。
      throw new Error(
        `tool id normalize: JSONL parse error at line ${index + 1} (length ${line.length})`,
        { cause: err },
      );
    }
  });

  // pass 0: 全量既有 id 集合(占用判定的基准;含 tool_result 引用,同一命名空间)。
  const usedIds = new Set<string>();
  for (const entry of entries) {
    for (const block of messageContentBlocks(entry) ?? []) {
      if (isToolUseBlock(block)) usedIds.add(block.id);
      else if (isToolResultBlock(block)) usedIds.add(block.tool_use_id);
    }
  }

  // pass 1: 定终 id —— 按文件序遍历,call occurrence 依次定终(首现保留原 id
  // 后偏移;第 N 次 _dupN 查占用),result 与配对 call 共享同一终 id:
  //   - 位置配对:result 配「最近未配对的同名 call」(孤儿 call + 重铸 call 并存
  //     时,result 属于真实执行的那次,Fable-5 review 指出的出现序配对张冠李戴
  //     由此避免)。已知盲区(记录备查,均不阻断):同一条 assistant 消息内同 id
  //     并行调用且 result 按调用序到达时 LIFO 会倒配 —— kimi 自回归铸号在同
  //     响应内天然递增,该形态需要模型故障,概率远低于它修掉的孤儿场景;
  //     result 先于 call 的文件序倒挂会分叉断配(CC 转录追加序下构造不出)。
  //   - 超编 result(无未配对 call):指向首现 call 的终 id(与 compat-proxy
  //     dedupe 语义一致);全文件无同名 call 时按独立原 id 走偏移。
  // 占用判定 usedIds = 全量原 id ∪ 已产出终 id;配对 exchange 共享终 id 不算占用。
  const changedLineIndexes = new Set<number>();
  let dedupedBlockCount = 0;
  let offsetBlockCount = 0;
  let duplicateIdCount = 0;
  const callSeen = new Map<string, number>();
  // openCalls[originalId] = 该 id 尚未配对的 call,按出现顺序;每项带所在
  // assistant 消息 index(batch)用于「同批内顺序配对」。
  const openCalls = new Map<string, Array<{ originalId: string; finalId: string; batch: number }>>();
  // 最近一次 assistant 消息的 index —— result 的「同批」= 紧跟的那个 assistant 批。
  let lastAssistantBatch = -1;
  const firstFinalByOriginal = new Map<string, string>();
  // 每个原始 id 按文件序出现的 (行号, 终 id) —— 供 subagent 记录顶层字段做
  // **行作用域配对**(与 tool_result 同语义): 映射到「本记录之前最近的同名 call」的
  // 终 id。同一原始 id 重铸多次时, 首个 subagent 记录挂首次调用、后续各挂各自
  // 最近调用, 而不是全部挂最后一个 duplicate —— 单一 last mapping 会把第一个
  // subagent 的消息错误挂到后面的 Agent/Task 卡片上(codex-connector review P2)。
  const occurrenceByOriginal = new Map<string, Array<{ line: number; finalId: string }>>();
  entries.forEach((entry, index) => {
    const blocks = messageContentBlocks(entry);
    if (!blocks) return;
    const role = messageRole(entry);
    let lineChanged = false;
    for (const block of blocks) {
      if (role === 'assistant' && isToolUseBlock(block)) {
        lastAssistantBatch = index;
        const originalId = block.id;
        const n = (callSeen.get(originalId) ?? 0) + 1;
        callSeen.set(originalId, n);
        if (n === 2) duplicateIdCount += 1;
        let finalId = originalId;
        if (n >= 2) {
          finalId = freeDupSuffix(originalId, usedIds);
          usedIds.add(finalId);
          block.id = finalId;
          dedupedBlockCount += 1;
          lineChanged = true;
        }
        const offset = offsetMintedId(finalId, usedIds);
        if (offset !== null) {
          usedIds.add(offset);
          block.id = offset;
          finalId = offset;
          offsetBlockCount += 1;
          lineChanged = true;
        }
        if (!firstFinalByOriginal.has(originalId)) firstFinalByOriginal.set(originalId, finalId);
        let occ = occurrenceByOriginal.get(originalId);
        if (!occ) {
          occ = [];
          occurrenceByOriginal.set(originalId, occ);
        }
        occ.push({ line: index, finalId });
        let stack = openCalls.get(originalId);
        if (!stack) {
          stack = [];
          openCalls.set(originalId, stack);
        }
        stack.push({ originalId, finalId, batch: index });
      } else if (role === 'user' && isToolResultBlock(block)) {
        const originalId = block.tool_use_id;
        // 配对顺序(同批 FIFO, 跨批 LIFO):
        //   - 同一 assistant 消息内的 parallel calls 同时发出,result 按调用顺序
        //     回来 → 应配同批内按出现序最前的未配对 call(内容顺序,避免 LIFO
        //     倒配 swap 输出,codex-connector review P2)。「同批」= 最近一个
        //     assistant 消息(index === lastAssistantBatch)里的 call。
        //   - 跨批(孤儿 call + 重铸 call)时,重铸 call 在孤儿之后,result 属于
        //     最近发出的那个 → 配数组尾部(最近)。先找同批最前,找不到回退最近。
        const stack = openCalls.get(originalId);
        let matched: { originalId: string; finalId: string; batch: number } | undefined;
        if (stack) {
          const batchMatch = stack.find((c) => c.batch === lastAssistantBatch);
          matched = batchMatch ?? stack[stack.length - 1];
          stack.splice(stack.indexOf(matched), 1);
        }
        const inherited = matched?.finalId ?? firstFinalByOriginal.get(originalId);
        if (inherited !== undefined) {
          if (inherited !== originalId) {
            block.tool_use_id = inherited;
            if (matched && matched.finalId !== matched.originalId && matched.finalId.includes('_dup')) {
              dedupedBlockCount += 1;
            } else {
              offsetBlockCount += 1;
            }
            lineChanged = true;
          }
        } else {
          // 全文件无同名 call 的孤儿 result:按独立原 id 走铸造空间偏移。
          const offset = offsetMintedId(originalId, usedIds);
          if (offset !== null) {
            usedIds.add(offset);
            block.tool_use_id = offset;
            offsetBlockCount += 1;
            lineChanged = true;
          }
        }
      }
    }
    if (lineChanged) changedLineIndexes.add(index);
  });

  // 顶层引用字段跟随 tool_use 改名: Claude subagent/task-notification 条目在顶层带
  // parent_tool_use_id / tool_use_id 引用父 agent 的调用 id(translator 用它们作
  // parentToolUseId 挂载);tool_use_summary 条目在顶层带 preceding_tool_use_ids 数组
  // (translator 转发为 tool_result.data.toolUseIds)。归一化改名后必须同步, 否则
  // 关联断裂 / summary 挂不上归一化后的卡片。
  //
  // 配对必须**按行作用域 + 同行 FIFO + 同 child 复用**: 每个引用记录指向「它所在位置
  // 之前最近的同名 call」的终 id —— 同一原始 id 重铸多次时, 第 N 个 subagent/summary 挂
  // 第 N 次调用, 而非全部挂最后一个 duplicate(单一 last mapping 会把首个记录错误挂到
  // 后面的卡片上, codex-connector P2)。同一 assistant 行内同 id 并行调用(同行多
  // occurrence)时, 多条子记录按**内容顺序**各挂各次调用, 与 tool_result 的同批 FIFO
  // 配对一致(否则同行块被折叠成单一 latest line mapping, 首个子记录错挂到块内最后一个
  // 调用)。**同一 child(共享 uuid)的多条 stream_event 记录必须复用首次解析的终 id**,
  // 不按条推进 occPtr —— 否则同一条 subagent 流的每条事件都会消费一个 occurrence,
  // 把同一个 subagent 拆散到多张 Agent/Task 卡片(codex-connector P2: Keep repeated
  // subagent events on one occurrence)。
  if (occurrenceByOriginal.size > 0) {
    // occPtr[id] = 已消费到 occurrenceByOriginal[id] 的哪个下标。初始 -1。
    const occPtr = new Map<string, number>();
    // childRef[childKey][origId] = 该 child 首次解析出的终 id。同一 child 的多条
    // 记录(共享 child 身份)引用同一 parent id 时全部复用, 不再推进 occPtr。
    // child 身份: stream_event 用 uuid; task_started/task_progress/task_notification
    // 等 task 记录用 task_id(通常无 uuid, translator 以 task_id 为 child 标识,
    // codex-connector P2: Reuse task_id when remapping task records)。用前缀区分
    // 两类命名空间, 避免 uuid 与 task_id 值相同串扰。
    const childRef = new Map<string, Map<string, string>>();
    // 提取记录所属 child 身份(无 child 身份时返回 undefined → 走独立逐条解析)。
    const childKeyOf = (entry: JsonObject): string | undefined => {
      if (typeof entry.uuid === 'string' && entry.uuid) return `uuid:${entry.uuid}`;
      if (typeof entry.task_id === 'string' && entry.task_id) return `task:${entry.task_id}`;
      return undefined;
    };
    // 单个原始 id → 终 id 的行作用域解析。推进规则:
    //   - 同行块内继续(当前 ptr 所在块行 < index 且块内还有下一个): 消费下一个
    //     (FIFO —— 同一条 assistant 消息内同 id 并行调用, 多条子记录按内容顺序);
    //   - 否则: 跳到「最近的行 < index 的块」的**块首**(块内按出现序, 首个即内容
    //     顺序第一个)。跨行(重铸在更早的行)整体跳过, 引用取最近那次调用。
    // 该行之前无同名 call 时返回 undefined。
    const resolveOccurrence = (val: string, index: number): string | undefined => {
      const occs = occurrenceByOriginal.get(val);
      if (!occs || occs.length === 0) return undefined;
      let ptr = occPtr.get(val) ?? -1;
      if (
        ptr >= 0 &&
        ptr + 1 < occs.length &&
        occs[ptr].line === occs[ptr + 1].line &&
        occs[ptr + 1].line < index
      ) {
        ptr += 1;
      } else {
        let next = ptr + 1;
        while (next < occs.length && occs[next].line < index) {
          ptr = next; // 块首(内容顺序第一个)
          while (next + 1 < occs.length && occs[next + 1].line === occs[next].line) next += 1;
          next += 1;
        }
      }
      occPtr.set(val, ptr);
      return ptr < 0 ? undefined : occs[ptr].finalId;
    };
    // 前瞻解析(content_block_start 专用): 匹配**即将出现**的 tool call —— SDK 允许
    // stream_event 先于 assistant 消息到达(handleStreamEvent 显式支持该顺序), 后顾
    // 解析在此顺序下找不到 occurrence、id 保持旧值, 与后续归一化的 assistant/
    // tool_result 指向不一致(codex-connector P2: Handle stream events before
    // assistant rows)。
    // **按内容顺序 FIFO 消费**: 两个重复的 content_block_start(同 id)先于 assistant
    // 时, 若都取第一个 future occurrence, 两条 stream start 都指向首个调用, 而
    // assistant/tool_result 把 duplicate 分配到 Bash_x5 + Bash_5_dup2 —— 第二个
    // tool card 会以错 id 创建/更新。aheadPtr 按 val 记录前瞻已消费到的下标, 每条
    // content_block_start 取「上一个已消费之后、line >= index 的第一个」occurrence。
    // 无前瞻命中(stream_event 记录在 assistant 之后)时, fallback **同样按内容顺序**
    // 消费**之前**的 occurrence —— 而不是总返回最后一个: 两个重复 start 落在
    // assistant 行之后时, 第一条应指向首个调用(Bash_x5), 第二条指向第二个
    // (Bash_5_dup2), 都返回最后一个会让首张 tool card 以错 id 创建/更新
    // (codex-connector P2: Consume post-assistant stream starts by occurrence)。
    // fallback 超出 occurrence 数(stream start 数 > 调用数, 异常)时取最后一个兜底。
    const aheadPtr = new Map<string, number>();
    const resolveAhead = (val: string, index: number): string | undefined => {
      const occs = occurrenceByOriginal.get(val);
      if (!occs || occs.length === 0) return undefined;
      const start = (aheadPtr.get(val) ?? -1) + 1;
      for (let i = start; i < occs.length; i += 1) {
        if (occs[i].line >= index) {
          aheadPtr.set(val, i);
          return occs[i].finalId;
        }
      }
      // 无 future occurrence: fallback 按内容顺序消费之前未消费的 occurrence。
      if (start < occs.length) {
        aheadPtr.set(val, start);
        return occs[start].finalId;
      }
      return occs[occs.length - 1].finalId;
    };
    // 带 child 身份(顶层 uuid / task_id)的记录: 同一 child 复用已解析终 id(首次解析
    // 后缓存), 不按条消费 occurrence —— 同一条 subagent 流 / task 的后续事件不会被
    // 重映射到下一个 occurrence 拆散。
    // 解析顺序: 后顾优先(引用「之前最近的同名 call」); 后顾 miss 时 fallback 前瞻
    // (stream_event / task 行可先于 assistant 行到达, 引用的父调用在后面 —— 否则顶层
    // parent_tool_use_id / tool_use_id 保持旧 id, 与已前瞻改名的 content_block.id
    // 不一致, child 流挂到旧 id 下, codex-connector P1: Forward-map pre-assistant
    // top-level tool refs)。
    const resolveForEntry = (entry: JsonObject, val: string, index: number): string | undefined => {
      const key = childKeyOf(entry);
      if (key !== undefined) {
        let m = childRef.get(key);
        if (m) {
          const cached = m.get(val);
          if (cached !== undefined) return cached;
        }
        const mapped = resolveOccurrence(val, index) ?? resolveAhead(val, index);
        if (mapped !== undefined) {
          if (!m) {
            m = new Map();
            childRef.set(key, m);
          }
          m.set(val, mapped);
        }
        return mapped;
      }
      return resolveOccurrence(val, index) ?? resolveAhead(val, index);
    };
    entries.forEach((entry, index) => {
      let entryChanged = false;
      // entry 级缓存: 同一条记录内多个字段引用同一 id 时共享解析结果 —— 否则标量
      // (parent_tool_use_id / tool_use_id)与嵌套 content_block.id 各自消费前瞻/后顾
      // 指针, 同 id 可能映射到不同终 id, 一条 stream_event 内 self-inconsistent
      // (codex-connector P1 引出的协调)。
      const entryRef = new Map<string, string>();
      const resolveField = (val: string): string | undefined => {
        const cached = entryRef.get(val);
        if (cached !== undefined) return cached;
        const mapped = resolveForEntry(entry, val, index);
        if (mapped !== undefined) entryRef.set(val, mapped);
        return mapped;
      };
      for (const field of ['parent_tool_use_id', 'tool_use_id'] as const) {
        const val = entry[field];
        if (typeof val !== 'string') continue;
        const mapped = resolveField(val);
        if (mapped !== undefined && mapped !== val) {
          entry[field] = mapped;
          entryChanged = true;
        }
      }
      // tool_use_summary 的 preceding_tool_use_ids 数组: 逐项按同一行作用域改写。
      // 数组项**绕过 entryRef / childRef 缓存**: 每一项对应一个独立的 tool call,
      // 同一 id 重复出现是两个重复调用, 需各自消费 occurrence —— 若走 resolveField,
      // 同 entry 内同 id 的缓存会让 ['Bash_5','Bash_5'] 变成 ['Bash_x5','Bash_x5'],
      // 而不是消费第二个 occurrence 得 Bash_5_dup2, resume/import 把第二个 summary
      // 挂到错误的 tool card 上(codex-connector P2: Resolve repeated summary IDs
      // independently)。用纯行作用域解析(后顾优先 + 前瞻 fallback)。
      const arr = entry.preceding_tool_use_ids;
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i += 1) {
          const item = arr[i];
          if (typeof item !== 'string') continue;
          const mapped = resolveOccurrence(item, index) ?? resolveAhead(item, index);
          if (mapped !== undefined && mapped !== item) {
            arr[i] = mapped;
            entryChanged = true;
          }
        }
      }
      // stream_event 的 event.content_block.id(content_block_start 的 tool_use)也要
      // 改写: handleStreamEvent 用它驱动 tool-use start / tool-name 状态, replay/import
      // 会以旧 id 发 tool card, 与归一化后的 tool_result / summary 指向不一致
      // (codex-connector P2: Rewrite stream-event tool IDs too)。用 resolveField
      // (后顾优先 + 前瞻 fallback), 可先于 assistant 行到达(前瞻匹配即将出现的
      // occurrence); 与同 entry 顶层标量共享 entryRef, 保证一致。
      const evt = entry.event;
      if (isRecord(evt) && evt.type === 'content_block_start') {
        const cb = evt.content_block;
        if (isRecord(cb) && cb.type === 'tool_use' && typeof cb.id === 'string' && cb.id.length > 0) {
          const mapped = resolveField(cb.id);
          if (mapped !== undefined && mapped !== cb.id) {
            cb.id = mapped;
            entryChanged = true;
          }
        }
      }
      if (entryChanged) changedLineIndexes.add(index);
    });
  }

  const changed = changedLineIndexes.size > 0;
  const nextText = changed
    ? `${entries
      .map((entry, index) => (changedLineIndexes.has(index) ? JSON.stringify(entry) : rawLines[index]))
      .join('\n')}${hadTrailingNewline ? '\n' : ''}`
    : text;

  return {
    text: nextText,
    changed,
    lineCount: entries.length,
    skipped: false,
    dedupedBlockCount,
    offsetBlockCount,
    duplicateIdCount,
    keptMalformedTailLine,
  };
}

export interface NormalizeClaudeSessionJsonlToolIdsResult
  extends Omit<NormalizeClaudeJsonlToolIdsResult, 'text'> {
  filePath: string;
  backupPath?: string;
}

/**
 * 文件级归一化:有改动时先备份(`.bak.<timestamp>`)再 tmp+rename 原子替换;
 * 无改动 / 预扫跳过时不触碰文件(连备份也不留)。
 */
export async function normalizeClaudeSessionJsonlToolIds(
  filePath: string,
): Promise<NormalizeClaudeSessionJsonlToolIdsResult> {
  const original = await fs.readFile(filePath, 'utf8');
  const normalized = normalizeClaudeJsonlToolIdsText(original);
  let backupPath: string | undefined;
  if (normalized.changed) {
    // 保留原文件权限:转录可能含用户敏感内容,若原文件是 0600,重写后(tmp 默认
    // 0666 & umask)会把提示词/工具输出/粘贴的密钥暴露给同机其它用户
    // (codex-connector review: Preserve transcript file permissions)。stat 拿到
    // 原 mode 应用到 tmp;createClaudeJsonlBackup 生成的 .bak 也沿用。
    // writeFile 的 mode 受进程 umask 影响,创建后必须再 chmod 一次才能真正
    // 还原权限(codex-connector review: Apply chmod after creating transcript
    // copies —— 否则更严格的 umask 会让重写文件比原文件更严格)。
    const originalMode = (await fs.stat(filePath)).mode & 0o777;
    backupPath = await createClaudeJsonlBackup(filePath, original, originalMode);
    // tmp+rename 原子替换:写一半崩溃不会留下半截转录(备份仍在,tmp 残留无害)。
    // Windows 上 rename 覆盖已存在目标的行为依文件系统而异(exFAT 等个别系统抛
    // EEXIST/EPERM,仓内 blobStore.ts:130 有同源注释);若 rename 失败,降级为
    // 「删除旧文件再 rename」——.bak 备份已就位,失败也可回滚,尽量让归一化生效
    // (copilot review)。降级也失败才抛错,由调用方 best-effort 兜底继续 resume。
    const tmpPath = `${filePath}.normalize-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;
    await fs.writeFile(tmpPath, normalized.text, { encoding: 'utf8', mode: originalMode });
    await fs.chmod(tmpPath, originalMode).catch(() => undefined);
    try {
      await fs.rename(tmpPath, filePath);
    } catch (renameErr) {
      // 目标已存在且 rename 拒绝覆盖:先删除目标再重试(有 .bak 兜底)。降级再失败
      // 时,先把原内容写回 file(删除目标可能已让原文件消失 —— 绝不能让归一化
      // 把 resume 需要的转录弄丢,宁可不生效也要保持原文件可用),tmp 清理后抛错
      // 由调用方 best-effort 兜底继续(copilot review)。
      const code = (renameErr as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
        try {
          await fs.rm(filePath, { force: true });
          await fs.rename(tmpPath, filePath);
        } catch (fallbackErr) {
          await fs
            .writeFile(filePath, original, { encoding: 'utf8', mode: originalMode })
            .catch(() => undefined);
          await fs.chmod(filePath, originalMode).catch(() => undefined);
          await fs.rm(tmpPath, { force: true }).catch(() => undefined);
          throw fallbackErr;
        }
      } else {
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        throw renameErr;
      }
    }
  }
  const { text: _, ...rest } = normalized;
  return { filePath, ...rest, ...(backupPath ? { backupPath } : {}) };
}
