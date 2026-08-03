import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
});
