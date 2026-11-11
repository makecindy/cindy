/**
 * 端到端验证「stream watchdog → 非流式 fallback → bridge」整条链路 —— **不联网、不用凭证**。
 *
 * 拓扑:
 *   真实 claude 二进制(apps/claude-code-bin,与 Desktop 随包同一份)
 *     → ANTHROPIC_BASE_URL 指向本地 bridge handler
 *       → upstreamBase 指向本地 Responses stub
 *
 * stub 在 cc 升级到非流式之前每次都「发两帧后断 socket」,逼它把流式重试耗尽 —— cc 只在
 * 流式尝试抛错后才走非流式 fallback,且该 fallback 请求**不带 stream 字段**。bridge 必须
 * 回一个完整的 Anthropic Message JSON;修复前它回的是 HTTP 200 + SSE,cc 随即报
 * "API returned an empty or malformed response (HTTP 200)" —— 正是用户截图那条。
 *
 * 默认跳过(spawn 真实 CLI、耗时数十秒);需要时:
 *   BRIDGE_E2E=1 pnpm --filter @cindy/anthropic-responses-bridge exec vitest run src/__tests__/nonstream-fallback-e2e.test.ts
 *
 * 二进制按当前平台解析,本平台没有随包二进制时用例显式 skip(见 resolveClaudeBin)。
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createResponsesHandler } from '../handler.js';

const E2E = process.env.BRIDGE_E2E === '1';
const ANSWER = 'nonstream fallback ok';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * 按当前平台解析随包 cc 二进制(与 scripts/ensure-agent-binaries.mjs 的
 * `currentPlatformKey()` / `binFileFor()` 同约定:`<platform>-<arch>` 目录 + win32 带 .exe)。
 * 该平台没有就位的二进制时返回 null —— 由用例显式 skip,而不是断言失败:随包二进制按平台
 * 下载,别的平台开 BRIDGE_E2E=1 不该看到一个「测试失败」。
 */
function resolveClaudeBin(): string | null {
  const platformKey = `${process.platform}-${process.arch}`;
  const binFile = platformKey.startsWith('win32') ? 'claude.exe' : 'claude';
  const candidate = path.join(repoRoot, 'apps/claude-code-bin', platformKey, binFile);
  return fs.existsSync(candidate) ? candidate : null;
}

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 完整的一轮 Responses SSE(纯文本回答)。 */
function completeStream(): string {
  return [
    sseFrame({ type: 'response.created', response: { id: 'resp_stub', model: 'gpt-5.6-sol' } }),
    sseFrame({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } }),
    sseFrame({ type: 'response.output_text.delta', output_index: 0, delta: ANSWER }),
    sseFrame({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } }),
    sseFrame({
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 5 } },
    }),
  ].join('');
}

/** bridge 与 stub 共享的链路状态。 */
interface ChainState {
  /** bridge 收到的下游非流式请求数(`stream` 非 true = cc 升级到非流式 fallback)。 */
  nonStream: number;
}

/**
 * Responses stub:**在 cc 升级到非流式 fallback 之前,每次请求都发一半后挂住**,逼 cc 把
 * 流式重试耗尽 —— cc 只在流式尝试抛错后才走非流式(二进制里的
 * "Error streaming, falling back to non-streaming mode" 分支)。一旦 bridge 收到
 * `stream:false`(state.nonStream > 0),后续请求给完整流,让这一轮能正常收敛。
 */
function startStubUpstream(state: ChainState): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let seen = 0;
  const stalled: Array<{ destroy: () => void }> = [];
  const server: Server = createServer((req, res) => {
    req.on('data', () => { /* 请求体不参与判定:bridge 对上游恒发 stream:true */ });
    req.on('end', () => {
      seen += 1;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (state.nonStream === 0) {
        // 发出开头两帧后**直接断 socket** —— 硬流式错误,cc 二进制里
        // "Error streaming, falling back to non-streaming mode" 的直接触发条件。
        // (纯 idle 挂住会让 cc 等到 API_TIMEOUT_MS 才动,慢且不确定。)
        res.write(sseFrame({ type: 'response.created', response: { id: 'resp_stall', model: 'gpt-5.6-sol' } }));
        res.write(sseFrame({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_0', type: 'message' } }));
        setTimeout(() => res.destroy(), 50);
        return;
      }
      res.end(completeStream());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests: () => seen,
        close: () => new Promise<void>((r) => {
          for (const s of stalled) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

/** 本地 Anthropic 面:把请求交给 bridge handler(与 compat-proxy 的 localHandler 同形态)。 */
function startBridge(upstreamBase: string, state: ChainState): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = createResponsesHandler({
    providers: [{
      prefix: 'chatgpt/',
      upstreamBase,
      buildHeaders: async () => ({ authorization: 'Bearer stub' }),
    }],
  });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsedBody = undefined;
      }
      // cc 的非流式 fallback **不带 stream 字段**(SDK messages.create()),不是 stream:false。
      if (parsedBody && typeof parsedBody === 'object' && (parsedBody as { stream?: unknown }).stream !== true) {
        state.nonStream += 1;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      }
      void handler.handle({
        parsedBody,
        ctx: { method: req.method ?? 'POST', url: req.url ?? '/', headers },
        res,
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe.skipIf(!E2E)('watchdog → 非流式 fallback → bridge(真实 claude 二进制,本地 stub 上游)', () => {
  it('上游中途断流 → cc 升级非流式 fallback → bridge 回完整 Message,cc 正常出答案', async (ctx) => {
    const claudeBin = resolveClaudeBin();
    if (!claudeBin) {
      // 随包二进制按平台下载(见 scripts/ensure-agent-binaries.mjs);本平台没有就位时
      // 明确跳过,不伪装成失败。
      console.warn(`跳过:本平台(${process.platform}-${process.arch})没有随包 claude 二进制`);
      ctx.skip();
      return;
    }
    const state: ChainState = { nonStream: 0 };
    const stub = await startStubUpstream(state);
    const bridge = await startBridge(stub.url, state);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-home-'));
    try {
      const child = spawn(claudeBin, [
        '--print',
        '--model', 'chatgpt/gpt-5.6-sol',
        `Reply with exactly: ${ANSWER}`,
      ], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: bridge.url,
          ANTHROPIC_AUTH_TOKEN: 'stub-token',
          ANTHROPIC_API_KEY: 'stub-token',
          // 与 Desktop 的 env-builder 同口径:开 watchdog、保留非流式 fallback。
          CLAUDE_ENABLE_STREAM_WATCHDOG: 'true',
          CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1500',
          API_TIMEOUT_MS: '15000',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          OTEL_SDK_DISABLED: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 240_000);
        child.on('close', (c) => { clearTimeout(timer); resolve(c); });
      });

      console.log('cc exit code:', code);
      console.log('cc stdout:', stdout.trim().slice(0, 2000));
      if (stderr.trim()) console.log('cc stderr:', stderr.trim().slice(0, 2000));
      console.log('stub 收到上游请求数:', stub.requests(), '| bridge 收到非流式请求数:', state.nonStream);

      // 关键断言:watchdog 触发过(上游被打了 ≥2 次)、bridge 收到过非流式请求,
      // 且 cc 最终拿到了答案而不是那条 empty/malformed banner。
      expect(state.nonStream).toBeGreaterThan(0);
      expect(stub.requests()).toBeGreaterThan(1);
      expect(stdout + stderr).not.toContain('empty or malformed response');
      expect(stdout.toLowerCase()).toContain('nonstream fallback ok');
    } finally {
      await bridge.close();
      await stub.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
