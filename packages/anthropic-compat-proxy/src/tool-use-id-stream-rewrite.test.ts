import { describe, expect, it } from 'vitest';

import {
  collectToolUseIdsForResponseRewrite,
  ToolUseIdDedupeRewriter,
  ToolUseIdRewriteTransform,
} from './tool-use-id-stream-rewrite.js';

// ── collectToolUseIdsForResponseRewrite ─────────────────────────────────

describe('collectToolUseIdsForResponseRewrite', () => {
  it('历史含铸造形态 id 时返回**全量** tool_use id 集合(P1-A: 改名产物也在内)', () => {
    const ids = collectToolUseIdsForResponseRewrite({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'Bash_210' },
            { type: 'tool_use', id: 'Bash_210_dup2' }, // 上一轮改名产物
            { type: 'tool_use', id: 'toolu_01Jx4AbC' }, // 非铸造形态也收(防撞基准)
            { type: 'text', text: 'x' },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Bash_210' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'TaskCreate_35' }] },
      ],
    });
    expect(ids).toEqual(new Set(['Bash_210', 'Bash_210_dup2', 'toolu_01Jx4AbC', 'TaskCreate_35']));
  });

  it('纯 Anthropic toolu_* / OpenAI call_<random> / 无 tool 调用 → null', () => {
    expect(
      collectToolUseIdsForResponseRewrite({
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01Jx4AbC' }] }],
      }),
    ).toBeNull();
    expect(
      collectToolUseIdsForResponseRewrite({
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_5teL1yyaqGpp3UKFRv22MkQu' }] },
        ],
      }),
    ).toBeNull();
    expect(collectToolUseIdsForResponseRewrite({ messages: [{ role: 'user', content: '你好' }] })).toBeNull();
  });

  it('非 messages 请求 / 非对象 → null', () => {
    expect(collectToolUseIdsForResponseRewrite(undefined)).toBeNull();
    expect(collectToolUseIdsForResponseRewrite(null)).toBeNull();
    expect(collectToolUseIdsForResponseRewrite('junk')).toBeNull();
    expect(collectToolUseIdsForResponseRewrite({ model: 'kimi-k3' })).toBeNull();
  });

  it('归一化后的 _x 形态 id 不命中接管开关(与转录归一化幂等互补)', () => {
    expect(
      collectToolUseIdsForResponseRewrite({
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_x210' }] }],
      }),
    ).toBeNull();
  });

  it('MCP 下划线工具名的铸造 id 命中(P1-E)', () => {
    const ids = collectToolUseIdsForResponseRewrite({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'mcp__cindy_memory__call_tool_5' }],
        },
      ],
    });
    expect(ids).toEqual(new Set(['mcp__cindy_memory__call_tool_5']));
  });

  it('带连字符的 MCP 工具名 id 命中(codex-connector P1)', () => {
    const ids = collectToolUseIdsForResponseRewrite({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'mcp__feishu-delegate__feishu_read_messages_5',
              name: 'mcp__feishu-delegate__feishu_read_messages',
            },
          ],
        },
      ],
    });
    expect(ids).toEqual(new Set(['mcp__feishu-delegate__feishu_read_messages_5']));
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

  it('P1-A: 历史已含 _dup2(上一轮改名产物)时,同底 id 再撞顺延到 _dup3', () => {
    // 事故主态:同一 id 被重铸多次。种子集合含 Bash_210_dup2 时,
    // 新铸 Bash_210 必须给 _dup3,而不是再产出一个 _dup2 与历史撞车。
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210', 'Bash_210_dup2']));
    expect(rewriter.resolve('Bash_210')).toBe('Bash_210_dup3');
  });

  it('onObserved: 每个 resolve 的 id(含 fresh 非碰撞)都回调,线程缓存不漏 fresh id', () => {
    // 场景:响应 stream 一个 fresh id(fresh_1, 非碰撞),然后 rewind/中断,
    // 下一请求体不含它 —— 若缓存只记 rename 产物,重铸 fresh_1 就漏防。
    const observed: string[] = [];
    const rewriter = new ToolUseIdDedupeRewriter(
      new Set(['Bash_210']),
      undefined,
      (id) => observed.push(id),
    );
    rewriter.resolve('fresh_1'); // 非碰撞 → 只走 onObserved
    rewriter.resolve('Bash_210'); // 碰撞 → rename + onObserved
    expect(observed).toEqual(['fresh_1', 'Bash_210_dup2']);
    expect(rewriter.renameCount).toBe(1);
  });

  it('P1: sharedSeen 实时检查 —— 共享缓存(并发流)已见的 id 按碰撞改名, 不再放行', () => {
    // 同一 thread 的两个并发响应流各持 rewriter, 都从空快照构建。流 A 放行 Bash_210
    // 并写入共享缓存后, 流 B 的 rewriter(usedIds 仍空)resolve Bash_210 时, sharedSeen
    // 返回 true → 必须改名, 否则 CLI 追加重复 id 重新引入 (no content) 腐蚀。
    const sharedCache = new Set<string>();
    const rewriterA = new ToolUseIdDedupeRewriter(new Set(), undefined, (id) => sharedCache.add(id));
    const rewriterB = new ToolUseIdDedupeRewriter(
      new Set(),
      undefined,
      (id) => sharedCache.add(id),
      (id) => sharedCache.has(id),
    );
    // 流 A: fresh 放行, 写入共享缓存
    expect(rewriterA.resolve('Bash_210')).toBe('Bash_210');
    // 流 B: sharedSeen 命中 → 改名
    expect(rewriterB.resolve('Bash_210')).toBe('Bash_210_dup2');
    expect(rewriterB.renameCount).toBe(1);
    // 流 B 再次看到 Bash_210(本流也缓存了) → 顺延 _dup3
    expect(rewriterB.resolve('Bash_210')).toBe('Bash_210_dup3');
  });

  it('P1: sharedSeen 对改名产物同样设防 —— 并发流已占用的 _dupN 不重复产出', () => {
    const sharedCache = new Set<string>();
    const rewriterA = new ToolUseIdDedupeRewriter(new Set(), undefined, (id) => sharedCache.add(id));
    const rewriterB = new ToolUseIdDedupeRewriter(
      new Set(),
      undefined,
      (id) => sharedCache.add(id),
      (id) => sharedCache.has(id),
    );
    // 流 A: Bash_210 已是历史 → _dup2, 共享缓存含 Bash_210_dup2
    rewriterA.resolve('Bash_210'); // fresh 放行
    rewriterA.resolve('Bash_210'); // 本流内撞车 → _dup2
    // 流 B: Bash_210 也已是历史(sharedSeen) → 必须给 _dup3, 不能与流 A 的 _dup2 撞
    expect(rewriterB.resolve('Bash_210')).toBe('Bash_210_dup3');
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

  it('P1-D: 上游 JSON 带空格风格(python json.dumps)同样命中', async () => {
    // LiteLLM / Moonshot anthropic 端点若是 python 系,序列化是 {"type": "..."} 带空格;
    // 逐字节前缀假设会整体静默失效,放宽后的匹配必须覆盖。
    const body =
      'event: content_block_start\n' +
      'data: {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "Bash_210", "name": "Bash", "input": {}}}\n\n';
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const out = await runTransform([Buffer.from(body, 'utf8')], rewriter);
    expect(out.toString('utf8')).toContain('"id":"Bash_210_dup2"');
  });

  it('P1-D: data: 后多个空格 / 键序变化也命中', async () => {
    const body =
      'data:  { "content_block": { "id": "Bash_210", "name": "Bash", "type": "tool_use", "input": {} }, "index": 1, "type": "content_block_start" }\n\n';
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const out = await runTransform([Buffer.from(body, 'utf8')], rewriter);
    expect(out.toString('utf8')).toContain('"id":"Bash_210_dup2"');
  });

  it('P1-D: pydantic 字段序(type 末尾)+ MCP 长工具名也命中(Fable-5 复现形态)', async () => {
    // anthropic python SDK / pydantic model_dump 的字段序是 content_block, index, type 末尾;
    // MCP 长名时 marker 落在 ~150 字节处,扫描窗口必须按此威胁面校准。
    const mcpId = 'mcp__xd_atlassian__call_tool_210';
    const body =
      'event: content_block_start\n' +
      `data: {"content_block":{"id":"${mcpId}","name":"mcp__xd_atlassian__call_tool","type":"tool_use","input":{}},"index":1,"type":"content_block_start"}\n\n`;
    const rewriter = new ToolUseIdDedupeRewriter(new Set([mcpId]));
    const out = await runTransform([Buffer.from(body, 'utf8')], rewriter);
    expect(out.toString('utf8')).toContain(`"id":"${mcpId}_dup2"`);
    // json.dumps 带空格风格(marker 更靠后,~165)
    const spaced =
      'event: content_block_start\n' +
      `data: { "content_block": { "id": "${mcpId}", "name": "mcp__xd_atlassian__call_tool", "type": "tool_use", "input": {} }, "index": 1, "type": "content_block_start" }\n\n`;
    const rewriter2 = new ToolUseIdDedupeRewriter(new Set([mcpId]));
    const out2 = await runTransform([Buffer.from(spaced, 'utf8')], rewriter2);
    expect(out2.toString('utf8')).toContain(`"id":"${mcpId}_dup2"`);
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

  it('病态超长无换行行:超上限直接透传,不拖垮内存', async () => {
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const big = Buffer.alloc(5 * 1024 * 1024, 0x61); // 5MB 'a' 无 \n
    const tail = Buffer.from('\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\n', 'utf8');
    const out = await runTransform([big, tail], rewriter);
    // 超长行原样透传(逐字节不变)
    expect(out.subarray(0, big.length).equals(big)).toBe(true);
    // 超长行透传后,后续正常行仍能改写(改名使尾部多 _dup2 的 5 字节)
    expect(out.toString('utf8', big.length)).toContain('"id":"Bash_210_dup2"');
  });

  it('UTF-8 BOM 前缀的 data 行也能命中(GPT-5.5 review 第 2 轮 P2)', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.concat([
      Buffer.from('data: ', 'utf8'),
      bom,
      Buffer.from('{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\n', 'utf8'),
    ]);
    const rewriter = new ToolUseIdDedupeRewriter(new Set(['Bash_210']));
    const out = await runTransform([body], rewriter);
    expect(out.toString('utf8')).toContain('"id":"Bash_210_dup2"');
  });
});
