/**
 * 活体集成测试 —— 用真实订阅凭证(本机 ~/.codex/auth.json)打真实 chatgpt.com/backend-api/codex,
 * 验证「Anthropic 请求 → 翻译 → 上游 → 翻译回 Anthropic SSE」全链路。
 *
 * handler 以 compat-proxy `localHandler` 同形态被调用;本文件用一个最小 HTTP harness 模拟
 * 引擎侧(收 body → JSON.parse → handle({parsedBody, ctx, res, prefs}))——与 desktop host
 * 的接线逐字段一致(prefs 闭包传入,无伪 header)。
 *
 * 默认跳过(不联网、不依赖凭证);需要时:BRIDGE_LIVE=1 pnpm --filter @cindy/anthropic-responses-bridge test
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

import { createResponsesHandler, type BridgeSessionPrefs, type ResponsesBridgeHandler } from '../handler.js';

const LIVE = process.env.BRIDGE_LIVE === '1';

/** 只含 codex(chatgpt/)provider 的 handler —— 读本机 ~/.codex/auth.json 的订阅 token。 */
function makeCodexHandler(): ResponsesBridgeHandler {
  const j = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, 'utf8'));
  const accessToken = j.tokens.access_token as string;
  const accountId = j.tokens.account_id as string;
  return createResponsesHandler({
    providers: [
      {
        prefix: 'chatgpt/',
        upstreamBase: 'https://chatgpt.com/backend-api/codex',
        // 与 anthropic-responses-bridge-host 的 codexProviderConfig 对齐:Fast = priority tier。
        fastServiceTier: 'priority',
        buildHeaders: async ({ sessionId }) => ({
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          'openai-beta': 'responses=experimental',
          originator: 'codex_cli_rs',
          session_id: sessionId ?? '',
          'user-agent': 'codex_cli_rs/0.0.0 (xdt-maker bridge)',
        }),
      },
    ],
  });
}

/** 最小 harness:模拟 compat-proxy 引擎把请求交给 localHandler(per-request prefs 由测试指定)。 */
function startHarness(handler: ResponsesBridgeHandler, prefs?: BridgeSessionPrefs): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
      } catch {
        parsedBody = undefined;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      void handler.handle({
        parsedBody,
        ctx: { method: req.method ?? 'POST', url: req.url ?? '/', headers },
        res,
        prefs,
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** 解析 Anthropic SSE 文本流为事件对象数组。 */
function parseAnthropicSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.split('\n');
    const evLine = lines.find((l) => l.startsWith('event:'));
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (!evLine || !dataLine) continue;
    try {
      out.push({ event: evLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
    } catch {
      /* skip */
    }
  }
  return out;
}

describe.skipIf(!LIVE)('bridge live e2e (chatgpt codex, handler 形态)', () => {
  it('文本请求:Anthropic 请求 → 翻译 → 真实 gpt-5.5 → Anthropic SSE', async () => {
    const harness = await startHarness(makeCodexHandler());
    try {
      const res = await fetch(`${harness.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'live-test-1' },
        body: JSON.stringify({
          model: 'chatgpt/gpt-5.5',
          system: 'You are terse.',
          max_tokens: 64,
          stream: true,
          messages: [{ role: 'user', content: 'Reply with exactly: hello world' }],
        }),
      });
      const bodyText = await res.text();
      if (res.status !== 200) console.log('UPSTREAM ERROR', res.status, bodyText.slice(0, 1500));
      expect(res.status).toBe(200);
      const evs = parseAnthropicSse(bodyText);
      const evTypes = evs.map((e) => e.event);
      console.log('文本请求事件序列:', evTypes.join(' → '));
      expect(evTypes).toContain('message_start');
      expect(evTypes).toContain('content_block_start');
      expect(evTypes).toContain('message_stop');
      const text = evs
        .filter((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'text_delta')
        .map((e) => (e.data.delta as Record<string, unknown>).text as string)
        .join('');
      console.log('输出文本:', JSON.stringify(text));
      expect(text.toLowerCase()).toContain('hello');
      const md = evs.find((e) => e.event === 'message_delta');
      console.log('usage:', JSON.stringify(md?.data.usage));
    } finally {
      await harness.close();
    }
  }, 60000);

  it('Fast 模式:prefs.fast → service_tier:priority,上游应 200(参数被接受)', async () => {
    const harness = await startHarness(makeCodexHandler(), { fast: true, reasoningEffort: 'low' });
    try {
      const res = await fetch(`${harness.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'live-test-fast' },
        body: JSON.stringify({
          model: 'chatgpt/gpt-5.5',
          system: 'You are terse.',
          max_tokens: 64,
          stream: true,
          messages: [{ role: 'user', content: 'Reply with exactly: fast ok' }],
        }),
      });
      const bodyText = await res.text();
      if (res.status !== 200) console.log('UPSTREAM ERROR (fast)', res.status, bodyText.slice(0, 1500));
      expect(res.status).toBe(200);
      const evs = parseAnthropicSse(bodyText);
      expect(evs.map((e) => e.event)).toContain('message_stop');
      const text = evs
        .filter((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'text_delta')
        .map((e) => (e.data.delta as Record<string, unknown>).text as string)
        .join('');
      console.log('fast 输出文本:', JSON.stringify(text));
    } finally {
      await harness.close();
    }
  }, 60000);

  it('工具请求:模型应发起 tool_use', async () => {
    const harness = await startHarness(makeCodexHandler());
    try {
      const res = await fetch(`${harness.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'live-test-2' },
        body: JSON.stringify({
          model: 'chatgpt/gpt-5.5',
          system: 'Use tools when asked about weather.',
          max_tokens: 256,
          stream: true,
          tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: 'Use the get_weather tool for Tokyo.' }],
        }),
      });
      expect(res.status).toBe(200);
      const evs = parseAnthropicSse(await res.text());
      console.log('工具请求事件序列:', evs.map((e) => e.event).join(' → '));
      const toolStart = evs.find(
        (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>)?.type === 'tool_use',
      );
      expect(toolStart).toBeDefined();
      const cb = toolStart!.data.content_block as Record<string, unknown>;
      console.log('tool_use:', JSON.stringify({ id: cb.id, name: cb.name }));
      expect(cb.name).toBe('get_weather');
      const md = evs.find((e) => e.event === 'message_delta');
      expect((md?.data.delta as Record<string, unknown>)?.stop_reason).toBe('tool_use');
    } finally {
      await harness.close();
    }
  }, 60000);

  /**
   * 非流式 fallback 的活体验证 —— Claude Code 的 stream watchdog 触发后会以 stream:false
   * 重试同一轮,并期待一个完整的 Anthropic Message JSON。这里直接构造该请求,不必复现卡顿。
   *
   * 它同时验证一个关键假设:**chatgpt.com/backend-api/codex 是否接受 stream:false**。
   * 若上游拒收(4xx),说明桥不该把 stream 透传给上游,而应恒请求 SSE、只改下游表示。
   */
  for (const model of ['chatgpt/gpt-5.5', 'chatgpt/gpt-5.6-sol']) {
    it(`非流式 fallback:${model} + stream:false → 完整 Anthropic Message JSON`, async () => {
      const harness = await startHarness(makeCodexHandler());
      try {
        const res = await fetch(`${harness.url}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'live-test-nonstream' },
          body: JSON.stringify({
            model,
            system: 'You are terse.',
            max_tokens: 64,
            stream: false,
            messages: [{ role: 'user', content: 'Reply with exactly: nonstream ok' }],
          }),
        });
        const bodyText = await res.text();
        console.log(`[${model}] 非流式 status:`, res.status, '| content-type:', res.headers.get('content-type'));
        console.log(`[${model}] 非流式正文:`, bodyText.slice(0, 1200));
        expect(res.status).toBe(200);
        // 下游必须是 JSON,不能是 SSE —— 这正是截图里 CLI 判 malformed 的原因。
        expect(res.headers.get('content-type')).toContain('application/json');
        const msg = JSON.parse(bodyText) as Record<string, unknown>;
        expect(msg.type).toBe('message');
        expect(msg.role).toBe('assistant');
        expect(msg.model).toBe(model);
        expect(Array.isArray(msg.content)).toBe(true);
        const text = (msg.content as Array<Record<string, unknown>>)
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('');
        console.log(`[${model}] 非流式输出文本:`, JSON.stringify(text), '| stop_reason:', msg.stop_reason);
        expect(text.toLowerCase()).toContain('nonstream');
      } finally {
        await harness.close();
      }
    }, 60000);
  }
});
