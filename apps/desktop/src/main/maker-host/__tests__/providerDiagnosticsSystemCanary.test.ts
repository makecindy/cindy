/**
 * 「测试连接」的 system canary（#9000）：
 * 少数第三方中转在 /v1/messages 上静默丢弃 `system` —— 请求照常 200、流也正常结束，但
 * agent 的指令与工具规范全部没生效。探针因此自带一段固定填充，并在 200 之后用 usage
 * 反证它是否真的计入了输入 token。
 *
 * 覆盖：
 *   - Anthropic Messages 探针带上与真实会话同形的 system 块；
 *   - usage 不随 system 增长 → WIRE_INCOMPATIBLE（把「能连但用不了」暴露在配置阶段）；
 *   - 命中缓存（记在 cache_read）时仍判为 ok；超大响应体不上结论；
 *   - usage 计入 → ok；响应没有 usage → 不下结论、保持 ok（不误伤合法端点）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const probeLog = vi.hoisted(() => ({
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), error: vi.fn(),
}));
vi.mock('../logger-adapter', () => ({
  createMakerLogger: () => ({ ...probeLog, child: () => probeLog }),
}));

import {
  buildProbeRequest,
  runProviderProbe,
  PROBE_SYSTEM_MIN_INPUT_TOKENS,
  PROBE_SYSTEM_TEXT,
} from '../provider-diagnostics.js';

afterEach(() => {
  probeLog.warn.mockClear();
});

function fakeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('test-connection system canary', () => {
  it('Anthropic Messages 探针带上与真实会话同形的 system 块', () => {
    const { init } = buildProbeRequest({
      agent: 'claude-code',
      baseUrl: 'https://relay.example',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'sk-test',
    });
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      system: Array<{ type: string; text: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.system).toEqual([{ type: 'text', text: PROBE_SYSTEM_TEXT }]);
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(body.max_tokens).toBe(1);
    // 填充要足够大到能与「只剩 ping」区分，又不能让测试连接变成昂贵请求。
    expect(PROBE_SYSTEM_TEXT.length).toBeGreaterThan(2_000);
    expect(PROBE_SYSTEM_TEXT.length).toBeLessThan(8_000);
    expect(PROBE_SYSTEM_MIN_INPUT_TOKENS).toBeGreaterThan(100);
  });

  it('200 但 usage 不随 system 增长 → WIRE_INCOMPATIBLE', async () => {
    const result = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://relay.example', modelId: 'm', apiKey: 'k' },
      async () => fakeResponse(200, JSON.stringify({ usage: { input_tokens: 12, output_tokens: 0 } })),
    );
    expect(result).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE', status: 200 });
    expect(result.detail).toContain('12 input tokens');
    expect(result.detail).toContain('drops `system`');
  });

  it('200 且 system 前缀命中缓存（记在 cache_read）→ 仍判为 ok', async () => {
    // 同一次测试连点两下时，固定前缀会进缓存；只看 input_tokens 会把正常端点误报成丢弃 system。
    const result = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://relay.example', modelId: 'm', apiKey: 'k' },
      async () =>
        fakeResponse(200, JSON.stringify({
          usage: { input_tokens: 12, cache_read_input_tokens: PROBE_SYSTEM_MIN_INPUT_TOKENS + 400 },
        })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('响应体超过读取上限 → 取消读流、不下结论', async () => {
    const result = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://relay.example', modelId: 'm', apiKey: 'k' },
      async () =>
        fakeResponse(200, JSON.stringify({ usage: { input_tokens: 1 }, pad: 'x'.repeat(64 * 1024) })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('200 且 usage 计入 system → ok', async () => {
    const result = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://relay.example', modelId: 'm', apiKey: 'k' },
      async () =>
        fakeResponse(200, JSON.stringify({ usage: { input_tokens: PROBE_SYSTEM_MIN_INPUT_TOKENS + 400 } })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('200 但没有 usage → 不下结论，保持 ok', async () => {
    const result = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://relay.example', modelId: 'm', apiKey: 'k' },
      async () => fakeResponse(200, '{"content":[]}'),
    );
    expect(result).toMatchObject({ ok: true });
  });
});
