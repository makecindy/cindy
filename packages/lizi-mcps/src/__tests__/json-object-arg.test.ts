/**
 * jsonObjectArg —— generic `call_tool({ name, args })` 入口 args schema 的回归测试。
 *
 * 覆盖四件事:
 *  1. 运行时兜底行为:object 透传 / JSON-string 还原成 object / 真烂字符串仍报错 /
 *     null 归一成 {} / 整体省略(无参工具按内层空 schema 调用)时通过且 args 为 undefined。
 *  2. 端到端复现 GitHub issue #350:经【真实 MCP SDK 校验路径】传一段被 stringify 的
 *     超长 args,旧 `z.record` 会在 entry 报 -32602 invalid_type;新 schema 能还原成
 *     object 并落到 handler。同路径验证省略 args 不再被 -32602 挡回(2026-10-14 修复:
 *     无参工具如 memory_list 按内层空 schema 省略 args 曾直接被入口拒收)。
 *  3. 描述拼接与落点(CLAUDE.md 规则 10):jsonObjectArg 会在传入 desc 末尾追加固定的
 *     OBJECT_HINT 反例后缀,本测试验证「拼接后的描述」仍逐字节落在【内层 record】上、
 *     与用相同拼接的 legacy `z.record(...).describe()` 一致,确保描述不因 preprocess 漂移,
 *     从而不改模型看到的工具定义 / 不破坏缓存前缀。
 *  4. 模型可见 JSON Schema:`args` 不在 required(可选),但 record 约束与描述不变。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { jsonObjectArg } from '../json-object-arg.js';

// ── 1. 纯运行时行为 ───────────────────────────────────────────────────────────

describe('jsonObjectArg — runtime coercion', () => {
  const schema = z.object({ args: jsonObjectArg('desc') });

  it('passes through a real object unchanged', () => {
    const r = schema.safeParse({ args: { prompt: 'hi', n: 1 } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toEqual({ prompt: 'hi', n: 1 });
  });

  it('parses a JSON-stringified object back into an object', () => {
    const r = schema.safeParse({ args: JSON.stringify({ prompt: 'x'.repeat(3000) }) });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(typeof r.data.args).toBe('object');
      expect((r.data.args as { prompt: string }).prompt).toHaveLength(3000);
    }
  });

  it('rejects a string that is not valid JSON (keeps original error semantics)', () => {
    expect(schema.safeParse({ args: 'not json at all' }).success).toBe(false);
  });

  it('rejects a JSON string that parses to a non-object (e.g. a number)', () => {
    expect(schema.safeParse({ args: '42' }).success).toBe(false);
  });

  it('treats a null args field as an empty object (host collapses {} into null)', () => {
    // 回归 2026-10-14：宿主把空对象 args 压成 null 送到入口，-32602 expected record。
    // null / 缺失 / {} 三种「无参数」形态必须统一落成 {}（消费方 args ?? {}）。
    const r = schema.safeParse({ args: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toEqual({});
  });

  it('accepts an omitted args field (no-parameter tools called without args)', () => {
    // 回归 2026-10-14：无参工具(自身 schema 是空对象, 如 memory_list)按内层 schema 省略
    // args 时, 入口曾直接 -32602。现在必须放过, args 为 undefined(消费方 registry 已 ?? {})。
    const r = schema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toBeUndefined();
  });
});

// ── 2. 端到端:真实 MCP SDK Client + InMemoryTransport(复现并验证 #350 修复) ──

/** 起一个最小 server:call_tool handler 把收到的 args 原样回显,供断言 "进了 handler 且是 object"。 */
async function makeEchoHarness() {
  const server = new McpServer({ name: 'json-object-arg-test', version: '0.0.0' });
  server.tool(
    'call_tool',
    'echo back received args for assertions',
    { name: z.string(), args: jsonObjectArg('工具参数(JSON 对象)。') },
    async ({ name, args }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ name, argsType: typeof args, args }) }],
    }),
  );

  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'json-object-arg-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

function readEcho(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  return JSON.parse(text) as { name: string; argsType: string; args: unknown };
}

describe('jsonObjectArg — end-to-end through real MCP SDK validation (issue #350)', () => {
  it('accepts a long STRINGIFIED args payload and delivers it to the handler as an object', async () => {
    const h = await makeEchoHarness();
    try {
      // 这正是 issue #350 里失败的输入形态:args 被整体 stringify 成一段长 JSON 字符串。
      const longPrompt = 'a'.repeat(2500);
      const result = (await h.client.callTool({
        name: 'call_tool',
        arguments: { name: 'schedule_create', args: JSON.stringify({ prompt: longPrompt, cron: '0 9 * * *' }) },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

      expect(result.isError ?? false).toBe(false);
      const echo = readEcho(result);
      expect(echo.argsType).toBe('object');
      expect((echo.args as { prompt: string }).prompt).toHaveLength(2500);
      expect((echo.args as { cron: string }).cron).toBe('0 9 * * *');
    } finally {
      await h.cleanup();
    }
  });

  it('still accepts a normal object args payload', async () => {
    const h = await makeEchoHarness();
    try {
      const result = (await h.client.callTool({
        name: 'call_tool',
        arguments: { name: 'schedule_create', args: { prompt: 'short', cron: '* * * * *' } },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(result.isError ?? false).toBe(false);
      expect(readEcho(result).argsType).toBe('object');
    } finally {
      await h.cleanup();
    }
  });

  it('rejects a non-JSON string at the entry schema (no silent pass-through of garbage)', async () => {
    const h = await makeEchoHarness();
    try {
      const result = (await h.client.callTool({
        name: 'call_tool',
        arguments: { name: 'schedule_create', args: 'this is not json' },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('accepts a call that omits args entirely (no-parameter tool, e.g. memory_list)', async () => {
    // 回归 2026-10-14：模型遵守内层空 schema 不传 args, 入口曾 -32602 path ["args"]。
    const h = await makeEchoHarness();
    try {
      const result = (await h.client.callTool({
        name: 'call_tool',
        arguments: { name: 'memory_list' },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(result.isError ?? false).toBe(false);
      const echo = readEcho(result);
      expect(echo.name).toBe('memory_list');
      expect(echo.argsType).toBe('undefined');
    } finally {
      await h.cleanup();
    }
  });

  it('accepts the null args the host produces from an empty-object args payload', async () => {
    const h = await makeEchoHarness();
    try {
      const result = (await h.client.callTool({
        name: 'call_tool',
        arguments: { name: 'memory_list', args: null },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(result.isError ?? false).toBe(false);
      expect(readEcho(result).argsType).toBe('object');
    } finally {
      await h.cleanup();
    }
  });
});

// ── 3. schema 快照不变(规则 10:不改模型看到的工具定义 / 不破坏缓存前缀) ──────

/** 列出 server 暴露的某 tool 的 inputSchema(模型实际看到的 JSON Schema)。 */
async function inputSchemaOf(shape: z.ZodRawShape): Promise<unknown> {
  const server = new McpServer({ name: 'schema-probe', version: '0.0.0' });
  server.tool('call_tool', 'probe', shape, async () => ({ content: [] }));
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-probe-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === 'call_tool')?.inputSchema;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('jsonObjectArg — model-facing JSON Schema is byte-identical to legacy z.record', () => {
  // 覆盖几种实际在用的描述文案(含 CJK / 全角括号 / 英文),确保 key 顺序与内容不漂移。
  const descriptions = [
    '工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。',
    '工具参数（JSON 对象）。不确定 schema 时可先传 {} 触发错误反馈。',
    'Arguments object for the tool',
  ];

  for (const desc of descriptions) {
    it(`stays identical for: ${desc.slice(0, 16)}…`, async () => {
      // jsonObjectArg 会在 desc 末尾追加固定的 OBJECT_HINT 反例后缀（见 json-object-arg.ts），
      // legacy 侧用相同拼接来验证描述仍逐字节落在【内层 record】上、不因 preprocess 漂移。
      // 两侧都带 .optional():args 自 2026-10-14 起可选,无参工具(自身 schema 为空对象)省略 args 不再被入口 -32602 拒收。
      const legacy = await inputSchemaOf({
        name: z.string().describe('t'),
        args: z
          .record(z.string(), z.unknown())
          .describe(`${desc}（传 JSON 对象本身，不要序列化成字符串）`)
          .optional(),
      });
      const next = await inputSchemaOf({
        name: z.string().describe('t'),
        args: jsonObjectArg(desc),
      });
      expect(JSON.stringify(next)).toBe(JSON.stringify(legacy));
      // 模型看到的契约:args 不在 required(可省略),但仍是 record 而非 any。
      const schema = next as { required?: string[]; properties: Record<string, { type?: string }> };
      expect(schema.required ?? []).not.toContain('args');
      expect(schema.properties.args.type).toBe('object');
    });
  }
});
