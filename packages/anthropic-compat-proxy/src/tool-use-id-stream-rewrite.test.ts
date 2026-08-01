import { describe, expect, it } from 'vitest';

import {
  collectMintedToolUseIds,
  ToolUseIdDedupeRewriter,
  ToolUseIdRewriteTransform,
} from './tool-use-id-stream-rewrite.js';

// ── collectMintedToolUseIds ─────────────────────────────────────────────

describe('collectMintedToolUseIds', () => {
  it('收集铸造形态(${name}_${digits})的 tool_use id', () => {
    const ids = collectMintedToolUseIds({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210' }, { type: 'text', text: 'x' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Bash_210' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'TaskCreate_35' }] },
      ],
    });
    expect(ids).toEqual(new Set(['Bash_210', 'TaskCreate_35']));
  });

  it('纯 Anthropic toolu_* / OpenAI call_* / 无 tool 调用 → null', () => {
    expect(
      collectMintedToolUseIds({
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01Jx4AbC' }] }],
      }),
    ).toBeNull();
    expect(
      collectMintedToolUseIds({
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc123' }] }],
      }),
    ).toBeNull();
    expect(collectMintedToolUseIds({ messages: [{ role: 'user', content: '你好' }] })).toBeNull();
  });

  it('非 messages 请求 / 非对象 → null', () => {
    expect(collectMintedToolUseIds(undefined)).toBeNull();
    expect(collectMintedToolUseIds(null)).toBeNull();
    expect(collectMintedToolUseIds('junk')).toBeNull();
    expect(collectMintedToolUseIds({ model: 'kimi-k3' })).toBeNull();
  });

  it('归一化后的 _x 形态 id 不再命中(与转录归一化幂等互补)', () => {
    expect(
      collectMintedToolUseIds({
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_x210' }] }],
      }),
    ).toBeNull();
  });
});

// ── ToolUseIdDedupeRewriter.resolve ──────────────────────────────────────

describe('ToolUseIdDedupeRewriter.resolve', () => {
  it('新 id 原样通过; 撞历史的 id 改写为 _dup2, 再次撞车 _dup3', () => {
    const renamed: Array<[string, string]> = [];
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']), (from, to) =>
      renamed.push([from, to]),
    );
    expect(rewriter.resolve('Bash_219')).toBe('Bash_219'); // 新 id 不动
    expect(rewriter.resolve('Bash_210')).toBe('Bash_210_dup2'); // 撞历史
    expect(rewriter.resolve('Bash_210')).toBe('Bash_210_dup3'); // 再撞(含本响应已改名的)
    expect(rewriter.renameCount).toBe(2);
    expect(renamed).toEqual([
      ['Bash_210', 'Bash_210_dup2'],
      ['Bash_210', 'Bash_210_dup3'],
    ]);
  });

  it('历史已含 _dup2 时跳到未占用的后缀', () => {
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210', 'Bash_210_dup2']));
    expect(rewriter.resolve('Bash_210')).toBe('Bash_210_dup3');
  });
});

// ── ToolUseIdRewriteTransform(SSE 字节流) ────────────────────────────────

function sseToolUseStart(id: string, name = 'Bash', index = 1): string {
  return (
    `event: content_block_start\n` +
    `data: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":"${id}","name":"${name}","input":{}}}\n\n`
  );
}

async function runTransform(chunks: Buffer[], rewriter: ToolUseIdDedupeRewriter): Promise<Buffer> {
  const transform = new ToolUseIdRewriteTransform(rewriter);
  const out: Buffer[] = [];
  transform.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((resolve, reject) => {
    transform.on('end', resolve);
    transform.on('error', reject);
  });
  for (const chunk of chunks) transform.write(chunk);
  transform.end();
  await done;
  return Buffer.concat(out);
}

describe('ToolUseIdRewriteTransform', () => {
  const SSE_BODY =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"chatcmpl-x","role":"assistant","content":[]}}\n\n' +
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
    sseToolUseStart('Bash_210') +
    sseToolUseStart('Bash_219', 'Bash', 2) +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n';

  it('撞历史的 tool_use id 在流中被改名, 其余字节不动', async () => {
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const out = await runTransform([Buffer.from(SSE_BODY, 'utf8')], rewriter);
    const text = out.toString('utf8');
    expect(text).toContain('"id":"Bash_210_dup2"'); // 撞车 → 改名
    expect(text).toContain('"id":"Bash_219"'); // 新 id → 不动
    expect(text).not.toContain('"id":"Bash_210"'); // 原始撞车 id 不再出现
    expect(rewriter.renameCount).toBe(1);
  });

  it('data 行跨 chunk 切割也能正确改写', async () => {
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const bytes = Buffer.from(SSE_BODY, 'utf8');
    // 以 7 字节碎片喂入,覆盖行被任意切开的场景
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
    const out = await runTransform(chunks, rewriter);
    const text = out.toString('utf8');
    expect(text).toContain('"id":"Bash_210_dup2"');
    expect(text).toContain('"id":"Bash_219"');
    // 除改名行外,总内容等价(去掉改名差异后与原文一致)
    expect(text.replace('Bash_210_dup2', 'Bash_210')).toBe(SSE_BODY);
  });

  it('无撞车时整流字节透传(与原流逐字节一致)', async () => {
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Edit_999']));
    const out = await runTransform([Buffer.from(SSE_BODY, 'utf8')], rewriter);
    expect(out.toString('utf8')).toBe(SSE_BODY);
    expect(rewriter.renameCount).toBe(0);
  });

  it('同一响应内重复出现的 id 也会被改名(并行调用同名工具)', async () => {
    const body = sseToolUseStart('Bash_210') + sseToolUseStart('Bash_210', 'Bash', 2);
    const rewriter = new ToolUseIdDedupeRewriter(new Set());
    const out = await runTransform([Buffer.from(body, 'utf8')], rewriter);
    const text = out.toString('utf8');
    expect(text).toContain('"id":"Bash_210"');
    expect(text).toContain('"id":"Bash_210_dup2"');
  });

  it('畸形 JSON 的 content_block_start 行 fail-open 原样通过', async () => {
    const body = 'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":BROKEN\n\n';
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const out = await runTransform([Buffer.from(body, 'utf8')], rewriter);
    expect(out.toString('utf8')).toBe(body);
  });

  it('\\r\\n 行尾保留', async () => {
    const body =
      'event: content_block_start\r\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\r\n\r\n';
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const out = await runTransform([Buffer.from(body, 'utf8')], rewriter);
    const text = out.toString('utf8');
    expect(text).toContain('"id":"Bash_210_dup2"');
    expect(text.endsWith('\r\n\r\n')).toBe(true);
  });

  it('末尾无换行的残行在 flush 时处理', async () => {
    const body = 'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}';
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const out = await runTransform([Buffer.from(body, 'utf8')], rewriter);
    expect(out.toString('utf8')).toContain('"id":"Bash_210_dup2"');
  });
});
