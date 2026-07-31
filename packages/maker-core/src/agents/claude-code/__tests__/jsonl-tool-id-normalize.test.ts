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

  it('重复 id: 第 N 次出现去重为 _dupN,result 按出现序配对', () => {
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

  it('超编 result(无对应第 N 次 call)保持原 id 不动', () => {
    // 一个 call、两个 result(病态残留): 第二个 result 不改名,但仍随首现 call 一起偏移
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

  it('未改动行保持原始字节(不重新序列化)', () => {
    const unchangedLine = userEntry('u1', [{ type: 'text', text: '含  unicode 与  空格' }]);
    const changedLine = assistantEntry('a1', [toolUse('Bash_210')]);
    const text = [unchangedLine, changedLine].join('\n') + '\n';
    const result = normalizeClaudeJsonlToolIdsText(text);
    expect(result.text.trim().split('\n')[0]).toBe(unchangedLine);
  });

  it('畸形 JSON 行抛错(调用方 best-effort 兜底)', () => {
    expect(() => normalizeClaudeJsonlToolIdsText('{"id": "Bash_210", broken\n')).toThrow(
      /JSONL parse error at line 1/,
    );
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

  it('有改动时先备份再重写; 无改动不动文件', async () => {
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
    // 文件已归一化
    const rewritten = await readFile(filePath, 'utf8');
    expect(rewritten).toContain('Bash_x210');
    expect(rewritten).toContain('Bash_210_dup2');

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
});
