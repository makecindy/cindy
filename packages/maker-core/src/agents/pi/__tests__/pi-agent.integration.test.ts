/**
 * PiAgent 端到端集成测试 —— 真 spawn pi 二进制 + 本地假 Anthropic 网关。
 *
 * 覆盖链路:startSession(spawn pi --mode rpc + models.json 生成)→ session_id
 * 回填 → send(prompt)→ 假网关 SSE 流 → translator(text/status/done 事件)→
 * usage 快照 → close。
 *
 * 依赖 apps/pi-bin/<platform>/pi 就位(pnpm install:pi);二进制缺失时整组 skip
 * (CI / 未装 pi 的环境不红)。
 */

import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PiAgent } from '../index.js';
import { TurnPermissionPolicyUnsupportedError, type AgentDeps, type AgentSessionHandle } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
// Local installs keep the same versioned binary outside the worktree. The
// override lets a lightweight harness smoke use that binary without copying it
// into apps/pi-bin or starting Desktop; CI keeps the repository-managed path.
const PI_BINARY =
  process.env.CINDY_TEST_PI_BINARY ||
  path.join(
    REPO_ROOT,
    'apps',
    'pi-bin',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'pi.exe' : 'pi',
  );
const RIPGREP_DIR = path.join(
  REPO_ROOT,
  'apps',
  'ripgrep-bin',
  `${process.platform}-${process.arch}`,
);
const RIPGREP_BINARY = path.join(RIPGREP_DIR, process.platform === 'win32' ? 'rg.exe' : 'rg');
const PREVIOUS_PI_BINARY = path.join(
  REPO_ROOT,
  'tools',
  'pi',
  'updates',
  '0.82.1',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'pi.exe' : 'pi',
);

const piAvailable = existsSync(PI_BINARY);

const canSymlink = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), 'pi-symlink-probe-'));
  try {
    const target = path.join(probeDir, 'target.txt');
    writeFileSync(target, 'probe');
    symlinkSync(target, path.join(probeDir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/** 最小合法的 Anthropic Messages SSE 流:一段 text + usage。 */
function anthropicStreamBody(text: string): string {
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test_1',
          type: 'message',
          role: 'assistant',
          model: 'pi-test-model',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

/** 最小完整的 OpenAI Responses SSE 流：供 Pi 原生 Responses BYOM 回归使用。 */
function responsesStreamBody(text: string, model: string): string {
  const responseId = 'resp_byom_reasoning_1';
  const item = {
    id: 'msg_byom_reasoning_1',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  };
  const completed = {
    id: responseId,
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [item],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: 'xhigh', summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    metadata: {},
  };
  return sse([
    {
      event: 'response.created',
      data: {
        type: 'response.created',
        sequence_number: 0,
        response: {
          ...completed,
          status: 'in_progress',
          output: [],
          usage: null,
        },
      },
    },
    {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        sequence_number: 1,
        response_id: responseId,
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
    },
    {
      event: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        sequence_number: 2,
        response_id: responseId,
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      },
    },
    {
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        sequence_number: 3,
        response_id: responseId,
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
        logprobs: [],
      },
    },
    {
      event: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        sequence_number: 4,
        response_id: responseId,
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text,
        logprobs: [],
      },
    },
    {
      event: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        sequence_number: 5,
        response_id: responseId,
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      },
    },
    {
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        sequence_number: 6,
        response_id: responseId,
        output_index: 0,
        item,
      },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        sequence_number: 7,
        response: completed,
      },
    },
  ]);
}

/** 最小 OpenAI Chat Completions SSE 流：验证 PI 内置模型表的 completions 分配。 */
function chatCompletionsStreamBody(text: string, model: string): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl_pi_native_1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl_pi_native_1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl_pi_native_1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

/** 让"模型"发起一次工具调用的 SSE 流(stop_reason=tool_use)。 */
function anthropicToolUseBody(toolName: string, input: Record<string, unknown>): string {
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_tool_1',
          type: 'message',
          role: 'assistant',
          model: 'pi-test-model',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_itest_1', name: toolName, input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

describe.skipIf(!piAvailable)('PiAgent integration (real pi binary + fake gateway)', () => {
  let server: Server;
  let endpoint = '';
  let agentHome = '';
  const seenRequests: Array<{
    url: string;
    auth: string | undefined;
    sessionId: string | undefined;
    providerId: string | undefined;
    body: string;
  }> = [];
  // 权限测试用的脚本化响应队列:非空时按序出队,空了回落默认 pong 文本。
  const scriptedResponses: string[] = [];

  beforeAll(async () => {
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-agent-int-'));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seenRequests.push({
          url: req.url ?? '',
          auth: (req.headers['x-api-key'] as string | undefined) ?? (req.headers.authorization as string | undefined),
          sessionId: req.headers['x-cindy-pi-session-id'] as string | undefined,
          providerId: req.headers['x-cindy-pi-provider-id'] as string | undefined,
          body,
        });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.end(scriptedResponses.shift() ?? anthropicStreamBody('pong from fake gateway'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'object' && address) endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agentHome, { recursive: true, force: true });
  });

  function buildDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'test-key-123' }),
      },
      runtimeConfig: { endpoint, managedExecutablePaths: { ripgrep: RIPGREP_BINARY } },
      binaryPath: PI_BINARY,
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: 'pi-test-model',
            displayName: 'Pi Test Model',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
            // 网关图片门控(assertImageInputSupported)按目录能力放行;多模态用例
            // 走的正是本模型,不标会在 send 前被 PiImageInputUnsupportedError 拒收。
            supportsImageInput: true,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiGatewayModelApi: () => 'anthropic-messages',
    };
  }

  it(
    'startSession → send → streams text and settles → usage/cost tracked → close',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'itest-session',
          workingDir,
          model: 'pi-test-model',
        });

        expect(handle.agentKind).toBe('pi');
        // sdkSessionId = pi 会话 JSONL 路径(resume 钥匙)
        expect(handle.id.length).toBeGreaterThan(0);

        const events: AgentEvent[] = [];
        const collected = (async () => {
          for await (const ev of handle!.events()) {
            events.push(ev);
            if (ev.type === 'done') break;
          }
        })();

        await handle.send({ type: 'user', content: 'ping' });
        await collected;

        const types = events.map((e) => e.type);
        expect(types).toContain('session_id');
        expect(types).toContain('text');
        expect(types).toContain('done');

        const finalText = events
          .filter((e) => e.type === 'text')
          .map((e) => (e.data as { text: string; isFinal?: boolean }))
          .filter((d) => d.isFinal)
          .map((d) => d.text)
          .join('');
        expect(finalText).toContain('pong from fake gateway');

        // 请求真的打到了假网关,且带上了 env 插值出来的 key
        expect(seenRequests.length).toBeGreaterThan(0);
        expect(seenRequests.some((r) => (r.auth ?? '').includes('test-key-123'))).toBe(true);
        expect(seenRequests.some((r) => r.sessionId === 'itest-session')).toBe(true);

        // usage:input 42 + output 7(anthropic 流里的 usage 记账)
        const usage = handle.getUsageSnapshot();
        expect(usage.tokenUsage).toBeGreaterThan(0);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'keeps provider cindy and sends a gateway Responses model to /v1/responses',
    { timeout: 60_000 },
    async () => {
      const deps = buildDeps();
      deps.capabilityAdditions = {
        ...deps.capabilityAdditions,
        availableModels: [
          ...(deps.capabilityAdditions?.availableModels ?? []),
          {
            id: 'pi-responses-model',
            displayName: 'Pi Responses Model',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      };
      deps.resolvePiGatewayModelApi = (_providerId, modelId) =>
        modelId === 'pi-responses-model' ? 'openai-responses' : 'anthropic-messages';
      const agent = new PiAgent(deps);
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-responses-cwd-'));
      let handle: AgentSessionHandle | null = null;
      const requestsBefore = seenRequests.length;
      scriptedResponses.push(responsesStreamBody('pong from responses gateway', 'pi-responses-model'));
      try {
        handle = await agent.startSession({
          sessionId: 'itest-responses-session',
          workingDir,
          model: 'pi-responses-model',
          providerId: 'xd',
        });
        const events: AgentEvent[] = [];
        const collected = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'done') break;
          }
        })();

        await handle.send({ type: 'user', content: 'ping responses' });
        await collected;

        expect(seenRequests.slice(requestsBefore).some((request) => request.url === '/v1/responses'))
          .toBe(true);
        expect(events.some((event) =>
          event.type === 'text'
          && (event.data as { text?: string }).text?.includes('pong from responses gateway'),
        )).toBe(true);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'uses the bundled openai-codex adapter for a host subscription model',
    { timeout: 60_000 },
    async () => {
      const deps = buildDeps();
      deps.capabilityAdditions = {
        ...deps.capabilityAdditions,
        availableModels: [
          ...(deps.capabilityAdditions?.availableModels ?? []),
          {
            id: 'chatgpt/gpt-cindy-daily-test',
            displayName: 'GPT Daily Catalog Test',
            contextWindow: 272_000,
            efforts: ['low', 'high'],
            defaultEffort: 'high',
          },
        ],
      };
      const encode = (value: unknown): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const placeholderJwt = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
        'https://api.openai.com/auth': { chatgpt_account_id: 'cindy-pi-proxy' },
      })}.`;
      deps.resolvePiNativeProviders = async () => ({
        providers: [{
          id: 'openai-codex',
          sourceProviderId: 'openai',
          name: 'OpenAI (ChatGPT)',
          baseUrl: endpoint,
          inheritModels: true,
          apiKeyEnvVar: 'CINDY_PI_OPENAI_PROXY_KEY',
          headers: {
            'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
            'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
            'x-cindy-pi-provider-id': 'openai',
          },
          models: [{
            id: 'chatgpt/gpt-cindy-daily-test',
            wireId: 'gpt-cindy-daily-test',
            catalogAddition: true,
            contextWindow: 272_000,
            maxTokens: 32_000,
          }],
        }],
        env: { CINDY_PI_OPENAI_PROXY_KEY: placeholderJwt },
      });
      const agent = new PiAgent(deps);
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-native-codex-cwd-'));
      let handle: AgentSessionHandle | null = null;
      const requestsBefore = seenRequests.length;
      scriptedResponses.push(responsesStreamBody('pong from native codex', 'gpt-cindy-daily-test'));
      try {
        handle = await agent.startSession({
          sessionId: 'itest-native-codex-session',
          workingDir,
          model: 'chatgpt/gpt-cindy-daily-test',
          providerId: 'openai',
          effort: 'high',
        });
        const events: AgentEvent[] = [];
        const collected = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'done') break;
          }
        })();

        await handle.send({ type: 'user', content: 'ping native codex' });
        await collected;

        const nativeRequests = seenRequests.slice(requestsBefore);
        expect(nativeRequests.some((request) => request.url === '/codex/responses')).toBe(true);
        expect(nativeRequests.some((request) => request.url === '/v1/messages')).toBe(false);
        expect(events.some((event) =>
          event.type === 'text'
          && (event.data as { text?: string }).text?.includes('pong from native codex'),
        )).toBe(true);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'uses PI native Anthropic Messages for a host Claude subscription model',
    { timeout: 60_000 },
    async () => {
      const deps = buildDeps();
      deps.capabilityAdditions = {
        ...deps.capabilityAdditions,
        availableModels: [
          ...(deps.capabilityAdditions?.availableModels ?? []),
          {
            id: 'claude-opus-5',
            displayName: 'Claude Opus 5',
            contextWindow: 1_000_000,
            efforts: ['high'],
            defaultEffort: 'high',
          },
        ],
      };
      deps.resolvePiNativeProviders = async () => ({
        providers: [{
          id: 'anthropic',
          sourceProviderId: 'anthropic',
          name: 'Anthropic',
          baseUrl: endpoint,
          inheritModels: true,
          headers: {
            'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
            'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
            'x-cindy-pi-provider-id': 'anthropic',
          },
          models: [{ id: 'claude-opus-5', wireId: 'claude-opus-5' }],
        }],
        env: {},
      });
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-native-anthropic-cwd-'));
      let handle: AgentSessionHandle | null = null;
      const requestsBefore = seenRequests.length;
      scriptedResponses.push(anthropicStreamBody('pong from native anthropic'));
      try {
        handle = await new PiAgent(deps).startSession({
          sessionId: 'itest-native-anthropic-session',
          workingDir,
          model: 'claude-opus-5',
          providerId: 'anthropic',
          effort: 'high',
        });
        const collected = (async () => {
          for await (const event of handle!.events()) {
            if (event.type === 'done') break;
          }
        })();

        await handle.send({ type: 'user', content: 'ping native anthropic' });
        await collected;

        expect(seenRequests.slice(requestsBefore)).toEqual(expect.arrayContaining([
          expect.objectContaining({
            url: '/v1/messages',
            providerId: 'anthropic',
          }),
        ]));
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'uses PI bundled xAI APIs as the baseline for Responses and Chat Completions models',
    { timeout: 60_000 },
    async () => {
      const deps = buildDeps();
      deps.capabilityAdditions = {
        ...deps.capabilityAdditions,
        availableModels: [
          ...(deps.capabilityAdditions?.availableModels ?? []),
          {
            id: 'xai/grok-4.5', displayName: 'Grok 4.5', contextWindow: 1_000_000,
            efforts: ['high'], defaultEffort: 'high',
          },
          {
            id: 'xai/grok-build-0.1', displayName: 'Grok Build', contextWindow: 256_000,
            efforts: [], defaultEffort: null,
          },
        ],
      };
      deps.resolvePiNativeProviders = async () => ({
        providers: [{
          id: 'xai',
          sourceProviderId: 'xai',
          name: 'xAI (SuperGrok)',
          baseUrl: `${endpoint}/v1`,
          inheritModels: true,
          headers: {
            'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
            'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
            'x-cindy-pi-provider-id': 'xai',
          },
          models: [
            { id: 'xai/grok-4.5', wireId: 'grok-4.5' },
            { id: 'xai/grok-build-0.1', wireId: 'grok-build-0.1' },
          ],
        }],
        env: {},
      });
      const agent = new PiAgent(deps);

      const run = async (
        sessionId: string,
        model: string,
        response: string,
        expectedPath: string,
      ): Promise<void> => {
        const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-native-xai-cwd-'));
        let handle: AgentSessionHandle | null = null;
        const requestsBefore = seenRequests.length;
        scriptedResponses.push(response);
        try {
          handle = await agent.startSession({
            sessionId,
            workingDir,
            model,
            providerId: 'xai',
            ...(model.endsWith('grok-4.5') ? { effort: 'high' as const } : {}),
          });
          const collected = (async () => {
            for await (const event of handle!.events()) {
              if (event.type === 'done') break;
            }
          })();
          await handle.send({ type: 'user', content: 'ping native xai' });
          await collected;
          const requests = seenRequests.slice(requestsBefore);
          expect(requests.some((request) => request.url === expectedPath)).toBe(true);
          expect(requests.some((request) => request.url === '/v1/messages')).toBe(false);
        } finally {
          await handle?.close();
          rmSync(workingDir, { recursive: true, force: true });
        }
      };

      await run(
        'itest-native-xai-responses',
        'xai/grok-4.5',
        responsesStreamBody('pong from xai responses', 'grok-4.5'),
        '/v1/responses',
      );
      await run(
        'itest-native-xai-completions',
        'xai/grok-build-0.1',
        chatCompletionsStreamBody('pong from xai completions', 'grok-build-0.1'),
        '/v1/chat/completions',
      );
    },
  );

  it(
    'accepts a turn permission policy in ask, rejects it in Full Access, and honors steer cancellation before RPC',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'itest-policy-cancel',
          workingDir,
          model: 'pi-test-model',
        });
        const requestsBefore = seenRequests.length;

        // ask/auto 下 Pi bridge 会把受控工具冒泡给 host，policy turn 可以启动。
        const policy = {
          origin: { kind: 'im' as const, channel: 'telegram' as const },
          confirmationSurface: 'channel' as const,
          forceConfirmToolCall: () => true,
        };
        await expect(
          handle.send({ type: 'user', content: 'policy-safe turn' }, { turnPermissionPolicy: policy }),
        ).resolves.toBeUndefined();
        await vi.waitFor(() => expect(seenRequests.length).toBeGreaterThan(requestsBefore));

        // Full Access 下 bridge 不上报 tool_call，host 无法兑现每轮策略，必须 preflight 拒绝。
        await handle.setPermissionMode?.('bypassPermissions');
        const requestsBeforeFullAccess = seenRequests.length;
        await expect(
          handle.send({ type: 'user', content: 'destructive?' }, { turnPermissionPolicy: policy }),
        ).rejects.toBeInstanceOf(TurnPermissionPolicyUnsupportedError);

        // 已 abort 的 signal:steer 必须在投递 RPC 前抛出,Pi 不得消费该消息
        // (否则协调器按撤下的标记丢弃不落库,模型在不可见 steer 上继续跑)。
        const aborted = new AbortController();
        aborted.abort();
        await expect(
          handle.steer({ type: 'user', content: 'late steer' }, { signal: aborted.signal }),
        ).rejects.toThrow(/cancelled before acceptance/);

        // Full Access policy 与 cancelled steer 都在到达假网关前被拦下。
        expect(seenRequests.length).toBe(requestsBeforeFullAccess);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'forkSdkSession clones a live session into a new session file (offline, no gateway)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-fork-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'fork-src-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 跑一轮让源 session 落盘内容(fork 读的是持久化的 jsonl)。
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'seed message for fork' });
        await done;

        const sourceId = handle.id;
        expect(sourceId.length).toBeGreaterThan(0);

        // 整条 fork(tailTurnsToDrop 省略 = 0 → clone)。fork 进程 --offline,不打网关。
        const seenBefore = seenRequests.length;
        const forked = await agent.forkSdkSession({
          sourceSdkSessionId: sourceId,
          upToMessageId: undefined,
          title: 'forked branch',
        });

        expect(forked.newSdkSessionId.length).toBeGreaterThan(0);
        expect(forked.newSdkSessionId).not.toBe(sourceId);
        expect(existsSync(forked.newSdkSessionId)).toBe(true);
        // 与 Codex 一致:pi 不落 SDK message uuid,uuidMap 为空。
        expect(forked.uuidMap.size).toBe(0);
        // fork 是纯本地文件操作,不应产生任何网关请求。
        expect(seenRequests.length).toBe(seenBefore);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'precise rewind forks at the selected Pi turn and the replacement session resumes',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-rewind-cwd-'));
      let handle: AgentSessionHandle | null = null;
      let resumed: AgentSessionHandle | null = null;
      const sendAndWait = async (target: AgentSessionHandle, text: string) => {
        const done = (async () => {
          for await (const event of target.events()) if (event.type === 'done') break;
        })();
        await target.send({ type: 'user', content: text });
        await done;
      };
      try {
        handle = await agent.startSession({ sessionId: 'rewind-source', workingDir, model: 'pi-test-model' });
        await sendAndWait(handle, 'turn one');
        await sendAndWait(handle, 'turn two');
        expect(await handle.previewRewindFiles?.('')).toMatchObject({ canRewind: true });

        // 捕获 rewind 前的原始 session 文件:替代文件必须与它不同。handle.id 现在是动态
        // getter,commitRewindFiles 会把 sdkSessionId 就地更新为替代文件,所以切换后
        // handle.id === result.sdkSessionId(正是本次修复的目的),要比对捕获的原始值。
        const originalSessionId = handle.id;
        const result = await handle.commitRewindFiles?.('', '', { tailTurnsToDrop: 1 });
        expect(result?.sdkSessionId).toBeTruthy();
        expect(result?.sdkSessionId).not.toBe(originalSessionId);
        // handle.id getter 跟随闭包,rewind 后指向新的替代 session 文件。
        expect(handle.id).toBe(result?.sdkSessionId);
        await handle.close();
        handle = null;

        resumed = await agent.startSession({
          sessionId: 'rewind-resume',
          workingDir,
          model: 'pi-test-model',
          resumeSessionId: result?.sdkSessionId,
        });
        await sendAndWait(resumed, 'replacement turn two');
      } finally {
        await handle?.close();
        await resumed?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'falls back from an invalid resume only when the host CAS allows it',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-invalid-resume-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'invalid-resume-allowed',
          workingDir,
          model: 'pi-test-model',
          resumeSessionId: path.join(workingDir, 'missing.jsonl'),
          onInvalidResumeSession: async () => true,
        });
        expect(handle.id).toBeTruthy();
        await handle.close();
        handle = null;
        // 轮 25 CRITICAL:CAS 返回值不再作为 fallback 门禁 —— session 文件缺失
        // 时 fresh 是唯一合理选择(文件都没了, 不存在覆盖并发新值的风险)。
        // CAS=false 也允许 fresh(CAS 仅清 DB 残留, 结果不阻断)。
        const freshHandle = await agent.startSession({
          sessionId: 'invalid-resume-rejected',
          workingDir,
          model: 'pi-test-model',
          resumeSessionId: path.join(workingDir, 'still-missing.jsonl'),
          onInvalidResumeSession: async () => false,
        });
        expect(freshHandle.id).toBeTruthy();
        await freshHandle.close();
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync(PREVIOUS_PI_BINARY))(
    'resumes a v0.82.1 session after upgrading the embedded runtime to v0.83.0',
    { timeout: 60_000 },
    async () => {
      const oldDeps = buildDeps();
      oldDeps.binaryPath = PREVIOUS_PI_BINARY;
      const oldAgent = new PiAgent(oldDeps);
      const newAgent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-upgrade-resume-'));
      let oldHandle: AgentSessionHandle | null = null;
      let newHandle: AgentSessionHandle | null = null;
      try {
        oldHandle = await oldAgent.startSession({ sessionId: 'pre-upgrade', workingDir, model: 'pi-test-model' });
        const done = (async () => {
          for await (const event of oldHandle!.events()) if (event.type === 'done') break;
        })();
        await oldHandle.send({ type: 'user', content: 'created by the previous runtime' });
        await done;
        const resumeSessionId = oldHandle.id;
        await oldHandle.close();
        oldHandle = null;

        newHandle = await newAgent.startSession({
          sessionId: 'post-upgrade',
          workingDir,
          model: 'pi-test-model',
          resumeSessionId,
        });
        const tree = await newHandle.getSessionTree?.();
        const flattened = tree?.roots.flatMap(function flatten(node): typeof tree.roots {
          return [node, ...node.children.flatMap(flatten)];
        }) ?? [];
        expect(flattened.some((node) => node.role === 'user')).toBe(true);
      } finally {
        await oldHandle?.close();
        await newHandle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'reads and navigates the native session tree without calling the model',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-tree-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'tree-session',
          workingDir,
          model: 'pi-test-model',
        });
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'seed prompt for native tree' });
        await done;

        const before = await handle.getSessionTree?.();
        expect(before?.leafId).toBeTruthy();
        const user = before?.roots
          .flatMap(function flatten(node): typeof before.roots {
            return [node, ...node.children.flatMap(flatten)];
          })
          .find((node) => node.role === 'user');
        expect(user).toBeDefined();

        const gatewayBefore = seenRequests.length;
        const switched = await handle.navigateSessionTree?.(user!.id, { summarize: false });
        expect(switched?.draftText).toBe('seed prompt for native tree');
        expect(switched?.tree.leafId).not.toBe(before?.leafId);
        expect(switched?.messages.some((message) => message.role === 'user')).toBe(false);
        expect(switched?.contextWindow).toBeGreaterThan(0);
        expect(seenRequests.length).toBe(gatewayBefore);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'forwards an image attachment through pi to the gateway (multimodal image)',
    { timeout: 60_000 },
    async () => {
      // 合法 1x1 透明 PNG —— pi 不会因非法图片拒收;其 base64 应原样出现在网关请求体。
      const PNG_1x1_B64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-img-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        const imgPath = path.join(workingDir, 'pixel.png');
        writeFileSync(imgPath, Buffer.from(PNG_1x1_B64, 'base64'));

        handle = await agent.startSession({
          sessionId: 'img-session',
          workingDir,
          model: 'pi-test-model',
        });
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({
          type: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image', path: imgPath },
          ],
        });
        await done;

        // pi 应把图片 base64 转发进网关请求(Anthropic image content block)。
        const sawImage = seenRequests.some((r) => r.body.includes(PNG_1x1_B64));
        expect(sawImage).toBe(true);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'forwards one review turn with Markdown/PDF excerpts and image bytes',
    { timeout: 60_000 },
    async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-review-formats-'));
      const markdownPath = path.join(workingDir, 'launch.md');
      const pdfPath = path.join(workingDir, 'contract.pdf');
      const imagePath = path.join(workingDir, 'poster.png');
      writeFileSync(markdownPath, '# Launch\nBudget: 100 vs 80 + 50');
      writeFileSync(pdfPath, '%PDF-1.4\n% transport fixture');
      writeFileSync(imagePath, Buffer.from(pngBase64, 'base64'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'review-format-session',
          workingDir,
          model: 'pi-test-model',
          reviewMode: true,
          reviewReadPaths: [markdownPath, pdfPath, imagePath],
        });
        const before = seenRequests.length;
        const done = (async () => {
          for await (const event of handle!.events()) if (event.type === 'done') break;
        })();
        await handle.send({
          type: 'user',
          content: [
            {
              type: 'text',
              text: 'Markdown budget: 100 vs 80 + 50. PDF payment: 30 days vs 60 days.',
            },
            { type: 'file', path: markdownPath, mimeType: 'text/markdown' },
            { type: 'file', path: pdfPath, mimeType: 'application/pdf' },
            { type: 'image', path: imagePath, mimeType: 'image/png' },
          ],
        });
        await done;

        const bodies = seenRequests.slice(before).map((request) => request.body).join('\n');
        expect(bodies).toContain('Markdown budget: 100 vs 80 + 50');
        expect(bodies).toContain('PDF payment: 30 days vs 60 days');
        expect(bodies).toContain(jsonStringContent(markdownPath));
        expect(bodies).toContain(jsonStringContent(pdfPath));
        expect(bodies).toContain(pngBase64);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'sends file attachments and hot-updated Extra Dirs as read-only references',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-file-cwd-'));
      const referenceDir = mkdtempSync(path.join(tmpdir(), 'pi-extra-ref-'));
      const filePath = path.join(referenceDir, 'spec.txt');
      writeFileSync(filePath, 'reference material');
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'file-extra-session',
          workingDir,
          model: 'pi-test-model',
        });
        await handle.setExtraDirs?.([referenceDir]);
        const before = seenRequests.length;
        const done = (async () => {
          for await (const event of handle!.events()) if (event.type === 'done') break;
        })();
        await handle.send({
          type: 'user',
          content: [{ type: 'file', path: filePath }, { type: 'text', text: 'summarize it' }],
        });
        await done;
        const bodies = seenRequests.slice(before).map((request) => request.body).join('\n');
        // 请求体是 JSON 文本；Windows 路径的反斜杠会按 JSON 规则转义。
        expect(bodies).toContain(jsonStringContent(filePath));
        expect(bodies).toContain(jsonStringContent(referenceDir));
        expect(agent.capabilities.multimodal.file.supported).toBe(true);
        expect(agent.capabilities.extraDirs.supported).toBe(true);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
        rmSync(referenceDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'setPlanMode toggles plan mode via the bundled plan-mode extension (/plan, no gateway)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-plan-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'plan-mode-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 初始关闭。
        expect(handle.getPlanMode?.()).toBe(false);

        const seenBefore = seenRequests.length;
        // 开启:/plan 是扩展命令,即时执行,不调模型 → 无网关请求。
        await handle.setPlanMode?.(true);
        expect(handle.getPlanMode?.()).toBe(true);

        // 幂等:重复开启不再 toggle。
        await handle.setPlanMode?.(true);
        expect(handle.getPlanMode?.()).toBe(true);

        // 关闭恢复。
        await handle.setPlanMode?.(false);
        expect(handle.getPlanMode?.()).toBe(false);

        expect(seenRequests.length).toBe(seenBefore);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    're-syncs plan mode from pi persisted state on resume (no mirror desync)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-plan-resume-cwd-'));
      let handle: AgentSessionHandle | null = null;
      let resumed: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'plan-resume-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 先跑一轮真实 turn 让会话落盘(pi 对纯扩展活动的会话可能不持久化)。
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'seed message so the session persists' });
        await done;

        await handle.setPlanMode?.(true);
        expect(handle.getPlanMode?.()).toBe(true);
        const resumeKey = handle.id; // pi 会话文件路径 = resume 钥匙
        await handle.close();
        handle = null;

        // resume 同一会话:pi 的 plan-mode 扩展自恢复 planModeEnabled=true,新会话的
        // planModeActive 必须从 get_entries 校正回 true(而非默认 false),否则 /plan toggle 会锁死。
        resumed = await agent.startSession({
          sessionId: 'plan-resume-session-2',
          workingDir,
          model: 'pi-test-model',
          resumeSessionId: resumeKey,
        });
        expect(resumed.getPlanMode?.()).toBe(true);
      } finally {
        await handle?.close();
        await resumed?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'BYOM: a native provider model routes directly to its own endpoint, not the gateway proxy',
    { timeout: 60_000 },
    async () => {
      // 独立的「原生端点」假服务器,扮演用户自建的 anthropic 兼容端点。
      const nativeSeen: Array<{ auth: string | undefined; url: string }> = [];
      const nativeServer = createServer((req, res) => {
        req.on('data', () => {}); // 排空请求体(不需要正文,只看 header/路由)
        req.on('end', () => {
          nativeSeen.push({
            auth: (req.headers['x-api-key'] as string | undefined) ?? (req.headers.authorization as string | undefined),
            url: req.url ?? '',
          });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end(anthropicStreamBody('pong from NATIVE endpoint'));
        });
      });
      await new Promise<void>((r) => nativeServer.listen(0, '127.0.0.1', r));
      const nativeAddr = nativeServer.address();
      const nativeUrl = typeof nativeAddr === 'object' && nativeAddr ? `http://127.0.0.1:${nativeAddr.port}` : '';

      const deps = buildDeps();
      const authProviderIds: Array<string | null | undefined> = [];
      deps.auth.getState = async (options) => {
        authProviderIds.push(options?.providerId);
        return options?.providerId === 'localbyom'
          ? { authenticated: true, identity: 'Local BYOM', authSource: 'api-key' as const }
          : { authenticated: false };
      };
      deps.auth.getAuthEnv = async () => ({ CINDY_PI_API_KEY: 'gateway-unavailable-placeholder' });
      deps.resolvePiNativeProviders = async () => ({
        providers: [
          {
            id: 'localbyom',
            name: 'Local BYOM',
            baseUrl: nativeUrl,
            api: 'anthropic-messages',
            apiKeyEnvVar: 'CINDY_PI_KEY_LOCALBYOM',
            models: [{ id: 'byom-model', name: 'BYOM Model' }],
          },
        ],
        env: { CINDY_PI_KEY_LOCALBYOM: 'byom-secret-key' },
      });
      const agent = new PiAgent(deps);
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-byom-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        const gatewayBefore = seenRequests.length;
        handle = await agent.startSession({
          sessionId: 'byom-session',
          workingDir,
          model: 'byom-model', // 属于原生 provider,不是网关模型
        });
        // models.json 里有独立的 localbyom provider 块,baseUrl 直连原生端点。
        // 现落在每会话隔离的 configHome(agentHome/run-tmp/<hex>),不在共享 agentHome 根。
        // 整组测试共享 agentHome，前序用例可能留下已清空的 run-tmp 子目录；只认仍持有
        // models.json 的活动会话目录，并要求当前恰好一个，避免目录枚举顺序造成误判。
        const runTmp = path.join(agentHome, 'run-tmp');
        const activeConfigHomes = readdirSync(runTmp, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(runTmp, entry.name))
          .filter((candidate) => existsSync(path.join(candidate, 'models.json')));
        expect(activeConfigHomes).toHaveLength(1);
        const configHome = activeConfigHomes[0];
        if (!configHome) throw new Error('active Pi config home missing');
        const config = JSON.parse(readFileSync(path.join(configHome, 'models.json'), 'utf8')) as {
          providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: Array<{ id: string }> }>;
        };
        expect(config.providers.localbyom).toBeDefined();
        expect(config.providers.localbyom.baseUrl).toBe(nativeUrl);
        expect(config.providers.localbyom.api).toBe('anthropic-messages');
        expect(config.providers.localbyom.apiKey).toBe('$CINDY_PI_KEY_LOCALBYOM');
        expect(config.providers.localbyom.models.some((m) => m.id === 'byom-model')).toBe(true);
        // 网关 provider cindy 仍在(网关模型不受影响)。
        expect(config.providers.cindy).toBeDefined();
        expect(authProviderIds).toContain('localbyom');

        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'hi byom' });
        await done;

        // 关键:请求打到了原生端点(直连),带原生 key;网关一个请求都没多。
        expect(nativeSeen.length).toBeGreaterThan(0);
        expect(nativeSeen.some((r) => (r.auth ?? '').includes('byom-secret-key'))).toBe(true);
        expect(seenRequests.length).toBe(gatewayBefore);
      } finally {
        await handle?.close();
        await new Promise<void>((r) => nativeServer.close(() => r()));
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'BYOM Responses: an explicit Pi effort reaches the upstream reasoning.effort request field',
    { timeout: 60_000 },
    async () => {
      const nativeSeen: Array<{
        url: string;
        auth: string | undefined;
        body: string;
      }> = [];
      const nativeServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          nativeSeen.push({
            url: req.url ?? '',
            auth: req.headers.authorization as string | undefined,
            body,
          });
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          });
          res.end(responsesStreamBody('pong from Responses', 'byom-reasoner'));
        });
      });
      await new Promise<void>((resolve) => nativeServer.listen(0, '127.0.0.1', resolve));
      const nativeAddr = nativeServer.address();
      const nativeUrl =
        typeof nativeAddr === 'object' && nativeAddr ? `http://127.0.0.1:${nativeAddr.port}` : '';

      const deps = buildDeps();
      deps.auth.getState = async (options) =>
        options?.providerId === 'localresponses'
          ? {
              authenticated: true,
              identity: 'Local Responses',
              authSource: 'api-key' as const,
            }
          : { authenticated: false };
      deps.auth.getAuthEnv = async () => ({
        CINDY_PI_API_KEY: 'gateway-unavailable-placeholder',
      });
      deps.resolvePiNativeProviders = async () => ({
        providers: [
          {
            id: 'localresponses',
            name: 'Local Responses',
            baseUrl: nativeUrl,
            api: 'openai-responses',
            apiKeyEnvVar: 'CINDY_PI_KEY_LOCALRESPONSES',
            models: [
              {
                id: 'byom-reasoner',
                name: 'BYOM Reasoner',
                reasoning: true,
                thinkingLevelMap: {
                  minimal: null,
                  low: 'low',
                  medium: null,
                  high: 'high',
                  xhigh: 'xhigh',
                  max: null,
                },
              },
            ],
          },
        ],
        env: { CINDY_PI_KEY_LOCALRESPONSES: 'responses-secret-key' },
      });
      const agent = new PiAgent(deps);
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-byom-responses-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        const gatewayBefore = seenRequests.length;
        handle = await agent.startSession({
          sessionId: 'byom-responses-session',
          workingDir,
          providerId: 'localresponses',
          model: 'byom-reasoner',
          effort: 'xhigh',
        });
        const done = (async () => {
          for await (const event of handle!.events()) {
            if (event.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'reason carefully' });
        await done;

        expect(nativeSeen).toHaveLength(1);
        expect(nativeSeen[0]?.url).toMatch(/\/responses(?:\?|$)/);
        expect(nativeSeen[0]?.auth).toContain('responses-secret-key');
        expect(JSON.parse(nativeSeen[0]?.body ?? '{}')).toMatchObject({
          model: 'byom-reasoner',
          reasoning: { effort: 'xhigh' },
        });
        expect(seenRequests.length).toBe(gatewayBefore);
      } finally {
        await handle?.close();
        await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'exportSessionHtml writes a real HTML file via pi export_html (offline, no gateway)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-export-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'export-html-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 先跑一轮让会话有内容可导出。
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'seed content for html export' });
        await done;

        expect(agent.capabilities.sessionHtmlExport?.supported).toBe(true);
        const outPath = path.join(workingDir, 'session-export.html');
        const seenBefore = seenRequests.length;
        const written = await handle.exportSessionHtml?.(outPath);
        expect(written).toBe(outPath);
        expect(existsSync(outPath)).toBe(true);
        const { readFileSync } = await import('node:fs');
        const html = readFileSync(outPath, 'utf8');
        expect(html.toLowerCase()).toContain('<html');
        // 导出是纯本地渲染,不打网关。
        expect(seenRequests.length).toBe(seenBefore);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'compactSession returns a benign noop for a too-small session (not an error)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-compact-noop-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'manual-compact-noop-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 跑一小轮:上下文远低于压缩门槛,pi 会拒绝「nothing to compact (too small)」。
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'tiny' });
        await done;

        expect(agent.capabilities.manualCompact?.supported).toBe(true);
        // 关键契约:小会话压缩是良性 noop,不抛错(否则 UI 会误报「压缩失败」)。
        const result = await handle.compactSession?.();
        expect(result?.noop).toBe(true);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  // ── auto 档权限端到端:真 pi + 真 cindy-bridge + 假模型发真工具调用 ────────────

  /** 起会话 + 计数 resolver + 跑一轮到 done,返回观测结果。 */
  async function runPermissionTurn(opts: {
    sessionId: string;
    workingDir: string;
    permissionMode: 'ask' | 'auto' | 'bypassPermissions';
    resolverBehavior: 'allow' | 'deny';
    deps?: AgentDeps;
    reviewMode?: boolean;
    reviewReadPaths?: string[];
  }): Promise<{ resolverTools: string[]; finalText: string }> {
    const agent = new PiAgent(opts.deps ?? buildDeps());
    const resolverTools: string[] = [];
    let handle: AgentSessionHandle | null = null;
    try {
      handle = await agent.startSession({
        sessionId: opts.sessionId,
        workingDir: opts.workingDir,
        model: 'pi-test-model',
        permissionMode: opts.permissionMode,
        ...(opts.reviewMode ? { reviewMode: true } : {}),
        ...(opts.reviewReadPaths ? { reviewReadPaths: opts.reviewReadPaths } : {}),
      });
      handle.setInteractionResolver?.(async (req) => {
        resolverTools.push((req as { toolName?: string }).toolName ?? '?');
        return { kind: 'permission', requestId: (req as { requestId: string }).requestId, behavior: opts.resolverBehavior } as never;
      });
      const events: AgentEvent[] = [];
      const done = (async () => {
        for await (const ev of handle!.events()) {
          events.push(ev);
          if (ev.type === 'done') break;
        }
      })();
      await handle.send({ type: 'user', content: 'go' });
      await done;
      const finalText = events
        .filter((e) => e.type === 'text')
        .map((e) => e.data as { text: string; isFinal?: boolean })
        .filter((d) => d.isFinal)
        .map((d) => d.text)
        .join('');
      return { resolverTools, finalText };
    } finally {
      await handle?.close();
    }
  }

  it(
    'offline grep uses the host-managed ripgrep instead of falling back to bash',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-managed-grep-'));
      writeFileSync(path.join(workingDir, 'tool-target.ts'), 'needle-line\n');
      const rogueRg = path.join(workingDir, process.platform === 'win32' ? 'rg.exe' : 'rg');
      writeFileSync(rogueRg, process.platform === 'win32' ? 'not-an-executable' : '#!/bin/sh\nexit 42\n');
      if (process.platform !== 'win32') chmodSync(rogueRg, 0o755);
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'needle-line', path: '.', literal: true }),
          anthropicStreamBody('grep turn finished'),
        );
        const reqBefore = seenRequests.length;
        await runPermissionTurn({
          sessionId: 'pi-managed-grep',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'deny',
        });
        const followUp = seenRequests.slice(reqBefore).map((request) => request.body);
        expect(followUp.some((body) => body.includes('tool-target.ts:1: needle-line'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'full access grep treats dotenv text as data rather than a credential path',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-grep-dotenv-data-'));
      writeFileSync(path.join(workingDir, 'source.txt'), 'literal .env data\n');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: '.env', path: '.', literal: true }),
          anthropicStreamBody('grep dotenv data turn finished'),
        );
        const reqBefore = seenRequests.length;
        await runPermissionTurn({
          sessionId: 'pi-grep-dotenv-data',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'deny',
        });
        const followUp = seenRequests.slice(reqBefore).map((request) => request.body).join('\n');
        expect(followUp).toContain('source.txt:1: literal .env data');
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'auto mode escalates selector-only dotenv grep evidence',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-grep-dotenv-selector-'));
      mkdirSync(path.join(workingDir, 'src'));
      mkdirSync(path.join(workingDir, '.ssh'));
      mkdirSync(path.join(workingDir, '.config', 'gh-work'), { recursive: true });
      writeFileSync(path.join(workingDir, 'src', '.env.local'), 'SELECTOR_SECRET=must-not-leak\n');
      writeFileSync(path.join(workingDir, 'src', '.netrc'), 'NETRC_SECRET=must-not-leak\n');
      writeFileSync(path.join(workingDir, 'src', 'a.key'), 'KEY_SECRET=must-not-leak\n');
      writeFileSync(path.join(workingDir, 'src', 'source.ts'), 'SAFE_SELECTOR=visible\n');
      writeFileSync(path.join(workingDir, '.ssh', 'config'), 'SSH_CONFIG_SECRET=must-not-leak\n');
      writeFileSync(
        path.join(workingDir, '.config', 'gh-work', 'token.txt'),
        'CONFIG_SECRET=must-not-leak\n',
      );
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'SELECTOR_SECRET', path: 'src', glob: '.env*' }),
          anthropicStreamBody('grep selector credential turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'pi-grep-dotenv-selector',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(resolverTools).toEqual(['grep']);
        const followUp = seenRequests.slice(reqBefore).map((request) => request.body).join('\n');
        expect(followUp).not.toContain('SELECTOR_SECRET=must-not-leak');
        expect(followUp).toContain('User denied this tool call via Cindy.');

        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'NETRC_SECRET', path: 'src', glob: '.n?trc' }),
          anthropicStreamBody('grep netrc selector credential turn finished'),
        );
        const netrcReqBefore = seenRequests.length;
        const netrcTurn = await runPermissionTurn({
          sessionId: 'pi-grep-netrc-selector',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(netrcTurn.resolverTools).toEqual(['grep']);
        const netrcFollowUp = seenRequests.slice(netrcReqBefore).map((request) => request.body).join('\n');
        expect(netrcFollowUp).not.toContain('NETRC_SECRET=must-not-leak');
        expect(netrcFollowUp).toContain('User denied this tool call via Cindy.');

        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'SSH_CONFIG_SECRET', path: '.', glob: '.s?h/config' }),
          anthropicStreamBody('grep ssh directory selector credential turn finished'),
        );
        const sshReqBefore = seenRequests.length;
        const sshTurn = await runPermissionTurn({
          sessionId: 'pi-grep-ssh-directory-selector',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(sshTurn.resolverTools).toEqual(['grep']);
        const sshFollowUp = seenRequests.slice(sshReqBefore).map((request) => request.body).join('\n');
        expect(sshFollowUp).not.toContain('SSH_CONFIG_SECRET=must-not-leak');
        expect(sshFollowUp).toContain('User denied this tool call via Cindy.');

        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'CONFIG_SECRET', path: '.', glob: '.config/g?-*/**' }),
          anthropicStreamBody('grep config directory selector credential turn finished'),
        );
        const configReqBefore = seenRequests.length;
        const configTurn = await runPermissionTurn({
          sessionId: 'pi-grep-config-directory-selector',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(configTurn.resolverTools).toEqual(['grep']);
        const configFollowUp = seenRequests.slice(configReqBefore).map((request) => request.body).join('\n');
        expect(configFollowUp).not.toContain('CONFIG_SECRET=must-not-leak');
        expect(configFollowUp).toContain('User denied this tool call via Cindy.');

        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'KEY_SECRET', path: 'src', glob: '?.key' }),
          anthropicStreamBody('grep key selector credential turn finished'),
        );
        const keyReqBefore = seenRequests.length;
        const keyTurn = await runPermissionTurn({
          sessionId: 'pi-grep-key-selector-full-access',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'deny',
        });
        expect(keyTurn.resolverTools).toEqual([]);
        const keyFollowUp = seenRequests.slice(keyReqBefore).map((request) => request.body).join('\n');
        expect(keyFollowUp).not.toContain('KEY_SECRET=must-not-leak');
        expect(keyFollowUp).toContain('Cindy blocks reading credential or key paths');

        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'SAFE_SELECTOR', path: 'src', glob: 'source.ts' }),
          anthropicStreamBody('grep ordinary selector turn finished'),
        );
        const safeReqBefore = seenRequests.length;
        const safeTurn = await runPermissionTurn({
          sessionId: 'pi-grep-ordinary-selector',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(safeTurn.resolverTools).toEqual([]);
        const safeFollowUp = seenRequests.slice(safeReqBefore).map((request) => request.body).join('\n');
        expect(safeFollowUp).toContain('source.ts:1: SAFE_SELECTOR=visible');
        expect(safeFollowUp).not.toContain('SELECTOR_SECRET=must-not-leak');
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'Review directory grep returns safe matches without credential-file contents',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-review-safe-grep-'));
      writeFileSync(path.join(workingDir, 'source.ts'), 'needle-safe\n');
      writeFileSync(path.join(workingDir, 'credentials.json'), 'needle-credentials-secret\n');
      writeFileSync(path.join(workingDir, 'cert.pem'), 'needle-private-key-secret\n');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('grep', { pattern: 'needle', path: '.', literal: true }),
          anthropicStreamBody('review grep finished'),
        );
        const reqBefore = seenRequests.length;
        await runPermissionTurn({
          sessionId: 'pi-review-safe-grep',
          workingDir,
          permissionMode: 'ask',
          resolverBehavior: 'deny',
          reviewMode: true,
        });
        const followUp = seenRequests.slice(reqBefore).map((request) => request.body).join('\n');
        expect(followUp).toContain('source.ts:1: needle-safe');
        expect(followUp).not.toContain('credentials.json');
        expect(followUp).not.toContain('needle-credentials-secret');
        expect(followUp).not.toContain('cert.pem');
        expect(followUp).not.toContain('needle-private-key-secret');
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'offline find uses the Cindy ripgrep override without fd',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-managed-find-'));
      writeFileSync(path.join(workingDir, 'find-me.ts'), 'export {};\n');
      writeFileSync(path.join(workingDir, 'skip-me.txt'), 'skip\n');
      mkdirSync(path.join(workingDir, 'nested'));
      writeFileSync(path.join(workingDir, 'nested', 'find-nested.ts'), 'export {};\n');
      mkdirSync(path.join(workingDir, 'packages', 'foo', 'src'), { recursive: true });
      writeFileSync(
        path.join(workingDir, 'packages', 'foo', 'src', 'find-path.spec.ts'),
        'export {};\n',
      );
      writeFileSync(path.join(workingDir, '.gitignore'), 'ignored-by-git.ts\n');
      writeFileSync(path.join(workingDir, 'ignored-by-git.ts'), 'secret\n');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('find', { pattern: '*.ts', path: '.' }),
          anthropicStreamBody('find turn finished'),
        );
        const reqBefore = seenRequests.length;
        await runPermissionTurn({
          sessionId: 'pi-managed-find',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'deny',
        });
        const followUp = seenRequests.slice(reqBefore).map((request) => request.body);
        expect(followUp.some((body) => body.includes('find-me.ts'))).toBe(true);
        expect(followUp.some((body) => body.includes('find-nested.ts'))).toBe(true);
        expect(followUp.some((body) => body.includes('skip-me.txt'))).toBe(false);
        expect(followUp.some((body) => body.includes('ignored-by-git.ts'))).toBe(false);

        scriptedResponses.push(
          anthropicToolUseBody('find', { pattern: 'src/**/*.spec.ts', path: '.' }),
          anthropicStreamBody('path find turn finished'),
        );
        const pathReqBefore = seenRequests.length;
        await runPermissionTurn({
          sessionId: 'pi-managed-find-full-path',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'deny',
        });
        const pathFollowUp = seenRequests.slice(pathReqBefore).map((request) => request.body);
        expect(pathFollowUp.some((body) => body.includes('find-path.spec.ts'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'auto mode: safe bash executes end-to-end without prompting (real bridge intercept)',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-safe-'));
      writeFileSync(path.join(workingDir, 'marker-safe-ls.txt'), 'seed');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'ls' }),
          anthropicStreamBody('safe turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools, finalText } = await runPermissionTurn({
          sessionId: 'perm-auto-safe',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny', // 若误弹窗会被 deny,下面的 tool_result 断言就会失败 → 弹窗即测试红
        });
        // 没有任何审批弹窗
        expect(resolverTools).toEqual([]);
        // 工具真的执行了:第二个请求的 tool_result 里带回了 ls 输出(含 seed 文件名)
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('marker-safe-ls.txt'))).toBe(true);
        expect(finalText).toContain('safe turn finished');
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'explicit bash timeout returns Pi native timeout error and continues the turn',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-bash-timeout-'));
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', {
            command: 'node -e "setTimeout(() => {}, 10000)"',
            timeout: 1,
          }),
          anthropicStreamBody('timeout turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools, finalText } = await runPermissionTurn({
          sessionId: 'perm-bash-timeout',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'deny',
        });
        expect(resolverTools).toEqual([]);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((body) => body.includes('Command timed out after 1 seconds'))).toBe(
          true,
        );
        expect(finalText).toContain('timeout turn finished');
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'bash child cannot inherit Pi proxy, MCP, BYOM, or permission-control env',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-env-isolation-'));
      try {
        const deps = buildDeps();
        deps.preparePiExtraSpawnConfig = async () => ({
          mcpBridge: { token: '', servers: [] },
          mcpEnv: { CINDY_PI_REMOTE_MCP_SECRET_0: 'remote-mcp-secret-canary' },
        });
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', {
            command: [
              'for n in CINDY_PI_API_KEY CINDY_PI_SESSION_ID CINDY_PI_SESSION_TOKEN',
              'CINDY_PI_MCP_BRIDGE CINDY_PI_KEY_LOCALBYOM CINDY_PI_REMOTE_MCP_SECRET_0',
              'CINDY_PI_SECRET_ENV_NAMES CINDY_PI_MANAGED_RG_PATH CINDY_PI_BASH_PACKAGE_HOME',
              'CINDY_PI_PERMISSION_FILE PI_PACKAGE_DIR PI_SESSION_ID PI_SESSION_FILE; do',
              '  if [ -n "$(printenv "$n")" ]; then printf "PI_ENV_LEAK:%s\\n" "$n"; fi;',
              'done; printf "PI_BASH_HOME:%s\\nPI_ENV_CLEAN\\n" "$PI_CODING_AGENT_DIR"',
            ].join(' '),
          }),
          anthropicStreamBody('env isolation finished'),
        );
        const reqBefore = seenRequests.length;
        await runPermissionTurn({
          sessionId: 'pi-env-isolation',
          workingDir,
          permissionMode: 'ask',
          resolverBehavior: 'allow',
          deps,
        });
        const lastBody = JSON.parse(seenRequests.slice(reqBefore).at(-1)?.body ?? '{}') as {
          messages?: Array<{ role?: string; content?: Array<{ type?: string; content?: string }> }>;
        };
        const toolResult = lastBody.messages
          ?.flatMap((message) => message.content ?? [])
          .find((block) => block.type === 'tool_result')?.content ?? '';
        expect(toolResult).toContain('PI_ENV_CLEAN');
        expect(toolResult).toMatch(/PI_BASH_HOME:.*[/\\]bash-package-home/);
        expect(toolResult).not.toContain('PI_ENV_LEAK:');
        expect(toolResult).not.toContain('test-key-123');
        expect(toolResult).not.toContain('remote-mcp-secret-canary');
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'auto mode: dangerous bash escalates to the resolver and deny really blocks it',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-danger-'));
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'sudo rm -rf /tmp/definitely-not-run' }),
          anthropicStreamBody('danger turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-auto-danger',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        // 升级到了审批,且只问了一次
        expect(resolverTools).toEqual(['bash']);
        // deny 真的拦下了:回给模型的 tool_result 带 bridge 的拒绝理由
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('User denied this tool call via Cindy.'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'auto mode: an automatic review block is not reported as a user rejection',
    { timeout: 60_000 },
    async () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), 'pi-auto-review-denial-copy-'));
      const workingDir = path.join(tempRoot, 'workspace');
      mkdirSync(workingDir);
      const marker = path.join(tempRoot, 'must-not-exist.txt');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('write', { path: marker, content: 'must not land' }),
          anthropicStreamBody('automatic denial observed'),
        );
        const deps = buildDeps();
        deps.reviewAutoPermissionAction = async () => ({ verdict: 'block' });
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'pi-auto-review-source-copy',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
          deps,
        });

        expect(resolverTools).toEqual([]);
        expect(existsSync(marker)).toBe(false);
        const followUp = seenRequests.slice(reqBefore).map((request) => request.body);
        expect(followUp.some((body) => body.includes('Cindy Auto-review denied this tool call.')))
          .toBe(true);
        expect(followUp.some((body) => body.includes('User denied this tool call via Cindy.')))
          .toBe(false);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'credential read escalates through the real bridge even though read is a readonly builtin',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-cred-'));
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('read', { path: '/Users/nobody/.ssh/id_rsa' }),
          anthropicStreamBody('cred turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-auto-cred',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        // 只读工具不再无条件直通:凭证路径升级弹窗,deny 真拦截
        expect(resolverTools).toEqual(['read']);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('User denied this tool call via Cindy.'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'dotenv reads escalate instead of using the readonly fast path',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-dotenv-'));
      const dotenvPath = path.join(workingDir, '.env.local');
      try {
        writeFileSync(dotenvPath, 'FAKE_DOTENV_SECRET=must-not-leak');
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('read', { path: dotenvPath }),
          anthropicStreamBody('dotenv turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-auto-dotenv',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(resolverTools).toEqual(['read']);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('FAKE_DOTENV_SECRET'))).toBe(false);
        expect(followUp.some((b) => b.includes('User denied this tool call via Cindy.'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'full access still blocks credential reads (parent env holds the proxy session token)',
    { timeout: 60_000 },
    async () => {
      // greptile 回归:bypassPermissions 提前返回不得跳过凭证路径检查,否则内置 read
      // 可读 /proc/self/environ 之类路径拿到父进程里的代理 token,绕过审批盗刷额度。
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-bypass-cred-'));
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('read', { path: '/proc/self/environ' }),
          anthropicStreamBody('bypass cred turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-bypass-cred',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'allow', // 若误弹窗且被 allow,下面的 block 理由断言就会失败
        });
        // Full access 不弹窗,直接硬拦
        expect(resolverTools).toEqual([]);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('Cindy blocks reading credential or key paths'))).toBe(true);
        expect(followUp.some((b) => b.includes('CINDY_PI_SESSION_TOKEN='))).toBe(false);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'full access blocks bash reads of process environ (parent /proc holds the secrets)',
    { timeout: 60_000 },
    async () => {
      // codex 回归:spawn 边界只剥子进程 env,父 pi 进程仍持有 token;bash
      // `cat /proc/self/environ` 同 UID 直取 → 即使 Full access 也硬拦。
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-bash-environ-'));
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'cat /proc/self/environ' }),
          anthropicStreamBody('bash environ turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-bash-environ',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'allow',
        });
        expect(resolverTools).toEqual([]);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('Cindy blocks reading process environment'))).toBe(true);
        expect(followUp.some((b) => b.includes('CINDY_PI_SESSION_TOKEN='))).toBe(false);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it.skipIf(!canSymlink)(
    'auto mode escalates credential reads reached through a workspace symlink',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-auto-symlink-cred-'));
      try {
        const secretPath = path.join(workingDir, 'secrets', 'id_rsa');
        const linkPath = path.join(workingDir, 'innocent.txt');
        mkdirSync(path.dirname(secretPath), { recursive: true });
        writeFileSync(secretPath, 'FAKE SYMLINK PRIVATE KEY');
        symlinkSync(secretPath, linkPath);

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('read', { path: linkPath }),
          anthropicStreamBody('auto symlink cred turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-auto-symlink-cred',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(resolverTools).toEqual(['read']);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('FAKE SYMLINK PRIVATE KEY'))).toBe(false);
        expect(followUp.some((b) => b.includes('User denied this tool call via Cindy.'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it.skipIf(!canSymlink)(
    'auto mode escalates bash input redirects reached through a dotenv symlink',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-auto-bash-symlink-dotenv-'));
      try {
        const secretPath = path.join(workingDir, 'secrets', '.env');
        const ordinaryPath = path.join(workingDir, 'ordinary.txt');
        const subDir = path.join(workingDir, 'sub');
        const stackOtherDir = path.join(workingDir, 'stack-other');
        const postCdLink = path.join(subDir, 'link');
        const escapedLinkName = 'innocent\\q';
        const cdRedirectLinkName = 'cd-innocent';
        mkdirSync(path.dirname(secretPath), { recursive: true });
        mkdirSync(subDir);
        mkdirSync(stackOtherDir);
        writeFileSync(secretPath, 'FAKE_REDIRECT_DOTENV_SECRET=must-not-leak');
        writeFileSync(ordinaryPath, 'ordinary-content');
        writeFileSync(path.join(workingDir, 'change-dir.sh'), 'cd sub\n');
        symlinkSync('../secrets/.env', postCdLink);
        symlinkSync(ordinaryPath, path.join(workingDir, 'link'));
        symlinkSync(ordinaryPath, path.join(stackOtherDir, 'link'));
        symlinkSync(secretPath, path.join(workingDir, escapedLinkName));
        symlinkSync(secretPath, path.join(workingDir, cdRedirectLinkName));
        symlinkSync(ordinaryPath, path.join(subDir, cdRedirectLinkName));
        symlinkSync(ordinaryPath, path.join(subDir, 'ordinary'));

        for (const [sessionId, command] of [
          ['perm-auto-bash-symlink-dotenv-pushd-rotation', 'pushd sub >/dev/null; pushd ../stack-other >/dev/null; pushd +1 >/dev/null; cat<link'],
          ['perm-auto-bash-symlink-dotenv-popd', 'pushd sub; pushd ../stack-other; popd; cat<link'],
          ['perm-auto-bash-symlink-dotenv-popd-index', 'pushd sub && pushd ../stack-other && popd +0 && cat<link'],
          ['perm-auto-bash-symlink-dotenv-builtin-terminator', 'builtin -- cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-source', 'source change-dir.sh; cat<link'],
          ['perm-auto-bash-symlink-dotenv-dot-source', '. ./change-dir.sh && cat<link'],
          ['perm-auto-bash-symlink-dotenv-builtin-source', 'builtin source change-dir.sh; cat<link'],
          ['perm-auto-bash-symlink-dotenv-eval-source', "eval 'source change-dir.sh'; cat<link"],
          ['perm-auto-bash-symlink-dotenv-dynamic-cd', 'D=cd; $D sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-interpolated-cd', 'UNSET=; c${UNSET}d sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-interpolated-builtin', 'UNSET=; bu${UNSET}iltin -- cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-conditional-cd', 'true || cd sub && cat<cd-innocent'],
          ['perm-auto-bash-symlink-dotenv-pushd-index', 'pushd sub && pushd ../stack-other && pushd +1 && cat<link'],
          ['perm-auto-bash-symlink-dotenv-assignment-cd', 'X=1 cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-assignment-leading-redirect', 'X=1 2>/dev/null builtin cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-leading-assignment-wrapper', '2>/dev/null X=1 command -- cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-post-cd', 'cd sub >/dev/null && cat<link'],
          ['perm-auto-bash-symlink-dotenv-leading-redirect', '2>/dev/null cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-builtin-cd', 'builtin cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-leading-builtin', '2>/dev/null builtin cd sub && cat<link'],
          ['perm-auto-bash-symlink-dotenv-builtin-pushd', 'builtin pushd sub >/dev/null && cat<link'],
          ['perm-auto-bash-symlink-dotenv-backslash', `cat <"${escapedLinkName}"`],
          ['perm-auto-bash-symlink-dotenv-cd-redirect', `cd sub <>${cdRedirectLinkName} && cat <ordinary`],
        ] as const) {
          scriptedResponses.length = 0;
          scriptedResponses.push(
            anthropicToolUseBody('bash', { command }),
            anthropicStreamBody('bash symlink dotenv turn finished'),
          );
          const reqBefore = seenRequests.length;
          const { resolverTools } = await runPermissionTurn({
            sessionId,
            workingDir,
            permissionMode: 'auto',
            resolverBehavior: 'deny',
          });
          const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
          expect(resolverTools, `${command}\n${followUp.join('\n')}`).toEqual(['bash']);
          expect(followUp.some((b) => b.includes('FAKE_REDIRECT_DOTENV_SECRET')), command).toBe(false);
          expect(followUp.some((b) => b.includes('User denied this tool call via Cindy.')), command).toBe(true);
        }

        for (const [sessionId, command] of [
          ['perm-full-access-bash-popd-plain', 'pushd sub && popd && cat<link'],
          ['perm-full-access-bash-builtin-terminator-plain', 'builtin -- cd sub && cat<ordinary'],
          ['perm-full-access-bash-subshell-source-plain', '(source change-dir.sh); cat<link'],
          ['perm-full-access-bash-external-source-plain', 'bash change-dir.sh; cat<link'],
          ['perm-full-access-bash-popd-index-plain', 'pushd sub && pushd ../stack-other && popd +1 && cat<link'],
          ['perm-full-access-bash-pushd-zero-plain', 'pushd +0 && cat<link'],
          ['perm-full-access-bash-popd-no-cd-plain', 'pushd sub && pushd ../stack-other && popd -n +1 && cat<link'],
          ['perm-full-access-bash-pushd-no-cd-plain', 'pushd sub && pushd ../stack-other && pushd -n +1 && cat<link'],
          ['perm-full-access-bash-conditional-cd-plain', 'false || cd sub && cat<ordinary'],
        ] as const) {
          scriptedResponses.length = 0;
          scriptedResponses.push(
            anthropicToolUseBody('bash', { command }),
            anthropicStreamBody('bash ordinary cwd turn finished'),
          );
          const ordinaryReqBefore = seenRequests.length;
          const ordinaryTurn = await runPermissionTurn({
            sessionId,
            workingDir,
            permissionMode: 'bypassPermissions',
            resolverBehavior: 'allow',
          });
          expect(ordinaryTurn.resolverTools, command).toEqual([]);
          const ordinaryFollowUp = seenRequests.slice(ordinaryReqBefore)
            .map((request) => request.body);
          expect(ordinaryFollowUp.some((body) => body.includes('ordinary-content')), command).toBe(true);
          expect(ordinaryFollowUp.some((body) => body.includes('FAKE_REDIRECT_DOTENV_SECRET')), command)
            .toBe(false);
        }

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'X=1 2>/dev/null builtin cd sub && cat<link' }),
          anthropicStreamBody('bash Full Access prefixed cd turn finished'),
        );
        const fullAccessReqBefore = seenRequests.length;
        const fullAccessTurn = await runPermissionTurn({
          sessionId: 'perm-full-access-bash-prefixed-builtin-cd',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'allow',
        });
        expect(fullAccessTurn.resolverTools).toEqual([]);
        const fullAccessFollowUp = seenRequests.slice(fullAccessReqBefore).map((request) => request.body);
        expect(fullAccessFollowUp.some((body) => body.includes('FAKE_REDIRECT_DOTENV_SECRET'))).toBe(false);
        expect(fullAccessFollowUp.some((body) => body.includes('Cindy blocks reading credential or key paths')))
          .toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'redirect globs fail closed on inherited or runtime Bash options while ordinary globs stay fast',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-auto-bash-glob-options-'));
      const previousBashOptions = process.env.BASHOPTS;
      try {
        writeFileSync(path.join(workingDir, '.env'), 'FAKE_DOTGLOB_SECRET=must-not-leak');
        writeFileSync(path.join(workingDir, 'ordinary.txt'), 'ordinary-glob-content');
        process.env.BASHOPTS = 'dotglob';

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'cat <*' }),
          anthropicStreamBody('bash dotglob turn finished'),
        );
        const autoReqBefore = seenRequests.length;
        const autoTurn = await runPermissionTurn({
          sessionId: 'perm-auto-bash-dotglob',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(autoTurn.resolverTools).toEqual(['bash']);
        const autoFollowUp = seenRequests.slice(autoReqBefore).map((request) => request.body);
        expect(autoFollowUp.some((body) => body.includes('FAKE_DOTGLOB_SECRET'))).toBe(false);
        expect(autoFollowUp.some((body) => body.includes('User denied this tool call via Cindy.'))).toBe(true);

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'cat <*' }),
          anthropicStreamBody('bash Full Access dotglob turn finished'),
        );
        const fullAccessReqBefore = seenRequests.length;
        const fullAccessTurn = await runPermissionTurn({
          sessionId: 'perm-full-access-bash-dotglob',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'allow',
        });
        expect(fullAccessTurn.resolverTools).toEqual([]);
        const fullAccessFollowUp = seenRequests.slice(fullAccessReqBefore).map((request) => request.body);
        expect(fullAccessFollowUp.some((body) => body.includes('FAKE_DOTGLOB_SECRET'))).toBe(false);
        expect(fullAccessFollowUp.some((body) => body.includes('Cindy blocks reading credential or key paths')))
          .toBe(true);

        delete process.env.BASHOPTS;
        for (const [sessionId, command] of [
          ['perm-auto-bash-runtime-dotglob', 'shopt -s dotglob; cat <*>'],
          ['perm-auto-bash-runtime-globignore', 'GLOBIGNORE=ordinary.txt; cat <*>'],
        ] as const) {
          scriptedResponses.length = 0;
          scriptedResponses.push(
            anthropicToolUseBody('bash', { command }),
            anthropicStreamBody('bash runtime glob state turn finished'),
          );
          const runtimeReqBefore = seenRequests.length;
          const runtimeTurn = await runPermissionTurn({
            sessionId,
            workingDir,
            permissionMode: 'auto',
            resolverBehavior: 'deny',
          });
          expect(runtimeTurn.resolverTools, command).toEqual(['bash']);
          const runtimeFollowUp = seenRequests.slice(runtimeReqBefore).map((request) => request.body);
          expect(runtimeFollowUp.some((body) => body.includes('FAKE_DOTGLOB_SECRET')), command).toBe(false);
          expect(runtimeFollowUp.some((body) => body.includes('User denied this tool call via Cindy.')), command)
            .toBe(true);
        }

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'shopt -s dotglob; cat <*' }),
          anthropicStreamBody('bash Full Access runtime dotglob turn finished'),
        );
        const runtimeFullAccessReqBefore = seenRequests.length;
        const runtimeFullAccessTurn = await runPermissionTurn({
          sessionId: 'perm-full-access-bash-runtime-dotglob',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'allow',
        });
        expect(runtimeFullAccessTurn.resolverTools).toEqual([]);
        const runtimeFullAccessFollowUp = seenRequests.slice(runtimeFullAccessReqBefore)
          .map((request) => request.body);
        expect(runtimeFullAccessFollowUp.some((body) => body.includes('FAKE_DOTGLOB_SECRET'))).toBe(false);
        expect(runtimeFullAccessFollowUp.some((body) =>
          body.includes('Cindy blocks reading credential or key paths'))).toBe(true);

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'cat <ordinary*' }),
          anthropicStreamBody('bash ordinary glob turn finished'),
        );
        const ordinaryReqBefore = seenRequests.length;
        const ordinaryTurn = await runPermissionTurn({
          sessionId: 'perm-auto-bash-ordinary-glob',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(ordinaryTurn.resolverTools).toEqual([]);
        const ordinaryFollowUp = seenRequests.slice(ordinaryReqBefore).map((request) => request.body);
        expect(ordinaryFollowUp.some((body) => body.includes('ordinary-glob-content'))).toBe(true);
        expect(ordinaryFollowUp.some((body) => body.includes('FAKE_DOTGLOB_SECRET'))).toBe(false);
      } finally {
        if (previousBashOptions === undefined) delete process.env.BASHOPTS;
        else process.env.BASHOPTS = previousBashOptions;
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it.skipIf(process.platform === 'win32' || !canSymlink)(
    'auto mode fail closes inherited CDPATH while explicit relative cd keeps ordinary reads fast',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-auto-bash-cdpath-'));
      const cdPathRoot = mkdtempSync(path.join(tmpdir(), 'pi-perm-auto-bash-cdpath-root-'));
      const previousCdPath = process.env.CDPATH;
      try {
        const secretPath = path.join(workingDir, 'secrets', '.env');
        const ordinaryPath = path.join(workingDir, 'ordinary.txt');
        const localSubDir = path.join(workingDir, 'sub');
        const cdPathSubDir = path.join(cdPathRoot, 'sub');
        mkdirSync(path.dirname(secretPath), { recursive: true });
        mkdirSync(localSubDir);
        mkdirSync(cdPathSubDir);
        writeFileSync(secretPath, 'FAKE_CDPATH_DOTENV_SECRET=must-not-leak');
        writeFileSync(ordinaryPath, 'ordinary-cdpath-content');
        symlinkSync(ordinaryPath, path.join(workingDir, 'root-input'));
        symlinkSync(ordinaryPath, path.join(localSubDir, 'link'));
        symlinkSync(secretPath, path.join(cdPathSubDir, 'link'));
        process.env.CDPATH = cdPathRoot;

        for (const [sessionId, command] of [
          ['perm-auto-bash-cdpath-post-cd', 'cd sub && cat<link'],
          ['perm-auto-bash-cdpath-cd-read', 'cd sub <root-input && cat<link'],
          ['perm-auto-bash-cdpath-cd-read-write', 'cd sub <>root-input && cat<link'],
        ] as const) {
          scriptedResponses.length = 0;
          scriptedResponses.push(
            anthropicToolUseBody('bash', { command }),
            anthropicStreamBody('bash CDPATH turn finished'),
          );
          const reqBefore = seenRequests.length;
          const { resolverTools } = await runPermissionTurn({
            sessionId,
            workingDir,
            permissionMode: 'auto',
            resolverBehavior: 'deny',
          });
          const followUp = seenRequests.slice(reqBefore).map((request) => request.body);
          expect(resolverTools, command).toEqual(['bash']);
          expect(followUp.some((body) => body.includes('FAKE_CDPATH_DOTENV_SECRET')), command)
            .toBe(false);
          expect(followUp.some((body) => body.includes('User denied this tool call via Cindy.')), command)
            .toBe(true);
        }

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', { command: 'cd ./sub <root-input && cat<link' }),
          anthropicStreamBody('bash explicit relative cd turn finished'),
        );
        const ordinaryReqBefore = seenRequests.length;
        const ordinaryTurn = await runPermissionTurn({
          sessionId: 'perm-auto-bash-cdpath-explicit-relative',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(ordinaryTurn.resolverTools).toEqual([]);
        const ordinaryFollowUp = seenRequests.slice(ordinaryReqBefore).map((request) => request.body);
        expect(ordinaryFollowUp.some((body) => body.includes('ordinary-cdpath-content'))).toBe(true);
        expect(ordinaryFollowUp.some((body) => body.includes('FAKE_CDPATH_DOTENV_SECRET'))).toBe(false);
      } finally {
        if (previousCdPath === undefined) delete process.env.CDPATH;
        else process.env.CDPATH = previousCdPath;
        rmSync(workingDir, { recursive: true, force: true });
        rmSync(cdPathRoot, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it.skipIf(!canSymlink)(
    'ordinary bash input redirect symlinks keep their existing permission behavior',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-auto-bash-symlink-plain-'));
      try {
        const targetPath = path.join(workingDir, 'ordinary-target.txt');
        const subDir = path.join(workingDir, 'sub');
        const redirectLinkName = 'ordinary-redirect-link';
        const linkPath = path.join(subDir, 'link');
        mkdirSync(subDir);
        writeFileSync(targetPath, 'ordinary-bash-symlink-content');
        symlinkSync(targetPath, path.join(workingDir, redirectLinkName));
        symlinkSync('../ordinary-target.txt', path.join(subDir, redirectLinkName));
        symlinkSync('../ordinary-target.txt', linkPath);

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', {
            command: `X=1 2>/dev/null builtin cd sub <${redirectLinkName} && cat<link`,
          }),
          anthropicStreamBody('bash ordinary symlink turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-full-access-bash-prefixed-symlink-plain',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'deny',
        });
        expect(resolverTools).toEqual([]);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('ordinary-bash-symlink-content'))).toBe(true);

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('bash', {
            command: `2>/dev/null X=1 command -- cd sub <>${redirectLinkName} && cat<link`,
          }),
          anthropicStreamBody('bash ordinary read-write symlink turn finished'),
        );
        const readWriteReqBefore = seenRequests.length;
        const readWriteTurn = await runPermissionTurn({
          sessionId: 'perm-auto-bash-symlink-plain-read-write',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'allow',
        });
        expect(readWriteTurn.resolverTools).toEqual(['bash']);
        const readWriteFollowUp = seenRequests.slice(readWriteReqBefore).map((r) => r.body);
        expect(readWriteFollowUp.some((b) => b.includes('ordinary-bash-symlink-content'))).toBe(true);
        expect(readWriteFollowUp.some((b) => b.includes('Cindy blocks reading credential or key paths')))
          .toBe(false);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it.skipIf(!canSymlink)(
    'full access blocks credential reads reached through a workspace symlink',
    { timeout: 60_000 },
    async () => {
      // greptile 回归:未解析路径命不中特征,但工作区内符号链接可指向敏感目标;
      // realpath 跟随后再判 → 即使 Full access 也硬拦。
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-symlink-cred-'));
      try {
        // 真实敏感文件(路径含 id_rsa,命中凭证特征)+ 工作区内指向它的无害名字符号链接。
        mkdirSync(path.join(workingDir, 'secrets'), { recursive: true });
        const secretPath = path.join(workingDir, 'secrets', 'id_rsa');
        writeFileSync(secretPath, 'FAKE PRIVATE KEY');
        const linkPath = path.join(workingDir, 'innocent.txt');
        symlinkSync(secretPath, linkPath);

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('read', { path: linkPath }),
          anthropicStreamBody('symlink cred turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-symlink-cred',
          workingDir,
          permissionMode: 'bypassPermissions',
          resolverBehavior: 'allow',
        });
        expect(resolverTools).toEqual([]);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('Cindy blocks reading credential or key paths'))).toBe(true);
        expect(followUp.some((b) => b.includes('FAKE PRIVATE KEY'))).toBe(false);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'plain reads still pass the bridge untouched (no popup, tool executes)',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-read-'));
      const seedPath = path.join(workingDir, '.environment');
      writeFileSync(seedPath, 'plain-read-marker-content');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('read', { path: seedPath }),
          anthropicStreamBody('read turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-auto-read',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(resolverTools).toEqual([]);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('plain-read-marker-content'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it.skipIf(!canSymlink)(
    'ordinary symlink reads keep the readonly fast path',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-auto-symlink-plain-'));
      try {
        const targetPath = path.join(workingDir, 'ordinary-target.txt');
        const linkPath = path.join(workingDir, 'ordinary-link.txt');
        writeFileSync(targetPath, 'ordinary-symlink-content');
        symlinkSync(targetPath, linkPath);

        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('read', { path: linkPath }),
          anthropicStreamBody('ordinary symlink turn finished'),
        );
        const reqBefore = seenRequests.length;
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-auto-symlink-plain',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
        });
        expect(resolverTools).toEqual([]);
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        expect(followUp.some((b) => b.includes('ordinary-symlink-content'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'leading-slash user input is escaped to literal text (extension commands not triggered)',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-slash-cwd-'));
      const agent = new PiAgent(buildDeps());
      let handle: AgentSessionHandle | null = null;
      try {
        scriptedResponses.length = 0;
        handle = await agent.startSession({
          sessionId: 'slash-escape-session',
          workingDir,
          model: 'pi-test-model',
        });
        const reqBefore = seenRequests.length;
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        // 未转义时 /plan 会被 plan-mode 扩展当命令吃掉:零网关请求、plan 状态被翻转。
        await handle.send({ type: 'user', content: '/plan' });
        await done;
        const followUp = seenRequests.slice(reqBefore).map((r) => r.body);
        // 转义后按字面文本进模型:产生网关请求,且请求体里带 "/plan" 原文
        expect(followUp.length).toBeGreaterThan(0);
        expect(followUp.some((b) => b.includes('/plan'))).toBe(true);
        // Cindy 侧 plan 镜像未被翻转
        expect(handle.getPlanMode?.()).toBe(false);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'auto mode: in-workspace write is silently approved and the file really lands on disk',
    { timeout: 60_000 },
    async () => {
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-perm-write-'));
      const target = path.join(workingDir, 'auto-note.txt');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('write', { path: target, content: 'hello-from-auto-review' }),
          anthropicStreamBody('write turn finished'),
        );
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'perm-auto-write',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny', // 同上:误弹窗会导致文件写不出来,断言即红
        });
        expect(resolverTools).toEqual([]);
        expect(existsSync(target)).toBe(true);
        const { readFileSync } = await import('node:fs');
        expect(readFileSync(target, 'utf8')).toContain('hello-from-auto-review');
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );
  it(
    'subagent tool spawns a real child pi, streams live card usage, and returns only its conclusion',
    { timeout: 120_000 },
    async () => {
      // 端到端:父会话调 subagent → Cindy 自有扩展 spawn 真 pi 子进程 → 子进程走同一
      // fake gateway → 结论回父模型;进度经工具原生 onUpdate 翻成 agent_task_update。
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-subagent-'));
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('subagent', { agent: 'scout', task: 'find the auth entry point' }),
          // 子进程这一轮:子代理的结论。
          anthropicStreamBody('auth starts at src/auth/index.ts:42'),
          anthropicStreamBody('parent turn finished'),
        );

        const agent = new PiAgent(buildDeps());
        const resolverTools: string[] = [];
        let handle: AgentSessionHandle | null = null;
        const events: AgentEvent[] = [];
        try {
          handle = await agent.startSession({
            sessionId: 'pi-subagent-e2e',
            workingDir,
            model: 'pi-test-model',
            permissionMode: 'ask',
          });
          handle.setInteractionResolver?.(async (req) => {
            resolverTools.push((req as { toolName?: string }).toolName ?? '?');
            return {
              kind: 'permission',
              requestId: (req as { requestId: string }).requestId,
              behavior: 'allow',
            } as never;
          });
          const done = (async () => {
            for await (const ev of handle!.events()) {
              events.push(ev);
              if (ev.type === 'done') break;
            }
          })();
          await handle.send({ type: 'user', content: 'go' });
          await done;
        } finally {
          await handle?.close();
        }

        // Ask 档仍逐次由用户确认 spawn；Auto 档另有回归证明 spawn 本身静默放行。
        expect(resolverTools).toEqual(['subagent']);

        // 卡片走的是与 Claude / Codex 同一条 agent_task_update 通道。
        const cardUpdates = events
          .filter((ev) => ev.type === 'agent_task_update')
          .map((ev) => (ev as { data: Record<string, unknown> }).data);
        expect(cardUpdates.length).toBeGreaterThan(0);
        expect(cardUpdates.every((u) => u.provider === 'pi')).toBe(true);
        expect(cardUpdates.at(0)?.status).toBe('running');
        expect(cardUpdates.at(-1)?.status).toBe('completed');
        expect(cardUpdates.at(-1)?.title).toBe('scout');
        const finalUsage = cardUpdates.at(-1)?.usage as Record<string, number> | undefined;
        // 真实用量来自子进程的 message_end.usage(fake gateway 上报 42 input tokens)。
        expect(finalUsage?.totalTokens).toBeGreaterThan(0);
        expect(typeof finalUsage?.durationMs).toBe('number');

        // 子代理的结论确实回到了父模型(tool_result 出现在后续请求体里)。
        expect(seenRequests.some((r) => r.body.includes('auth starts at src/auth/index.ts:42'))).toBe(true);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'auto mode: Subagent spawn is silent while a dangerous child tool call is still denied',
    { timeout: 120_000 },
    async () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), 'pi-subagent-auto-approval-'));
      const workingDir = path.join(tempRoot, 'workspace');
      mkdirSync(workingDir);
      const marker = path.join(tempRoot, 'must-not-exist.txt');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('subagent', {
            agent: 'worker',
            task: 'try the requested shell command',
          }),
          // Spawn itself is safe, but the worker's concrete side effect must return to the
          // parent approval surface. The resolver denies this command below.
          anthropicToolUseBody('write', { path: marker, content: 'must not land' }),
          anthropicStreamBody('the requested command was denied'),
          anthropicStreamBody('parent turn finished'),
        );

        const deps = buildDeps();
        deps.reviewAutoPermissionAction = async () => ({ verdict: 'block' });
        const { resolverTools } = await runPermissionTurn({
          sessionId: 'pi-subagent-auto-child-deny',
          workingDir,
          permissionMode: 'auto',
          resolverBehavior: 'deny',
          deps,
        });

        // Auto-review blocks the concrete child side effect silently. The child receives
        // the source-aware reason through the durable mailbox (covered by the protocol tests).
        expect(resolverTools).toEqual([]);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );

  it(
    'subagent write boundary is enforced, not cosmetic: child cannot shell out even under Full Access',
    { timeout: 120_000 },
    async () => {
      // 安全回归:父会话给 Full Access(bypassPermissions)时,bridge 会在子进程里重新注册
      // bash —— 但 `--tools read,grep,find,ls` 是 pi 的**注册面**白名单(文档:allowlist
      // built-in, extension, and custom tools),对扩展注册的工具同样生效。这里同时验证
      // 「没被告知」与「调了也不执行」两层,防止把只读画像做成表面白名单。
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-subagent-boundary-'));
      const marker = path.join(workingDir, 'pwned.txt');
      try {
        scriptedResponses.length = 0;
        scriptedResponses.push(
          anthropicToolUseBody('subagent', { agent: 'scout', task: 'probe the write boundary' }),
          // 子代理这一轮:硬调 bash 往工作区写文件(白名单外的工具)。
          anthropicToolUseBody('bash', { command: `echo pwned > ${JSON.stringify(marker)}` }),
          anthropicStreamBody('child could not run bash'),
          anthropicStreamBody('parent turn finished'),
        );

        const agent = new PiAgent(buildDeps());
        let handle: AgentSessionHandle | null = null;
        try {
          handle = await agent.startSession({
            sessionId: 'pi-subagent-boundary',
            workingDir,
            model: 'pi-test-model',
            // 最宽档:子代理的写边界不能靠父会话的权限档兜。
            permissionMode: 'bypassPermissions',
          });
          const done = (async () => {
            for await (const ev of handle!.events()) {
              if (ev.type === 'done') break;
            }
          })();
          await handle.send({ type: 'user', content: 'go' });
          await done;
        } finally {
          await handle?.close();
        }

        // 第一层:子进程被告知的工具面里没有 bash,也没有桥接的 MCP 工具。
        const childRequest = seenRequests.find((r) => r.body.includes('scout subagent'));
        expect(childRequest).toBeDefined();
        const advertised = new Set(
          [...(childRequest?.body ?? '').matchAll(/"name":"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]),
        );
        expect([...advertised].sort()).toEqual(['find', 'grep', 'ls', 'read']);
        expect(advertised.has('bash')).toBe(false);

        // 第二层(真正的边界):即便模型硬调 bash,工作区也不得被改动。
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(workingDir, { recursive: true, force: true });
        scriptedResponses.length = 0;
      }
    },
  );
  it(
    'BYOM: a subagent dispatched right after startSession still routes to the native endpoint',
    { timeout: 120_000 },
    async () => {
      // review 回归:子代理的 provider/model 来自运行期快照文件。若该快照不是在会话对外暴露
      // **之前**写好,BYOM / 本地 provider 会话一开始就派子代理时文件还不存在 → 扩展不传
      // --provider/--model → 子进程退回 pi 默认解析,直接打到网关而不是用户选的原生端点。
      const nativeBodies: string[] = [];
      // 原生端点自带脚本队列:第 1 个请求(父)派子代理,第 2 个(子)出结论,其余兜底。
      const nativeScript = [
        anthropicToolUseBody('subagent', { agent: 'scout', task: 'probe byom routing' }),
        anthropicStreamBody('native child conclusion'),
      ];
      const nativeServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          nativeBodies.push(body);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end(nativeScript.shift() ?? anthropicStreamBody('native done'));
        });
      });
      await new Promise<void>((r) => nativeServer.listen(0, '127.0.0.1', r));
      const nativeAddr = nativeServer.address();
      const nativeUrl = typeof nativeAddr === 'object' && nativeAddr ? `http://127.0.0.1:${nativeAddr.port}` : '';

      const deps = buildDeps();
      deps.auth.getState = async (options) => (options?.providerId === 'localbyom'
        ? { authenticated: true, identity: 'Local BYOM', authSource: 'api-key' as const }
        : { authenticated: false });
      deps.auth.getAuthEnv = async () => ({ CINDY_PI_API_KEY: 'gateway-unavailable-placeholder' });
      deps.resolvePiNativeProviders = async () => ({
        providers: [
          {
            id: 'localbyom',
            name: 'Local BYOM',
            baseUrl: nativeUrl,
            api: 'anthropic-messages',
            apiKeyEnvVar: 'CINDY_PI_KEY_LOCALBYOM',
            models: [{ id: 'byom-model', name: 'BYOM Model' }],
          },
        ],
        env: { CINDY_PI_KEY_LOCALBYOM: 'byom-secret-key' },
      });

      const agent = new PiAgent(deps);
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-byom-subagent-'));
      let handle: AgentSessionHandle | null = null;
      try {
        const gatewayBefore = seenRequests.length;
        handle = await agent.startSession({
          sessionId: 'byom-subagent-session',
          workingDir,
          model: 'byom-model',
          // 派子代理本身要过审批门(ask 档无 resolver 即拒);本例只验路由,给最宽档。
          permissionMode: 'bypassPermissions',
        });
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'delegate now' });
        await done;

        // eslint-disable-next-line no-console
        // 父 + 子两轮都打在原生端点上。
        expect(nativeBodies.length).toBeGreaterThanOrEqual(2);
        // 子进程确实是原生端点接的(子代理画像 prompt 只出现在子进程的请求里)。
        expect(nativeBodies.some((b) => b.includes('scout subagent'))).toBe(true);
        // 网关一个请求都没有 —— 子代理没有退回默认 provider。
        expect(seenRequests.length).toBe(gatewayBefore);
      } finally {
        await handle?.close();
        await new Promise<void>((r) => nativeServer.close(() => r()));
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'refuses to dispatch while a model switch is unconfirmed (no child spawns in the pending window)',
    { timeout: 120_000 },
    async () => {
      // review P1:host 原来在 set_model 回包**之前**就把新路由写进快照,于是等待窗口里模型
      // 发起的派发会按一个尚未确认的 provider 起子进程;RPC 随后返回失败时,回滚文件撤不回
      // 已经在跑的子进程。修法是这段窗口里的快照带 `pending: true`,扩展见到就拒绝派发。
      //
      // 这条用例验的是那个拒绝**真的挡住了进程**:结构性断言只能证明源码里有这段判断,证明
      // 不了子进程没起来。判据用"子代理画像 prompt 只出现在子进程自己的请求里"——一个字节都
      // 没出现 = 一个子进程都没起来。
      const { readdirSync, readFileSync } = await import('node:fs');
      const nativeBodies: string[] = [];
      // 第 1 个请求(父)派子代理;若真起了子进程,它的请求会是第 2 个。
      const nativeScript = [
        anthropicToolUseBody('subagent', { agent: 'scout', task: 'must not run during a pending switch' }),
        anthropicStreamBody('parent handled it without delegating'),
      ];
      const nativeServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          nativeBodies.push(body);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end(nativeScript.shift() ?? anthropicStreamBody('native done'));
        });
      });
      await new Promise<void>((r) => nativeServer.listen(0, '127.0.0.1', r));
      const nativeAddr = nativeServer.address();
      const nativeUrl = typeof nativeAddr === 'object' && nativeAddr ? `http://127.0.0.1:${nativeAddr.port}` : '';

      const deps = buildDeps();
      deps.auth.getState = async (options) => (options?.providerId === 'localbyom'
        ? { authenticated: true, identity: 'Local BYOM', authSource: 'api-key' as const }
        : { authenticated: false });
      deps.auth.getAuthEnv = async () => ({ CINDY_PI_API_KEY: 'gateway-unavailable-placeholder' });
      deps.resolvePiNativeProviders = async () => ({
        providers: [
          {
            id: 'localbyom',
            name: 'Local BYOM',
            baseUrl: nativeUrl,
            api: 'anthropic-messages',
            apiKeyEnvVar: 'CINDY_PI_KEY_LOCALBYOM',
            models: [{ id: 'byom-model', name: 'BYOM Model' }],
          },
        ],
        env: { CINDY_PI_KEY_LOCALBYOM: 'byom-secret-key' },
      });

      const agent = new PiAgent(deps);
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-pending-switch-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'pending-switch-session',
          workingDir,
          model: 'byom-model',
          // 派子代理本身要过审批门(ask 档无 resolver 即拒);本例只验 pending 闸,给最宽档,
          // 免得"没起子进程"其实是被权限门挡的。
          permissionMode: 'bypassPermissions',
        });

        // 把快照改成 host 在等待窗口里写的那个形状(model/provider 不变,只多 pending)。
        // 这样"没起子进程"唯一可能的原因就是 pending 闸:路由本身仍然完全可用。
        // 文件名带每运行时 nonce(跨实例隔离),所以按「前缀 + sessionId」找。**不要**只用
        // startsWith('subagent-'):agentHome 是整组共享的,别的用例留下的快照会被先找到
        // (实测拿到了另一个会话的 localresponses,单跑绿、全量红)。
        const runtimeDir = path.join(agentHome, 'runtime');
        const snapshotName = readdirSync(runtimeDir)
          .find((f) => f.startsWith('subagent-pending-switch-session-'));
        expect(snapshotName).toBeTruthy();
        const snapshotPath = path.join(runtimeDir, snapshotName as string);
        const confirmed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
        expect(confirmed.provider).toBe('localbyom');
        writeFileSync(snapshotPath, JSON.stringify({ ...confirmed, pending: true }) + '\n');

        const events: AgentEvent[] = [];
        const done = (async () => {
          for await (const ev of handle!.events()) {
            events.push(ev);
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'delegate now' });
        await done;

        // 父进程确实调了工具(否则这条用例什么都没验证)。
        expect(nativeBodies.length).toBeGreaterThanOrEqual(1);
        // 一个子进程都没起来:画像 prompt 只出现在子进程自己的请求里。
        expect(nativeBodies.some((b) => b.includes('scout subagent'))).toBe(false);
        // 而且拒绝理由回传给了父模型(不是静默无事发生 —— 模型要知道该自己干)。
        expect(nativeBodies.some((b) => b.includes('not confirmed yet'))).toBe(true);
        // 卡片必须收到一帧终态 failed。少这一帧,两端的卡片模型都会按"有工具结果 = completed"
        // 兜底,于是这次被拒绝的委派在界面上立刻变绿(review)。
        const cardStatuses = events
          .filter((e) => e.type === 'agent_task_update')
          .map((e) => (e.data as { status?: string }).status);
        expect(cardStatuses).toContain('failed');
        expect(cardStatuses).not.toContain('completed');
      } finally {
        await handle?.close();
        await new Promise<void>((r) => nativeServer.close(() => r()));
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );
});
