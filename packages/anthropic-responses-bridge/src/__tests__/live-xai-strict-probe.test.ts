/**
 * 活体探针 —— 验证 api.x.ai 对 function-tool `strict` 标志的真实语义。
 *
 * 背景:xAI 文档(docs.x.ai/docs/guides/structured-outputs)声称 tool calling 的
 * strict「implicitly always true」,即约束解码恒开;但 2026-08 有 16 次 Edit 缺
 * 必填 file_path 的实锤,说明该保证在实践中至少失效过一次。本探针用最小 synthetic
 * schema(无任何用户数据)直打 api.x.ai,回答三个问题:
 *   P1 strict:true + 不合规 schema(optional 字段、无 additionalProperties)→ 400 还是接受?
 *   P2 strict:true + 合规 schema + 强制调用 → 产出的 arguments 是否含必填字段?
 *   P3 显式 strict:false + 同 P2 → 行为是否与 P2 有差(显式 false 是否关掉约束)?
 *
 * 默认跳过(不联网、不依赖凭证)。执行方式(操作者显式提供凭证,**绝不**从
 * 应用 safeStorage / 用户文件读取):
 *   BRIDGE_LIVE_XAI=1 XAI_PROBE_TOKEN=<access token 或 API key> \
 *     pnpm --filter @cindy/anthropic-responses-bridge test
 *
 * 输出只含状态码、工具名、参数键名与布尔判定;不输出凭证与参数值。
 */
import { describe, expect, it } from 'vitest';

const LIVE = process.env.BRIDGE_LIVE_XAI === '1' && !!process.env.XAI_PROBE_TOKEN;
const MODEL = process.env.XAI_PROBE_MODEL ?? 'grok-4-fast-non-reasoning';

/** 合规(OpenAI 式 strict 子集):全必填 + additionalProperties:false。 */
const CONFORMING_SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'city name' },
    unit: { type: 'string', enum: ['c', 'f'] },
  },
  required: ['city', 'unit'],
  additionalProperties: false,
} as const;

/** 不合规:unit 是 optional,且不带 additionalProperties(OpenAI strict 模式会 400 的形态)。 */
const NON_CONFORMING_SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'city name' },
    unit: { type: 'string', enum: ['c', 'f'] },
  },
  required: ['city'],
} as const;

interface ProbeResult {
  status: number;
  /** 强制工具调用时,响应里 function_call 的 arguments 键名(不含值)。 */
  argumentKeys: string[] | null;
  missingRequired: string[] | null;
  bodySnippetOnError: string;
}

async function probe(strict: boolean, schema: unknown, requiredKeys: string[]): Promise<ProbeResult> {
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.XAI_PROBE_TOKEN}`,
    },
    body: JSON.stringify({
      model: MODEL,
      // 极小输入,无用户数据;强制调用工具以观察 arguments 形态。
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather in Paris? use the tool.' }] }],
      tools: [{ type: 'function', name: 'get_weather', description: 'probe tool', strict, parameters: schema }],
      tool_choice: { type: 'function', name: 'get_weather' },
      store: false,
      stream: false,
      max_output_tokens: 256,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // 错误正文只留前 300 字符用于归因(xAI 错误信息不含用户数据)。
    return { status: res.status, argumentKeys: null, missingRequired: null, bodySnippetOnError: text.slice(0, 300) };
  }
  let argumentKeys: string[] | null = null;
  let missingRequired: string[] | null = null;
  try {
    const parsed = JSON.parse(text) as { output?: Array<Record<string, unknown>> };
    const call = (parsed.output ?? []).find((item) => item.type === 'function_call');
    if (call && typeof call.arguments === 'string') {
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      argumentKeys = Object.keys(args).sort();
      missingRequired = requiredKeys.filter((k) => !(k in args));
    }
  } catch {
    // 保持 null,由断言输出兜底。
  }
  return { status: res.status, argumentKeys, missingRequired, bodySnippetOnError: '' };
}

describe.skipIf(!LIVE)('live xAI strict semantics probe', () => {
  it('P1: strict:true + 不合规 schema —— 记录 xAI 是否 400(OpenAI 会拒,xAI 文档未定义)', async () => {
    const r = await probe(true, NON_CONFORMING_SCHEMA, ['city']);
    console.info('[probe P1] strict:true + non-conforming schema →', {
      status: r.status,
      verdict: r.status === 400 ? 'xAI-validates-strict-subset' : r.status === 200 ? 'xAI-tolerates' : 'other',
      error: r.bodySnippetOnError,
    });
    expect([200, 400, 422]).toContain(r.status);
  }, 60_000);

  it('P2: strict:true + 合规 schema + 强制调用 —— arguments 必须含全部必填字段', async () => {
    const r = await probe(true, CONFORMING_SCHEMA, ['city', 'unit']);
    console.info('[probe P2] strict:true + conforming schema →', {
      status: r.status,
      argumentKeys: r.argumentKeys,
      missingRequired: r.missingRequired,
    });
    expect(r.status).toBe(200);
    expect(r.missingRequired).toEqual([]);
  }, 60_000);

  it('P3: 显式 strict:false + 合规 schema —— 对照 P2,观察显式 false 是否改变约束行为', async () => {
    const r = await probe(false, CONFORMING_SCHEMA, ['city', 'unit']);
    console.info('[probe P3] strict:false + conforming schema →', {
      status: r.status,
      argumentKeys: r.argumentKeys,
      missingRequired: r.missingRequired,
    });
    expect(r.status).toBe(200);
    // 单样本无法证明约束存在与否,只记录;必填缺失时这里会直接暴露。
  }, 60_000);
});
