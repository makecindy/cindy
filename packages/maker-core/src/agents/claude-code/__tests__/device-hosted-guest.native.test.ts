/**
 * 真 Claude Code：受邀者(另一个账号)的托管会话只把白名单里的自带工具发给模型。
 * 用假的模型服务抓 Claude Code 实际发出的请求，核对 tools；不带白名单时同一请求里有名单外的
 * 工具(证明这个检查能发现问题)。Claude Code 升级后白名单不再生效时，这里会失败。
 *
 * 显式开启：CINDY_CLAUDE_TEST_BINARY=<claude 可执行文件> vitest run <本文件>。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { DEVICE_HOSTED_DISALLOWED_CLAUDE_TOOLS, DEVICE_HOSTED_GUEST_CLAUDE_TOOLS } from '../../shared/device-hosted.js';

const binaryPath = process.env.CINDY_CLAUDE_TEST_BINARY;

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** 假的模型服务：记录每个带 tools 的请求里的工具名，一律回一句文本结束本轮。 */
async function startFakeModel(): Promise<{ server: Server; url: string; toolNames: string[][] }> {
  const toolNames: string[][] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      let parsed: { stream?: boolean; tools?: Array<{ name?: string }> } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch { /* 非 JSON 请求按无工具处理 */ }
      if (Array.isArray(parsed.tools)) toolNames.push(parsed.tools.map((tool) => String(tool.name)));
      const message = {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (parsed.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          ...message, content: [{ type: 'text', text: 'DONE' }], stop_reason: 'end_turn',
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse([
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake model server has no port');
  return { server, url: `http://127.0.0.1:${address.port}`, toolNames };
}

/** 跑一轮，返回发给模型的工具名(合并所有带 tools 的请求)。 */
async function modelToolNames(tools: string[] | undefined): Promise<string[]> {
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'cindy-claude-guest-native-')));
  const fake = await startFakeModel();
  try {
    const run = query({
      prompt: 'Reply with DONE.',
      options: {
        pathToClaudeCodeExecutable: binaryPath,
        cwd: root,
        model: 'claude-sonnet-4-5-20250929',
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: path.join(root, 'config'),
          ANTHROPIC_API_KEY: 'sk-ant-cindy-native-test',
          ANTHROPIC_BASE_URL: fake.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
        },
        settingSources: [],
        strictMcpConfig: true,
        disallowedTools: [...DEVICE_HOSTED_DISALLOWED_CLAUDE_TOOLS],
        ...(tools ? { tools } : {}),
        maxTurns: 1,
      },
    });
    for await (const message of run) {
      if (message.type === 'result') break;
    }
    run.close();
    return [...new Set(fake.toolNames.flat())];
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(!binaryPath)('Claude Code device-hosted guest with a real binary', () => {
  it('sends only allowlisted built-in tools to the model', async () => {
    const names = await modelToolNames([...DEVICE_HOSTED_GUEST_CLAUDE_TOOLS]);
    expect(names.length).toBeGreaterThan(0);
    const allowed = new Set<string>(DEVICE_HOSTED_GUEST_CLAUDE_TOOLS);
    // 'Task' 是 Agent 的旧名，部分版本在请求里用它。
    allowed.add('Task');
    expect(names.filter((name) => !allowed.has(name) && !name.startsWith('mcp__'))).toEqual([]);
  }, 120_000);

  it('sends tools outside the allowlist when no allowlist is given', async () => {
    const names = await modelToolNames(undefined);
    expect(names).toContain('WebFetch');
  }, 120_000);
});
