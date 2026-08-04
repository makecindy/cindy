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
  // 提取条目所属 subagent/child 身份(顶层 parentUuid 或 parent_tool_use_id):
  // 并发 subagent 可能 mint 相同 tool id, result 需按 parent 配对避免 swap
  // (codex-connector P2: Key subagent tool results by parent)。
  // 用**原始** parent id 做配对 key: result 行的原始 parent 与对应 child call 的
  // 原始 parent 相同(即使该 parent 是重铸的 Kimi id, 两个 subagent 都带 Task_1),
  // 按「同 rawParent 的 FIFO」配对 —— 而不是终 id(终 id 化后 Task_x1 / Task_1_dup2
  // 反而无法用原始 Task_1 关联), 也不是全局 batch(交错时 lastAssistantBatch 错配)。
  const parentKeyOf = (entry: JsonObject): string | undefined => {
    const p = entry.parent_tool_use_id ?? entry.parentUuid;
    return typeof p === 'string' && p ? p : undefined;
  };
  // openCalls[originalId] = 该 id 尚未配对的 call,按出现顺序;每项带所在
  // assistant 消息 index(batch)与 parent 身份,用于「同批同 parent 内顺序配对」。
  const openCalls = new Map<string, Array<{ originalId: string; finalId: string; batch: number; parentKey?: string }>>();
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
        stack.push({ originalId, finalId, batch: index, parentKey: parentKeyOf(entry) });
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
        let matched: { originalId: string; finalId: string; batch: number; parentKey?: string } | undefined;
        if (stack) {
          // 优先配「同 rawParent 的 FIFO」: 并发 subagent mint 相同 tool id 时, result
          // 属于哪个 subagent 由 parent 身份决定 —— 用原始 parent id 分组, 组内按
          // 出现序 FIFO 配对(第一个 result 配第一个同 parent 调用)。
          // 不能用全局 lastAssistantBatch(交错时 A 的 assistant 行被 B 顶掉, A 的
          // result 错配给 B), 也不能用终 id 化 parent(同原始 Task_1 归一化后变成
          // Task_x1 / Task_1_dup2, 无法用原始 Task_1 关联回)。
          // (codex-connector P2: Key subagent tool results by parent / Use normalized
          // parent IDs)。
          // **同批 FIFO, 跨批取最新**: 并发 subagent 的同批 parallel calls 按出现序
          // FIFO(各配各次); 孤儿 + 重铸(跨批)时 result 属于**最新 retry**(重铸 call),
          // 而非最早的孤儿 —— 恒取 sameParent[0] 会把 result 改写为 stale 孤儿 id,
          // 真实重铸 call 反而失配(codex-connector P1: Keep same-parent orphan
          // retries on the newest call)。同批判断用「最近 assistant 批」(即该 result
          // 紧跟的 child 批)。
          const resultParent = parentKeyOf(entry);
          const sameParent = resultParent !== undefined
            ? stack.filter((c) => c.parentKey === resultParent)
            : stack;
          const candidates = sameParent.length > 0 ? sameParent : stack;
          if (resultParent !== undefined && sameParent.length > 0) {
            const sameBatch = sameParent.filter((c) => c.batch === lastAssistantBatch);
            matched = sameBatch.length > 0 ? sameBatch[0] : sameParent[sameParent.length - 1];
          } else {
            const batchMatch = candidates.find((c) => c.batch === lastAssistantBatch);
            matched = batchMatch ?? candidates[candidates.length - 1];
          }
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
    // task 记录(task_started/progress/notification)的稳定标识是 task_id, per-row 的
    // uuid 只是临时记录 id —— 若 uuid 优先, 同一 task 的多条记录(uuid 各不相同)
    // 不共享 task 级映射, 各自消费下一个 duplicate occurrence, 把单个 task 拆散到
    // 多张 Agent/Task 卡片。task_id 存在时优先, uuid 仅作 fallback
    // (codex-connector P2: Prefer task IDs before per-row UUIDs)。
    const childKeyOf = (entry: JsonObject): string | undefined => {
      if (typeof entry.task_id === 'string' && entry.task_id) return `task:${entry.task_id}`;
      if (typeof entry.uuid === 'string' && entry.uuid) return `uuid:${entry.uuid}`;
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
    // 带 parent 的 content_block_start 专用: 匹配「最近的 future occurrence」——
    // 父 Agent/Task 与子 tool 同原始 id 时, 子调用通常是更晚的 future(父先出现),
    // content_block_start 应指向子; 单 occurrence 时匹配唯一。无 future(assistant 后
    // 的 child start)时 fallback 最近之前 —— 子 occurrence 仍在父之后, 命中子而非父
    // (codex-connector P1: Map post-assistant stream starts to the child occurrence)。
    // 不推进 aheadPtr(不与其他无 parent 的 start FIFO 共享)。
    const resolveLastFuture = (val: string, index: number): string | undefined => {
      const occs = occurrenceByOriginal.get(val);
      if (!occs || occs.length === 0) return undefined;
      // 带 parent 的 content_block_start 描述子/新调用: 匹配**最后一个** line >= index
      // 的 future occurrence(父 Agent/Task 与子 tool 同 id 时, 子调用是更晚的 future,
      // 取最后一个而非最近的那个 —— 「Resolve nested」场景 line 0 的 start 应匹配
      // 子 Task_1_dup2 而非父 Task_x1)。扫全量 future(不是遇到 line < index 就 break,
      // 否则等价于总取 occs 末尾, 把较早的 start 错挂到更晚的重铸调用,
      // copilot P1-A / codex-connector P1: Map child stream starts to the nearest
      // occurrence)。
      let lastFuture: { line: number; finalId: string } | undefined;
      for (let i = 0; i < occs.length; i += 1) {
        if (occs[i].line >= index) lastFuture = occs[i];
      }
      if (lastFuture) return lastFuture.finalId;
      // 无 future(assistant 后的 child start): 取最近的过去 —— 最后一个 line < index
      // 的 occurrence(子 occurrence 仍在父之后, 命中子而非父)。
      return occs[occs.length - 1].finalId;
    };
    // 带 child 身份(顶层 uuid / task_id)的记录: 同一 child 复用已解析终 id(首次解析
    // 后缓存), 不按条消费 occurrence —— 同一条 subagent 流 / task 的后续事件不会被
    // 重映射到下一个 occurrence 拆散。
    // 解析顺序: **后顾优先**(引用「之前最近的同名 call」)。标量 parent_tool_use_id /
    // tool_use_id 引用**已启动的父 Agent/Task 调用** —— subagent/task 记录出现在其父
    // 调用之后, 后顾语义正确(如两个并行 Agent/Task 调用, subagent-1 挂首次、subagent-2
    // 挂重铸)。前瞻优先会把这些「引用已完成调用」的记录错配到未来的重铸调用。
    // content_block_start 的 id 才是「预告未来 tool card」, 独立走 resolveAhead(前瞻)。
    // 后顾 miss(记录先于一切同名调用)时 fallback 前瞻, 覆盖重铸新 child 先于其
    // assistant 的场景。
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
    // summary 数组独立游标: preceding_tool_use_ids 的每一项映射到「该 summary 行之前
    // 的 occurrences 的**尾部**」 —— 数组长度 N 覆盖最近 N 个调用(内容顺序)。
    // **不共享 occPtr / aheadPtr / childRef**: 标量/child 字段的改写会推进共享指针,
    // 若数组项用同一 occPtr, 前面 child 记录先消费后, 数组起点错位 —— 如
    // ['Task_1','Task_1'] 在 task/stream 行之后会归一化成 ['Task_1_dup2','Task_1_dup2']
    // 而非 [首个, 第二个], 挂错 tool card(codex-connector P2: Keep summary occurrence
    // cursors independent)。
    // **尾部映射而非全局计数**: 只总结第二个调用时, 单个 summary item ['Bash_5'] 应
    // 指向最近那个调用(Bash_5_dup2)而非全局计数从 occurrence 0 开始指向首个 ——
    // summary 覆盖「实际产生 summary 的最近 N 个调用」(codex-connector P2: Map summary
    // IDs from the summary row)。
    const resolveSummaryItems = (arr: unknown[], index: number): Array<string | undefined> => {
      // 统计数组内每个 id 的出现次数 —— 决定该 id 在 eligible 中的尾部偏移。
      const arrCount = new Map<string, number>();
      for (const item of arr) {
        if (typeof item !== 'string') continue;
        arrCount.set(item, (arrCount.get(item) ?? 0) + 1);
      }
      const consumed = new Map<string, number>();
      const out: Array<string | undefined> = [];
      for (const item of arr) {
        if (typeof item !== 'string') {
          out.push(undefined);
          continue;
        }
        const occs = occurrenceByOriginal.get(item);
        if (!occs || occs.length === 0) {
          out.push(undefined);
          continue;
        }
        // 行作用域: 只取该行之前的同名 occurrences。
        const eligible = occs.filter((o) => o.line < index);
        if (eligible.length === 0) {
          out.push(undefined);
          continue;
        }
        const totalForId = arrCount.get(item) ?? 0;
        const k = consumed.get(item) ?? 0;
        consumed.set(item, k + 1);
        const offset = eligible.length - totalForId; // 尾部偏移: 覆盖最近 totalForId 个
        const idx = offset + k;
        out.push(idx >= 0 && idx < eligible.length ? eligible[idx].finalId : eligible[eligible.length - 1].finalId);
      }
      return out;
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
      // tool_use_summary 的 preceding_tool_use_ids 数组: 逐项按调用顺序消费 occurrence。
      // 数组项**绕过 entryRef / childRef 缓存**: 每一项对应一个独立的 tool call,
      // 同一 id 重复出现是两个重复调用, 需各自消费 occurrence —— 若走 resolveField,
      // 同 entry 内同 id 的缓存会让 ['Bash_5','Bash_5'] 变成 ['Bash_x5','Bash_x5'],
      // 而不是消费第二个 occurrence 得 Bash_5_dup2, resume/import 把第二个 summary
      // 挂到错误的 tool card 上(codex-connector P2: Resolve repeated summary IDs
      // independently)。用独立游标 resolveSummaryItem(见上), 不受标量/child 改写的
      // 共享 occPtr 污染(codex-connector P2: Keep summary occurrence cursors
      // independent)。
      const arr = entry.preceding_tool_use_ids;
      if (Array.isArray(arr) && arr.length > 0) {
        const mappedItems = resolveSummaryItems(arr, index);
        for (let i = 0; i < arr.length; i += 1) {
          const mapped = mappedItems[i];
          const item = arr[i];
          if (typeof item !== 'string' || mapped === undefined || mapped === item) continue;
          arr[i] = mapped;
          entryChanged = true;
        }
      }
      // stream_event 的 event.content_block.id(content_block_start 的 tool_use)也要
      // 改写: handleStreamEvent 用它驱动 tool-use start / tool-name 状态, replay/import
      // 会以旧 id 发 tool card, 与归一化后的 tool_result / summary 指向不一致
      // (codex-connector P2: Rewrite stream-event tool IDs too)。
      // **独立解析, 绕过 entryRef**: content_block.id 是「当前正在流的 tool 调用」,
      // 与顶层 parent_tool_use_id(父 agent 调用)语义不同 —— 即使字符串相同
      // (如父 Task_1 与子自己启动的首个 Task_1), 也指向不同 occurrence。若走
      // resolveField, 父的映射被缓存后嵌套复用, replay/import 把子 tool 挂到父 id 下
      // (codex-connector P1: Resolve nested stream IDs independently)。
      // **归属区分**: 带顶层 parent_tool_use_id 的 content_block_start 属于某 child,
      // 走 resolveForEntry(后顾优先, 匹配该 child 的最近 occurrence —— 即使 start 落
      // 在 child assistant 之后, fallback 也命中子 occurrence 而非父 occurrence,
      // codex-connector P1: Map post-assistant stream starts to the child occurrence);
      // 不带 parent 的主流程 tool 预告走 resolveAhead(前瞻, 匹配即将出现的调用,
      // codex-connector P2: Map pre-assistant duplicate stream IDs forward)。
      const evt = entry.event;
      if (isRecord(evt) && evt.type === 'content_block_start') {
        const cb = evt.content_block;
        if (isRecord(cb) && cb.type === 'tool_use' && typeof cb.id === 'string' && cb.id.length > 0) {
          const mapped = typeof entry.parent_tool_use_id === 'string' && entry.parent_tool_use_id
            ? resolveLastFuture(cb.id, index)
            : resolveAhead(cb.id, index);
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
  // rename 降级失败时从 .bak 备份恢复成功 → 归一化未生效但转录仍在(见下)。
  let recoveredFromBackup = false;
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
          // writeFile 写回失败不能静默吞掉 —— 原文件已被删除、转录缺失会阻断
          // resume。备份 .bak 已就位:优先从备份恢复(copyFile),保证 filePath 仍可
          // 被 resume 读取(copilot review);备份恢复也失败时,保留 writeFile 尝试
          // 并暴露 fallbackErr(调用方 best-effort 兜底继续)。
          await fs.rm(tmpPath, { force: true }).catch(() => undefined);
          if (backupPath) {
            try {
              await fs.copyFile(backupPath, filePath);
              await fs.chmod(filePath, originalMode).catch(() => undefined);
              recoveredFromBackup = true; // 备份恢复成功 → 归一化未生效但转录仍在
            } catch {
              // 备份恢复失败:落 writeFile 兜底(也失败则抛 fallbackErr)。
            }
          }
          if (!recoveredFromBackup) {
            await fs
              .writeFile(filePath, original, { encoding: 'utf8', mode: originalMode })
              .catch(() => undefined);
            await fs.chmod(filePath, originalMode).catch(() => undefined);
            throw fallbackErr;
          }
        }
      } else {
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        throw renameErr;
      }
    }
  }
  if (recoveredFromBackup) {
    // 归一化未生效(rename 降级失败,从备份恢复原文):复用 normalized 的全部统计
    // 字段, 仅把 changed 覆盖为 false —— 不误导调用方以为已归一化, 也满足返回
    // 类型的必填字段(lineCount / skipped / dedupedBlockCount 等, copilot review)。
    const { text: _, ...rest } = normalized;
    return { filePath, ...rest, changed: false, ...(backupPath ? { backupPath } : {}) };
  }
  const { text: _, ...rest } = normalized;
  return { filePath, ...rest, ...(backupPath ? { backupPath } : {}) };
}
