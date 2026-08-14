import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeClaudeJsonlToolIdsText,
  normalizeClaudeSessionJsonlToolIds,
} from '../jsonl-tool-id-normalize.js';

// ── 测试夹具:按 CC 转录形态构造 jsonl 行 ────────────────────────────────

function assistantEntry(uuid: string, blocks: unknown[], parentUuid?: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    ...(parentUuid ? { parentUuid } : {}),
    message: { role: 'assistant', content: blocks },
  });
}

function userEntry(uuid: string, blocks: unknown[], parentUuid?: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    ...(parentUuid ? { parentUuid } : {}),
    message: { role: 'user', content: blocks },
  });
}

function toolUse(id: string, name = 'Bash'): Record<string, unknown> {
  return { type: 'tool_use', id, name, input: {} };
}

function toolResult(toolUseId: string, text = 'ok'): Record<string, unknown> {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text };
}

function parseEntries(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function contentOf(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return (entry.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
}

/** 所有 tool_use(call)id —— exchange 的唯一性按 call 判定(result 与 call 共享 id)。 */
function allCallIds(text: string): string[] {
  const ids: string[] = [];
  for (const entry of parseEntries(text)) {
    for (const b of contentOf(entry)) {
      if (b.type === 'tool_use') ids.push(b.id as string);
    }
  }
  return ids;
}

// ── 文本级归一化 ────────────────────────────────────────────────────────

describe('normalizeClaudeJsonlToolIdsText', () => {
  it('无 tool_use 的会话原样返回(同引用)', () => {
    const text = [
      userEntry('u1', [{ type: 'text', text: '你好' }]),
      assistantEntry('a1', [{ type: 'text', text: '你好!' }]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.text).toBe(text);
  });

  it('Anthropic 原生 toolu_* id 不受影响(预扫不命中)', () => {
    const text = [
      assistantEntry('a1', [toolUse('toolu_01Jx4AbC')]),
      userEntry('u1', [toolResult('toolu_01Jx4AbC')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.text).toBe(text);
  });

  it('kimi 铸造 id 无重复时只做铸造空间偏移,配对保持', () => {
    const text = [
      assistantEntry('a1', [{ type: 'thinking', thinking: '想', signature: '' }, toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
      assistantEntry('a2', [toolUse('TaskCreate_35', 'TaskCreate')]),
      userEntry('u2', [toolResult('TaskCreate_35')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    expect(result.dedupedBlockCount).toBe(0);
    expect(result.offsetBlockCount).toBe(4);
    const entries = parseEntries(result.text);
    const [call1] = contentOf(entries[0]).filter((b) => b.type === 'tool_use');
    const [res1] = contentOf(entries[1]);
    expect(call1.id).toBe('Bash_x210');
    expect(res1.tool_use_id).toBe('Bash_x210');
    expect(contentOf(entries[2])[0].id).toBe('TaskCreate_x35');
    expect(contentOf(entries[3])[0].tool_use_id).toBe('TaskCreate_x35');
  });

  it('幂等: 归一化结果再过一遍零改写', () => {
    const text = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
      assistantEntry('a2', [toolUse('Bash_210')]),
      userEntry('u2', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const once = normalizeClaudeJsonlToolIdsText(text);
    expect(once.changed).toBe(true);
    const twice = normalizeClaudeJsonlToolIdsText(once.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it('重复 id: 第 N 次出现去重为 _dupN,result 位置配对取同一终 id', () => {
    // 复刻事故形态: 同一 Bash_210 被铸造两次(两个 exchange)
    const text = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210', '第一次结果')]),
      assistantEntry('a2', [{ type: 'text', text: '继续' }, toolUse('Bash_210')]),
      userEntry('u2', [toolResult('Bash_210', '第二次结果')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    expect(result.duplicateIdCount).toBe(1);
    expect(result.dedupedBlockCount).toBe(2); // 第二次 call + 第二个 result

    const entries = parseEntries(result.text);
    // 首现保持原 id(再被偏移); 第二次出现去重为 _dup2(不再匹配偏移规则)
    expect(contentOf(entries[0])[0].id).toBe('Bash_x210');
    expect(contentOf(entries[1])[0].tool_use_id).toBe('Bash_x210');
    const a2Blocks = contentOf(entries[2]);
    expect(a2Blocks[a2Blocks.length - 1].id).toBe('Bash_210_dup2');
    expect(contentOf(entries[3])[0].tool_use_id).toBe('Bash_210_dup2');
  });

  it('同批 parallel 同 id call: result 按内容顺序配对,不 swap(codex-connector P2)', () => {
    // 同一 assistant 消息内两个同 id tool_use(病态但存在), 后随 user 消息的
    // tool_result 按调用顺序: 修复前 LIFO pop 会倒配(第一个 result 配第二个
    // call, 输出 swap)。同批内必须按出现序(FIFO)配对。
    const text = [
      assistantEntry('a1', [toolUse('Bash_5'), toolUse('Bash_5')]), // 同批 parallel
      userEntry('u1', [toolResult('Bash_5', '第一个结果'), toolResult('Bash_5', '第二个结果')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    // 第一个 call 保持首现(偏移), 第二个 call 去重为 _dup2
    expect(contentOf(entries[0])[0].id).toBe('Bash_x5');
    expect(contentOf(entries[0])[1].id).toBe('Bash_5_dup2');
    // 第一个 result 配第一个 call(顺序), 第二个 result 配第二个 call —— 不 swap
    expect(contentOf(entries[1])[0].tool_use_id).toBe('Bash_x5');
    expect(contentOf(entries[1])[1].tool_use_id).toBe('Bash_5_dup2');
  });

  it('并发 subagent 同 minted id: result 按 parent 身份配对,不 swap(P2: Key subagent tool results by parent)', () => {
    // subagent A 和 B 各自 mint Bash_1(不同 parent)。若 result 只按全局 lastAssistantBatch
    // 配对, A 的 assistant 行被 B 顶掉后, A 的 result 会错配给 B 的调用 → swap。
    // 用 parent 身份(顶层 parentUuid)隔离配对。
    const text = [
      assistantEntry('aA', [toolUse('Bash_1')], 'parent-A'), // subagent A 的调用
      assistantEntry('aB', [toolUse('Bash_1')], 'parent-B'), // subagent B 的调用
      userEntry('uA', [toolResult('Bash_1', 'A 的结果')], 'parent-A'), // A 的 result(先到)
      userEntry('uB', [toolResult('Bash_1', 'B 的结果')], 'parent-B'), // B 的 result
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    // 两个调用分别定终
    expect(contentOf(entries[0])[0].id).toBe('Bash_x1');
    expect(contentOf(entries[1])[0].id).toBe('Bash_1_dup2');
    // A 的 result 配 A 的调用(Bash_x1), B 的 result 配 B 的调用(Bash_1_dup2) —— 不 swap
    expect(contentOf(entries[2])[0].tool_use_id).toBe('Bash_x1');
    expect(contentOf(entries[3])[0].tool_use_id).toBe('Bash_1_dup2');
  });

  it('并发 subagent 同重铸 parent id: 同批并行 child 调用,result 按 parent 配对不 swap(P2: Key subagent tool results by parent)', () => {
    // 两个 subagent 的 parent_tool_use_id 都是重铸的 Task_1(父 Agent/Task 调用重铸两次),
    // 它们的 child 调用在同一 assistant 行(同批并行)。若 result 只按全局 batch 配对会
    // 错配; 用 parent 身份隔离, 同批内按出现序 FIFO。
    const text = [
      assistantEntry('aParent1', [toolUse('Task_1')], 'parent-task'), // 父调用 1 → Task_x1
      assistantEntry('aParent2', [toolUse('Task_1')], 'parent-task'), // 父调用 2 → Task_1_dup2
      // A、B 的 child 调用同批并行(同一 assistant 行, 各自 parent 原始 Task_1)
      assistantEntry('aChild', [toolUse('Bash_1'), toolUse('Bash_1')], 'Task_1'),
      // A 的 result 先到 → 配 A 的调用(第一个 Bash_1)
      userEntry('uA', [toolResult('Bash_1', 'A 的结果')], 'Task_1'),
      // B 的 result → 配 B 的调用(第二个 Bash_1)
      userEntry('uB', [toolResult('Bash_1', 'B 的结果')], 'Task_1'),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    // 父调用定终
    expect(contentOf(entries[0])[0].id).toBe('Task_x1');
    expect(contentOf(entries[1])[0].id).toBe('Task_1_dup2');
    // 子调用定终
    expect(contentOf(entries[2]).map((b) => b.id)).toEqual(['Bash_x1', 'Bash_1_dup2']);
    // A 的 result 配 A 的调用(Bash_x1), B 的配 B 的(Bash_1_dup2) —— 不 swap
    expect(contentOf(entries[3])[0].tool_use_id).toBe('Bash_x1');
    expect(contentOf(entries[4])[0].tool_use_id).toBe('Bash_1_dup2');
  });

  it('同 parent 孤儿 call + 重铸 call: result 配最新 retry,非 stale 孤儿(P1: Keep same-parent orphan retries on the newest call)', () => {
    // 同一 parent 下, 孤儿 Bash_5(中断无 result) + 重铸 Bash_5(真实执行)。
    // 跨批时 result 属于最新 retry(重铸 call) —— 恒取 sameParent[0](孤儿)会改写为
    // stale 孤儿 id, 真实重铸 call 失配。
    const text = [
      assistantEntry('aOrphan', [toolUse('Bash_5')], 'parent-X'), // 孤儿(中断)
      assistantEntry('aRetry', [toolUse('Bash_5')], 'parent-X'), // 重铸(真实执行)
      userEntry('u1', [toolResult('Bash_5', '真实结果')], 'parent-X'),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('Bash_x5'); // 孤儿
    expect(contentOf(entries[1])[0].id).toBe('Bash_5_dup2'); // 重铸
    // result 配最新 retry(重铸 Bash_5_dup2), 不配孤儿 Bash_x5
    expect(contentOf(entries[2])[0].tool_use_id).toBe('Bash_5_dup2');
  });

  it('位置配对: 孤儿 call + 重铸 call 并存时 result 配给真实执行的那次', () => {
    // 孤儿 Bash_5(无 result,中断残留) + 重铸 Bash_5(有 result):
    // 出现序配对会把 result 错配给孤儿,位置配对必须配给重铸 call。
    const text = [
      assistantEntry('a1', [toolUse('Bash_5')]), // 孤儿(中断,无 result)
      assistantEntry('a2', [toolUse('Bash_5')]), // 重铸(真实执行)
      userEntry('u1', [toolResult('Bash_5', '真实结果')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('Bash_x5'); // 孤儿保持首现 → 偏移
    expect(contentOf(entries[1])[0].id).toBe('Bash_5_dup2'); // 重铸去重
    expect(contentOf(entries[2])[0].tool_use_id).toBe('Bash_5_dup2'); // result 配给重铸 call
  });

  it('超编 result(无未配对 call)保持原 id 不动,但随铸造空间偏移', () => {
    // 一个 call、两个 result(病态残留): 第二个 result 无 call 可配 → 不改名
    const text = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210'), toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    const results = contentOf(entries[1]);
    expect(results[0].tool_use_id).toBe('Bash_x210');
    expect(results[1].tool_use_id).toBe('Bash_x210'); // 超编不去重,但偏移保持与 call 一致
    expect(result.dedupedBlockCount).toBe(0);
  });

  it('P1-C: 既有 _dup2 产物时,新重复去重顺延到 _dup3', () => {
    // 转录里已有上一轮改名产物 Bash_210_dup2,又出现 Bash_210×2:
    // 第二次出现若还改 Bash_210_dup2 就撞上既有 id(修复本身复发事故)。
    const text = [
      assistantEntry('a0', [toolUse('Bash_210_dup2')]),
      userEntry('u0', [toolResult('Bash_210_dup2')]),
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
      assistantEntry('a2', [toolUse('Bash_210')]),
      userEntry('u2', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('Bash_210_dup2'); // 既有产物不动
    expect(contentOf(entries[2])[0].id).toBe('Bash_x210');
    expect(contentOf(entries[4])[0].id).toBe('Bash_210_dup3'); // 顺延,不撞既有 _dup2
    expect(contentOf(entries[5])[0].tool_use_id).toBe('Bash_210_dup3');
    // 全文件 call id 唯一(result 与配对 call 共享 id,不纳入唯一性判定)
    expect(new Set(allCallIds(result.text)).size).toBe(allCallIds(result.text).length);
  });

  it('P1-B: 既有 _x 偏移产物时,新同号 id 偏移顺延为 _xx', () => {
    // 上轮归一化产物 Bash_x210 + resume 后 kimi 重铸的 Bash_210:
    // 偏移若还改 Bash_x210 即撞车。
    const text = [
      assistantEntry('a0', [toolUse('Bash_x210')]),
      userEntry('u0', [toolResult('Bash_x210')]),
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('Bash_x210'); // 既有产物不动
    expect(contentOf(entries[2])[0].id).toBe('Bash_xx210'); // 顺延
    expect(contentOf(entries[3])[0].tool_use_id).toBe('Bash_xx210');
    expect(new Set(allCallIds(result.text)).size).toBe(allCallIds(result.text).length);
    // 顺延结果幂等:二次运行零改写
    expect(normalizeClaudeJsonlToolIdsText(result.text).changed).toBe(false);
  });

  it('MCP 下划线工具名的铸造 id 同样处理(P1-E)', () => {
    const text = [
      assistantEntry('a1', [toolUse('mcp__cindy_memory__call_tool_5', 'mcp__cindy_memory__call_tool')]),
      userEntry('u1', [toolResult('mcp__cindy_memory__call_tool_5')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('mcp__cindy_memory__call_tool_x5');
    expect(contentOf(entries[1])[0].tool_use_id).toBe('mcp__cindy_memory__call_tool_x5');
  });

  it('带连字符的 MCP 工具名(id 含 -)同样处理(codex-connector P1)', () => {
    // Claude MCP 前缀保留连字符(capability-routing.ts): mcp__feishu-delegate__...
    const text = [
      assistantEntry('a1', [
        toolUse('mcp__feishu-delegate__feishu_read_messages_5', 'mcp__feishu-delegate__feishu_read_messages'),
      ]),
      userEntry('u1', [toolResult('mcp__feishu-delegate__feishu_read_messages_5')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('mcp__feishu-delegate__feishu_read_messages_x5');
    expect(contentOf(entries[1])[0].tool_use_id).toBe('mcp__feishu-delegate__feishu_read_messages_x5');
  });

  it('不触碰非 message 条目与 tool input 里的同名字符串', () => {
    const queueOp = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<tool-use-id>Bash_210</tool-use-id>',
    });
    const withInput = assistantEntry('a1', [
      { type: 'tool_use', id: 'Bash_210', name: 'Bash', input: { command: 'echo Bash_210' } },
    ]);
    const text = [queueOp, withInput, userEntry('u1', [toolResult('Bash_210')])].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    const lines = result.text.trim().split('\n');
    // queue-operation 行保持原始字节
    expect(lines[0]).toBe(queueOp);
    // tool_use.id 被偏移, input.command 里的字符串不动
    const call = contentOf(parseEntries(result.text)[1])[0];
    expect(call.id).toBe('Bash_x210');
    expect((call.input as Record<string, unknown>).command).toBe('echo Bash_210');
  });

  it('subagent 记录顶层 parent_tool_use_id 跟随 tool_use 改名(codex-connector P2)', () => {
    // Claude subagent 记录在顶层带 parent_tool_use_id 引用父 agent 的 tool_use id,
    // 归一化改名后必须同步, 否则 subagent 关联断裂(translator 用其作 parentToolUseId)。
    const text = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-1',
        parent_tool_use_id: 'Bash_210',
        event: { type: 'message_start', message: { model: 'kimi-k3', usage: {} } },
      }),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    // tool_use 被偏移为 Bash_x210
    expect(contentOf(entries[0])[0].id).toBe('Bash_x210');
    // 顶层 parent_tool_use_id 同步为 Bash_x210
    expect((entries[2] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_x210');
  });

  it('同 id 重铸多次时 subagent 顶层字段按**行作用域**配对(codex-connector P2)', () => {
    // 单一 last mapping 会把所有 subagent 记录挂到最后一个 duplicate; 这里验证
    // 位置配对: 每个 stream_event 引用「它所在位置之前最近的同名 call」的终 id。
    const text = [
      // 首次调用 → Bash_x210
      assistantEntry('a1', [toolUse('Bash_210')]),
      // 紧随首次调用的 subagent 记录 → 应挂 Bash_x210
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-1',
        parent_tool_use_id: 'Bash_210',
        tool_use_id: 'Bash_210',
        event: { type: 'message_start', message: { model: 'kimi-k3', usage: {} } },
      }),
      userEntry('u1', [toolResult('Bash_210')]),
      // 重铸的第二次调用 → Bash_210_dup2
      assistantEntry('a2', [toolUse('Bash_210')]),
      // 紧随重铸调用的 subagent 记录 → 应挂 Bash_210_dup2
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-2',
        parent_tool_use_id: 'Bash_210',
        tool_use_id: 'Bash_210',
        event: { type: 'message_start', message: { model: 'kimi-k3', usage: {} } },
      }),
      userEntry('u2', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    // 两次调用分别定终
    expect(contentOf(entries[0])[0].id).toBe('Bash_x210');
    expect(contentOf(entries[3])[0].id).toBe('Bash_210_dup2');
    // 行作用域: 第一次调用后的 subagent 挂首次终 id
    expect((entries[1] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_x210');
    expect((entries[1] as Record<string, unknown>).tool_use_id).toBe('Bash_x210');
    // 第二次调用后的 subagent 挂重铸终 id —— 不误挂到首个
    expect((entries[4] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_210_dup2');
    expect((entries[4] as Record<string, unknown>).tool_use_id).toBe('Bash_210_dup2');
  });

  it('tool_use_summary 顶层 preceding_tool_use_ids 数组跟随改名(codex-connector P2)', () => {
    // translator 把 preceding_tool_use_ids 转发为 tool_result.data.toolUseIds, 归一化
    // 改名后数组必须同步, 否则 summary 事件挂不上归一化后的 tool 卡片。
    const text = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
      JSON.stringify({
        type: 'tool_use_summary',
        summary: 'ran a command',
        preceding_tool_use_ids: ['Bash_210'],
      }),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    // tool_use 被偏移为 Bash_x210
    expect(contentOf(entries[0])[0].id).toBe('Bash_x210');
    // summary 数组项同步为 Bash_x210
    expect((entries[2] as Record<string, unknown>).preceding_tool_use_ids).toEqual(['Bash_x210']);
  });

  it('preceding_tool_use_ids 数组重复 id 独立消费 occurrence, 不缓存复用(P2: Resolve repeated summary IDs independently)', () => {
    // 同行两个重复 Bash_5 调用 → Bash_x5 + Bash_5_dup2。summary 数组 ['Bash_5','Bash_5']
    // 若走 entry 缓存会变成 ['Bash_x5','Bash_x5'](第二次复用首次结果), 第二个 summary
    // 挂到错误的 tool card。数组项必须各自消费 occurrence: 第一项 Bash_x5, 第二项 Bash_5_dup2。
    const text = [
      assistantEntry('a1', [toolUse('Bash_5'), toolUse('Bash_5')]),
      userEntry('u1', [toolResult('Bash_5'), toolResult('Bash_5')]),
      JSON.stringify({
        type: 'tool_use_summary',
        summary: 'ran commands',
        preceding_tool_use_ids: ['Bash_5', 'Bash_5'],
      }),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0]).map((b) => b.id)).toEqual(['Bash_x5', 'Bash_5_dup2']);
    // 数组重复项各自消费: 第一项首个调用, 第二项第二个调用
    expect((entries[2] as Record<string, unknown>).preceding_tool_use_ids).toEqual(['Bash_x5', 'Bash_5_dup2']);
  });

  it('child/task 记录先消费 occPtr 后, summary 数组仍按调用顺序(P2: Keep summary occurrence cursors independent)', () => {
    // 两个重复 Task_1 调用后, 先有 child/task 记录(推进共享 occPtr), 再出现 summary
    // 数组 ['Task_1','Task_1']。若数组用共享 occPtr, 起点被 child 改写推到第二个
    // occurrence, 变成 ['Task_1_dup2','Task_1_dup2'] 而非 [首个, 第二个]。数组必须
    // 用独立游标, 不受标量/child 消费污染。
    const text = [
      assistantEntry('a1', [toolUse('Task_1'), toolUse('Task_1')]),
      JSON.stringify({
        type: 'task_progress',
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'Task_1',
        status: 'running',
      }),
      JSON.stringify({
        type: 'tool_use_summary',
        summary: 'ran tasks',
        preceding_tool_use_ids: ['Task_1', 'Task_1'],
      }),
      userEntry('u1', [toolResult('Task_1'), toolResult('Task_1')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0]).map((b) => b.id)).toEqual(['Task_x1', 'Task_1_dup2']);
    // child 记录挂首个调用(childRef 复用)
    expect((entries[1] as Record<string, unknown>).tool_use_id).toBe('Task_x1');
    // summary 数组独立游标: 不受 child 消费污染, 按调用顺序 [首个, 第二个]
    expect((entries[2] as Record<string, unknown>).preceding_tool_use_ids).toEqual(['Task_x1', 'Task_1_dup2']);
  });

  it('单 item summary 指向实际产生 summary 的调用(该行之前最近的)(P2: Map summary IDs from the summary row)', () => {
    // 只总结第二个调用(第一个 result 短没 summary)时, summary 数组单个 item 应指向
    // 第二个 occurrence(Bash_5_dup2), 而非全局计数从 occurrence 0 开始指向首个。
    // 数组按该 summary 行之前的 occurrences 行作用域解析。
    const text = [
      assistantEntry('a1', [toolUse('Bash_5'), toolUse('Bash_5')]),
      userEntry('u1', [toolResult('Bash_5'), toolResult('Bash_5')]),
      JSON.stringify({
        type: 'tool_use_summary',
        summary: 'ran the second command',
        preceding_tool_use_ids: ['Bash_5'],
      }),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0]).map((b) => b.id)).toEqual(['Bash_x5', 'Bash_5_dup2']);
    // 行作用域 + per-summary 游标: 单 item 从该行之前 occurrences 的【最近】匹配
    expect((entries[2] as Record<string, unknown>).preceding_tool_use_ids).toEqual(['Bash_5_dup2']);
  });

  it('同一 assistant 行内同 id 并行调用: 子记录按内容顺序 FIFO 各挂各次(codex-connector P2)', () => {
    // 同一条 assistant 消息含两个 Bash_210(并行) → Bash_x210 + Bash_210_dup2。
    // 两条 subagent 记录引用 Bash_210: 第一条应挂第一个调用(Bash_x210),
    // 第二条挂第二个(Bash_210_dup2) —— 同行块不能折叠成单一 last mapping。
    const text = [
      assistantEntry('a1', [toolUse('Bash_210'), toolUse('Bash_210')]),
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-1',
        parent_tool_use_id: 'Bash_210',
        event: { type: 'message_start', message: { model: 'kimi-k3', usage: {} } },
      }),
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-2',
        parent_tool_use_id: 'Bash_210',
        event: { type: 'message_start', message: { model: 'kimi-k3', usage: {} } },
      }),
      userEntry('u1', [toolResult('Bash_210'), toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    // 同行两个并行调用分别定终: 第一个偏移, 第二个去重
    const callIds = contentOf(entries[0]).map((b) => b.id);
    expect(callIds[0]).toBe('Bash_x210');
    expect(callIds[1]).toBe('Bash_210_dup2');
    // 两条子记录按内容顺序 FIFO: 第一条挂首个调用, 第二条挂第二个
    expect((entries[1] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_x210');
    expect((entries[2] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_210_dup2');
  });

  it('同一 child(共享 uuid)的多条 stream_event 复用同一终 id, 不拆散到多卡片(codex-connector P2)', () => {
    // 同行两个 Bash_210(并行) → Bash_x210 + Bash_210_dup2。
    // 同一 uuid 的 child 发多条 stream_event(都引用 Bash_210): 必须全部挂同一终 id
    // (Bash_x210), 而不是每条事件消费一个 occurrence(否则第一条挂 Bash_x210、
    // 第二条被重新映射到 Bash_210_dup2, 同一 subagent 流被拆散到两张卡片)。
    const childEvent = (uuid: string): string =>
      JSON.stringify({
        type: 'stream_event',
        uuid,
        parent_tool_use_id: 'Bash_210',
        event: { type: 'message_start', message: { model: 'kimi-k3', usage: {} } },
      });
    const text = [
      assistantEntry('a1', [toolUse('Bash_210'), toolUse('Bash_210')]),
      childEvent('stream-child-1'),
      childEvent('stream-child-1'), // 同一 child 的第二条事件
      childEvent('stream-child-1'), // 第三条
      childEvent('stream-child-2'), // 另一 child → 挂第二个调用
      userEntry('u1', [toolResult('Bash_210'), toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    // 同行两个并行调用分别定终
    expect(contentOf(entries[0]).map((b) => b.id)).toEqual(['Bash_x210', 'Bash_210_dup2']);
    // 同一 child 的三条事件全部挂 Bash_x210(首次解析, 不按条推进)
    expect((entries[1] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_x210');
    expect((entries[2] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_x210');
    expect((entries[3] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_x210');
    // 另一 child 挂第二个调用(各 child 独立消费)
    expect((entries[4] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_210_dup2');
  });

  it('stream_event 的 event.content_block.id 跟随归一化改名(P2: Rewrite stream-event tool IDs too)', () => {
    // handleStreamEvent 用 event.content_block.id 驱动 tool-use start 状态; 归一化后
    // 若仍留旧 id, replay/import 会以旧 id 发 tool card, 与 tool_result/summary 指向
    // 不一致。验证嵌套的 event.content_block.id 也被改写。
    const text = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-1',
        parent_tool_use_id: 'Bash_210',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} },
        },
      }),
      userEntry('u1', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('Bash_x210');
    const evt = (entries[1] as Record<string, unknown>).event as Record<string, unknown>;
    expect((evt.content_block as Record<string, unknown>).id).toBe('Bash_x210');
  });

  it('stream_event 先于 assistant 行到达时 content_block.id 前瞻匹配(P2: Handle stream events before assistant rows)', () => {
    // SDK 允许 stream_event 的 content_block_start 先于同 tool call 的 assistant 消息
    // 到达。后顾解析(只看 line < index)在此顺序下找不到 occurrence, content_block.id
    // 会保持旧值 Bash_210, 与后续归一化的 assistant/tool_result(Bash_x210)不一致。
    // 前瞻解析必须匹配「即将出现」的 occurrence。
    const text = [
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-1',
        parent_tool_use_id: 'Bash_210',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} },
        },
      }),
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    // stream_event 在 line 0, assistant 在 line 1: content_block.id 前瞻匹配到 Bash_x210
    const evt = (entries[0] as Record<string, unknown>).event as Record<string, unknown>;
    expect((evt.content_block as Record<string, unknown>).id).toBe('Bash_x210');
    // 顶层 parent_tool_use_id 同样前瞻改写(P1: Forward-map pre-assistant top-level
    // tool refs) —— handleStreamEvent 用它作 parentToolUseId, 必须与 card id 一致
    expect((entries[0] as Record<string, unknown>).parent_tool_use_id).toBe('Bash_x210');
    // 后续 assistant / tool_result 也一致
    expect(contentOf(entries[1])[0].id).toBe('Bash_x210');
  });

  it('两个重复 content_block_start 先于 assistant 时前瞻 FIFO 各匹配各次(P2: Map pre-assistant stream starts by occurrence)', () => {
    // 两个同 id 的 content_block_start 先于 assistant 行到达。若前瞻都取第一个
    // future occurrence, 两条 stream start 都指向 Bash_x5, 而 assistant/tool_result
    // 把 duplicate 分配到 Bash_x5 + Bash_5_dup2 —— 第二个 tool card 以错 id 创建。
    // 前瞻必须按内容顺序 FIFO: 第一条 start → Bash_x5, 第二条 → Bash_5_dup2。
    const startEvent = (id: string): string =>
      JSON.stringify({
        type: 'stream_event',
        uuid: `stream-${id}`,
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'Bash_5', name: 'Bash', input: {} },
        },
      });
    const text = [
      startEvent('s1'), // 第一个 start
      startEvent('s2'), // 第二个 start
      assistantEntry('a1', [toolUse('Bash_5'), toolUse('Bash_5')]),
      userEntry('u1', [toolResult('Bash_5'), toolResult('Bash_5')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    const evt1 = (entries[0] as Record<string, unknown>).event as Record<string, unknown>;
    const evt2 = (entries[1] as Record<string, unknown>).event as Record<string, unknown>;
    // 两条 start 前瞻 FIFO: 第一条挂首个调用, 第二条挂第二个调用
    expect((evt1.content_block as Record<string, unknown>).id).toBe('Bash_x5');
    expect((evt2.content_block as Record<string, unknown>).id).toBe('Bash_5_dup2');
    // assistant 两个调用分别定终
    expect(contentOf(entries[2]).map((b) => b.id)).toEqual(['Bash_x5', 'Bash_5_dup2']);
  });

  it('content_block_start 在 assistant 之后时 fallback 按内容顺序消费(P2: Consume post-assistant stream starts by occurrence)', () => {
    // 两个同 id 的 content_block_start 记录在 assistant 行之后。无 future occurrence
    // 时 fallback 若总返回最后一个(occs[last] = Bash_5_dup2), 两条 start 都指向
    // 第二个调用, 首张 tool card 以错 id 创建/更新。fallback 必须按内容顺序:
    // 第一条 → Bash_x5, 第二条 → Bash_5_dup2。
    const startEvent = (uuid: string): string =>
      JSON.stringify({
        type: 'stream_event',
        uuid,
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'Bash_5', name: 'Bash', input: {} },
        },
      });
    const text = [
      assistantEntry('a1', [toolUse('Bash_5'), toolUse('Bash_5')]),
      userEntry('u1', [toolResult('Bash_5'), toolResult('Bash_5')]),
      startEvent('stream-1'), // assistant 之后的第一个 start
      startEvent('stream-2'), // assistant 之后的第二个 start
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    const evt1 = (entries[2] as Record<string, unknown>).event as Record<string, unknown>;
    const evt2 = (entries[3] as Record<string, unknown>).event as Record<string, unknown>;
    // fallback 按内容顺序: 第一条挂首个调用, 第二条挂第二个调用
    expect((evt1.content_block as Record<string, unknown>).id).toBe('Bash_x5');
    expect((evt2.content_block as Record<string, unknown>).id).toBe('Bash_5_dup2');
    // assistant 两个调用分别定终
    expect(contentOf(entries[0]).map((b) => b.id)).toEqual(['Bash_x5', 'Bash_5_dup2']);
  });

  it('task 记录(task_started/progress/notification)按 task_id 复用同一终 id, 不拆散到多卡片(P2: Reuse task_id)', () => {
    // task 系统记录用 task_id + tool_use_id 标识 child, 通常无 uuid。若按条消费
    // occurrence, 同一条 task 的 progress/notification 会被重映射到下一个 occurrence。
    const taskRow = (taskId: string, subtype: string, status = 'running'): string =>
      JSON.stringify({
        type: 'task_progress',
        subtype,
        task_id: taskId,
        tool_use_id: 'Bash_210',
        status,
      });
    const text = [
      assistantEntry('a1', [toolUse('Bash_210'), toolUse('Bash_210')]),
      taskRow('task-1', 'task_started'),
      taskRow('task-1', 'task_progress'),
      taskRow('task-1', 'task_notification', 'completed'),
      taskRow('task-2', 'task_started'),
      taskRow('task-2', 'task_notification', 'completed'),
      userEntry('u1', [toolResult('Bash_210'), toolResult('Bash_210')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0]).map((b) => b.id)).toEqual(['Bash_x210', 'Bash_210_dup2']);
    // task-1 的三条记录全部挂 Bash_x210(task_id 复用, 不按条推进)
    expect((entries[1] as Record<string, unknown>).tool_use_id).toBe('Bash_x210');
    expect((entries[2] as Record<string, unknown>).tool_use_id).toBe('Bash_x210');
    expect((entries[3] as Record<string, unknown>).tool_use_id).toBe('Bash_x210');
    // task-2 挂第二个调用(各 task 独立消费)
    expect((entries[4] as Record<string, unknown>).tool_use_id).toBe('Bash_210_dup2');
    expect((entries[5] as Record<string, unknown>).tool_use_id).toBe('Bash_210_dup2');
  });

  it('task 记录同时带 task_id + uuid 时优先 task_id 复用(P2: Prefer task IDs before per-row UUIDs)', () => {
    // task 系统记录可能同时带稳定 task_id 和 per-row uuid。若 child 身份优先取 uuid,
    // 同一 task 的多条记录(uuid 各不相同)不共享 task 级映射, 各自消费下一个 duplicate
    // occurrence, 把单个 task 拆散到多张卡片。task_id 必须优先。
    const taskRow = (taskId: string, uuid: string): string =>
      JSON.stringify({
        type: 'task_progress',
        subtype: 'task_progress',
        task_id: taskId,
        uuid,
        tool_use_id: 'Bash_5',
        status: 'running',
      });
    const text = [
      assistantEntry('a1', [toolUse('Bash_5'), toolUse('Bash_5')]),
      taskRow('task-1', 'row-uuid-1'), // 同一 task 两条记录, uuid 各不相同
      taskRow('task-1', 'row-uuid-2'),
      taskRow('task-2', 'row-uuid-3'),
      userEntry('u1', [toolResult('Bash_5'), toolResult('Bash_5')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0]).map((b) => b.id)).toEqual(['Bash_x5', 'Bash_5_dup2']);
    // task-1 两条记录(uuid 不同)因 task_id 复用全部挂 Bash_x5
    expect((entries[1] as Record<string, unknown>).tool_use_id).toBe('Bash_x5');
    expect((entries[2] as Record<string, unknown>).tool_use_id).toBe('Bash_x5');
    // task-2 挂第二个调用
    expect((entries[3] as Record<string, unknown>).tool_use_id).toBe('Bash_5_dup2');
  });

  it('content_block.id 独立解析, 不复用父的 entryRef 映射(P1: Resolve nested stream IDs independently)', () => {
    // 父调用 Task_1 与子自己启动的首个 Task_1 字符串相同但指向不同 occurrence。
    // 若 content_block.id 走 resolveField 复用标量缓存的父映射, replay/import 把子
    // tool 挂到父 id 下。content_block.id 必须独立消费 occurrence。
    const text = [
      JSON.stringify({
        type: 'stream_event',
        uuid: 'child-stream',
        parent_tool_use_id: 'Task_1',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'Task_1', name: 'Task', input: {} },
        },
      }),
      assistantEntry('a1', [toolUse('Task_1')]), // 父调用(第一个 Task_1)
      userEntry('u1', [toolResult('Task_1')]),
      assistantEntry('a2', [toolUse('Task_1')]), // 子调用(第二个 Task_1)
      userEntry('u2', [toolResult('Task_1')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[1]).map((b) => b.id)).toEqual(['Task_x1']);
    expect(contentOf(entries[3]).map((b) => b.id)).toEqual(['Task_1_dup2']);
    // 标量 parent_tool_use_id(父调用)→ 前瞻匹配第一个 Task_1 → Task_x1
    expect((entries[0] as Record<string, unknown>).parent_tool_use_id).toBe('Task_x1');
    // content_block.id(子调用)→ 独立解析匹配第二个 Task_1 → Task_1_dup2,
    // 不复用父映射
    const evt = (entries[0] as Record<string, unknown>).event as Record<string, unknown>;
    const contentBlock = evt.content_block as Record<string, unknown>;
    expect(contentBlock.id).toBe('Task_1_dup2');
  });

  it('child content_block_start 在 assistant 后且父同 id 时匹配子 occurrence(P1: Map post-assistant stream starts to the child occurrence)', () => {
    // 父 Agent/Task 调用 Task_1(line 0), 子 assistant 的 tool 也 Task_1(line 2, 重铸)。
    // child 的 content_block_start(带 parent_tool_use_id)在 assistant 之后(line 3),
    // 无 future occurrence —— 若 fallback 到最早之前会命中父(Task_x1), 但应命中子
    // occurrence(Task_1_dup2), 否则 replay/import 以父 id 启动子 tool card。
    const text = [
      assistantEntry('aParent', [toolUse('Task_1')]), // 父调用 → Task_x1
      userEntry('uParent', [toolResult('Task_1')]),
      assistantEntry('aChild', [toolUse('Task_1')]), // 子 tool → Task_1_dup2
      JSON.stringify({
        type: 'stream_event',
        uuid: 'child-stream',
        parent_tool_use_id: 'Task_1',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'Task_1', name: 'Task', input: {} },
        },
      }),
      userEntry('uChild', [toolResult('Task_1')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    expect(contentOf(entries[0])[0].id).toBe('Task_x1');
    expect(contentOf(entries[2])[0].id).toBe('Task_1_dup2');
    // content_block_start(assistant 后, 带 parent)匹配子 occurrence(Task_1_dup2), 非父
    const evt = (entries[3] as Record<string, unknown>).event as Record<string, unknown>;
    expect((evt.content_block as Record<string, unknown>).id).toBe('Task_1_dup2');
  });

  it('重铸后新调用的 content_block_start 前瞻匹配新调用, 不后顾命中旧调用(P2: Map pre-assistant duplicate stream IDs forward)', () => {
    // 旧调用 Bash_5(line 0)已存在, 之后重铸新调用(line 3)。content_block_start(line 2)
    // 预告的是新调用 —— 后顾优先会命中旧 Bash_x5, 但语义上应前瞻匹配 Bash_5_dup2。
    const text = [
      assistantEntry('a1', [toolUse('Bash_5')]),
      userEntry('u1', [toolResult('Bash_5')]),
      JSON.stringify({
        type: 'stream_event',
        uuid: 'stream-1',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'Bash_5', name: 'Bash', input: {} },
        },
      }),
      assistantEntry('a2', [toolUse('Bash_5')]),
      userEntry('u2', [toolResult('Bash_5')]),
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    const entries = parseEntries(result.text);
    // 旧调用 → Bash_x5, 重铸新调用 → Bash_5_dup2
    expect(contentOf(entries[0])[0].id).toBe('Bash_x5');
    expect(contentOf(entries[3])[0].id).toBe('Bash_5_dup2');
    // content_block_start 前瞻匹配新调用(不是旧调用)
    const evt = (entries[2] as Record<string, unknown>).event as Record<string, unknown>;
    expect((evt.content_block as Record<string, unknown>).id).toBe('Bash_5_dup2');
  });

  it('未改动行保持原始字节(不重新序列化)', () => {
    const unchangedLine = userEntry('u1', [{ type: 'text', text: '含  unicode 与  空格' }]);
    const changedLine = assistantEntry('a1', [toolUse('Bash_210')]);
    const text = [unchangedLine, changedLine].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.text.trim().split('\n')[0]).toBe(unchangedLine);
  });

  it('尾部畸形残行原样保留并继续归一化(CLI 崩溃截断常态)', () => {
    const malformedTail = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"Bas';
    const text = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
      malformedTail,
    ].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.changed).toBe(true);
    expect(result.keptMalformedTailLine).toBe(true);
    const lines = result.text.trim().split('\n');
    expect(lines[2]).toBe(malformedTail);
    const firstEntry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(contentOf(firstEntry)[0].id).toBe('Bash_x210');
  });

  it('中间行畸形仍抛错(调用方 best-effort 兜底)', () => {
    const text = [
      '{"type":"assistant",broken',
      assistantEntry('a1', [toolUse('Bash_210')]),
    ].join('\n') + '\n';
    expect(() => normalizeClaudeJsonlToolIdsText(text)).toThrow(/JSONL parse error at line 1/);
  });

  it('空文件 / 无尾换行都能处理', () => {
    expect(normalizeClaudeJsonlToolIdsText('').changed).toBe(false);
    const noNewline = assistantEntry('a1', [toolUse('Bash_210')]);
    const result = normalizeClaudeJsonlToolIdsText(noNewline);
    expect(result.changed).toBe(true);
    expect(result.text.endsWith('\n')).toBe(false);
  });
});

// ── 文件级归一化 ────────────────────────────────────────────────────────

describe('normalizeClaudeSessionJsonlToolIds', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('有改动时先备份再原子重写; 无改动不动文件', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'jsonl-normalize-'));
    const filePath = path.join(tmpDir, 'session.jsonl');
    const original = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
      assistantEntry('a2', [toolUse('Bash_210')]),
      userEntry('u2', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    await writeFile(filePath, original, 'utf8');

    const result = await normalizeClaudeSessionJsonlToolIds(filePath);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    // 备份保留原文
    expect(await readFile(result.backupPath!, 'utf8')).toBe(original);
    // 文件已归一化,无 tmp 残留
    const rewritten = await readFile(filePath, 'utf8');
    expect(rewritten).toContain('Bash_x210');
    expect(rewritten).toContain('Bash_210_dup2');
    expect((await readdir(tmpDir)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);

    // 第二次运行: 幂等 → 无改动、不再产生新备份
    const again = await normalizeClaudeSessionJsonlToolIds(filePath);
    expect(again.changed).toBe(false);
    expect(again.backupPath).toBeUndefined();
    const backups = (await readdir(tmpDir)).filter((f) => f.includes('.bak.'));
    expect(backups).toHaveLength(1);
  });

  it('纯 Anthropic 会话: 预扫跳过, 不读写文件内容', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'jsonl-normalize-'));
    const filePath = path.join(tmpDir, 'session.jsonl');
    const original = [
      assistantEntry('a1', [toolUse('toolu_01Jx4AbC')]),
      userEntry('u1', [toolResult('toolu_01Jx4AbC')]),
    ].join('\n') + '\n';
    await writeFile(filePath, original, 'utf8');
    const result = await normalizeClaudeSessionJsonlToolIds(filePath);
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect((await readdir(tmpDir)).filter((f) => f.includes('.bak.'))).toHaveLength(0);
  });

  it('权限保留: 重写文件与 .bak 备份沿用原文件权限(不默认 0644 放宽)', async () => {
    const fsPromises = await import('node:fs/promises');
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'jsonl-normalize-'));
    const filePath = path.join(tmpDir, 'session.jsonl');
    const original = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    await writeFile(filePath, original, { encoding: 'utf8', mode: 0o600 });
    const beforeMode = (await fsPromises.stat(filePath)).mode & 0o777;

    const result = await normalizeClaudeSessionJsonlToolIds(filePath);
    expect(result.changed).toBe(true);

    // 不变量: 归一化后权限与归一化前一致(Windows 恒 0o666 → 恒等;
    // POSIX 上 0600 转录不得被 tmp 默认 0644 放宽)。
    const afterMode = (await fsPromises.stat(filePath)).mode & 0o777;
    expect(afterMode).toBe(beforeMode);
    const bakMode = (await fsPromises.stat(result.backupPath!)).mode & 0o777;
    expect(bakMode).toBe(beforeMode);
  });

  it('Windows rename 覆盖目标抛 EEXIST 时降级为删除+rename 重试(copilot review)', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'jsonl-normalize-'));
    const filePath = path.join(tmpDir, 'session.jsonl');
    const original = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    await writeFile(filePath, original, 'utf8');

    const fsMod = await import('node:fs');
    const realRename = fsMod.promises.rename.bind(fsMod.promises);
    // 第一次 rename 模拟 Windows/exFAT 拒绝覆盖已存在目标; 第二次(删除后)成功。
    const renameSpy = vi
      .spyOn(fsMod.promises, 'rename')
      .mockImplementation(async (oldPath: any, newPath: any) => {
        if (renameSpy.mock.calls.length === 1) {
          const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return realRename(oldPath, newPath);
      });

    try {
      const result = await normalizeClaudeSessionJsonlToolIds(filePath);
      expect(result.changed).toBe(true);
      // 降级成功: rename 被调用两次(首次失败 + 删除后重试)
      expect(renameSpy).toHaveBeenCalledTimes(2);
      // 归一化已生效,无 tmp 残留
      const rewritten = await readFile(filePath, 'utf8');
      expect(rewritten).toContain('Bash_x210');
      expect((await readdir(tmpDir)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('rename 降级失败时从 .bak 备份恢复,转录不丢且不抛错(copilot review)', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'jsonl-normalize-'));
    const filePath = path.join(tmpDir, 'session.jsonl');
    const original = [
      assistantEntry('a1', [toolUse('Bash_210')]),
      userEntry('u1', [toolResult('Bash_210')]),
    ].join('\n') + '\n';
    await writeFile(filePath, original, 'utf8');

    const fsMod = await import('node:fs');
    const renameSpy = vi
      .spyOn(fsMod.promises, 'rename')
      .mockImplementation(async () => {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });

    try {
      // rename 全失败:降级路径删除目标后从 .bak 备份恢复 → 不抛错,转录仍在
      const result = await normalizeClaudeSessionJsonlToolIds(filePath);
      expect(result.backupPath).toBeDefined();
      // tmp 被清理
      expect((await readdir(tmpDir)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
      // 原文件从备份恢复,内容为原文(归一化未生效但转录可被 resume 读取)
      expect(await readFile(filePath, 'utf8')).toBe(original);
    } finally {
      renameSpy.mockRestore();
    }
  });
});
