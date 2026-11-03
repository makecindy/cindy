/**
 * cindy_slack MCP server tests: 真 McpServer + InMemoryTransport 驱动三个网关
 * 工具, 假 SlackToolBridge 注入。覆盖:
 *   - slack_status: 本地不可用视角 / server status 合并 / 桥错误透传
 *   - slack_list_tools / slack_call_tool: 透传 + 参数组装
 *   - 桥缺失(null)fail-closed
 *   - 大结果泄洪: >50k 自动落盘 / 显式 out_file / 路径越界拒绝 / 无 workdir 截断
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSlackMcpGatewayServer } from '../cindy_slackMcpServer.js';
import type { SlackHookMcpDeps, SlackToolBridgeLike, SlackToolBridgeResult } from '../types.js';

interface BridgeOpts {
  bound?: boolean;
  connected?: boolean;
  supports?: boolean;
  onCall?: (tool: string, args?: Record<string, unknown>) => SlackToolBridgeResult;
}

function makeBridge(opts: BridgeOpts = {}): {
  bridge: SlackToolBridgeLike;
  calls: Array<{ tool: string; args?: Record<string, unknown> }>;
} {
  const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  return {
    calls,
    bridge: {
      availability: () => ({
        connected: opts.connected ?? true,
        bound: opts.bound ?? true,
        serverSupportsTools: opts.supports ?? true,
      }),
      callTool: async (tool, args) => {
        calls.push({ tool, ...(args !== undefined ? { args } : {}) });
        return opts.onCall
          ? opts.onCall(tool, args)
          : { ok: true, result: { echoed: tool } };
      },
    },
  };
}

async function connectServer(deps: SlackHookMcpDeps) {
  const server = createSlackMcpGatewayServer(deps);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'slack-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return client;
}

function firstText(result: unknown): unknown {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text);
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});
function tmpWorkdir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'lizi-slack-test-'));
  tmpDirs.push(d);
  return d;
}

describe('cindy_slack MCP server', () => {
  // #7756 review: partial image filtering previously claimed an intact result.
  // Unit MCP call: mixed valid/unsupported/over-count blocks expose omissions;
  // large valid blocks share the existing inline budget. Existing test has one small image.
  it('fits large images to one budget and reports each omitted image', async () => {
    const image = { type: 'image', data: Buffer.alloc(160_000).toString('base64'), mimeType: 'image/png' };
    const { bridge } = makeBridge({ onCall: () => ({ ok: true, result: {
      content: [image, image, image, image, image, { ...image, mimeType: 'image/svg+xml' }],
    } }) });
    const compressInlineImage = vi.fn(async () => ({ buffer: Buffer.alloc(30_000), mime: 'image/webp' }));
    const client = await connectServer({ getBridge: () => bridge, compressInlineImage });
    try {
      const result = await client.callTool({ name: 'slack_call_tool', arguments: { name: 'cindy_get_message_images' } });
      const images = (result.content as Array<{ type: string; data?: string }>).filter(b => b.type === 'image');
      expect(images).toHaveLength(4);
      expect(images.reduce((sum, b) => sum + Buffer.from(b.data!, 'base64').length, 0)).toBe(120_000);
      expect(compressInlineImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', { targetBytes: 35_000 });
      expect(firstText(result)).toMatchObject({ data: {
        imageCount: 4, unavailable: 2, omittedImages: { invalid: 1, countLimit: 1, inlineBudget: 0 },
      } });
    } finally { await client.close(); }
  });
  // Unit regression: the gateway previously serialized MCP image blocks into unreadable JSON.
  it('returns large image blocks directly while preserving text metadata', async () => {
    const data = Buffer.alloc(50_000, 1).toString('base64');
    const { bridge } = makeBridge({
      onCall: () => ({
        ok: true,
        result: {
          content: [
            { type: 'text', text: 'untrusted screenshot' },
            { type: 'image', data, mimeType: 'image/png' },
          ],
        },
      }),
    });
    const client = await connectServer({ getBridge: () => bridge });
    try {
      const result = await client.callTool({
        name: 'slack_call_tool',
        arguments: { name: 'cindy_get_message_images' },
      });
      expect(result.content).toContainEqual({
        type: 'image',
        data,
        mimeType: 'image/png',
      });
      expect(JSON.stringify(firstText(result))).toContain('untrusted screenshot');
      expect(JSON.stringify(firstText(result))).not.toContain(data);
    } finally {
      await client.close();
    }
  });
  it('工具面固定三个(slack_status / slack_list_tools / slack_call_tool)', async () => {
    const { bridge } = makeBridge();
    const client = await connectServer({ getBridge: () => bridge });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'slack_call_tool',
      'slack_list_tools',
      'slack_status',
    ]);
  });

  it('slack_status: 全绿时合并 server 侧 status 结果', async () => {
    const { bridge, calls } = makeBridge({
      onCall: () => ({
        ok: true,
        result: { bound: true, teamId: 'T1', slackUserId: 'U1', hasUserToken: true, scopes: ['chat:write'] },
      }),
    });
    const client = await connectServer({ getBridge: () => bridge });
    const r = firstText(await client.callTool({ name: 'slack_status', arguments: {} }));
    expect(r).toMatchObject({ ok: true, connected: true, teamId: 'T1', hasUserToken: true });
    expect(calls).toEqual([{ tool: 'status' }]);
  });

  it('slack_status: 未绑定时给本地视角 + 指引, 不打 server', async () => {
    const { bridge, calls } = makeBridge({ bound: false });
    const client = await connectServer({ getBridge: () => bridge });
    const r = firstText(await client.callTool({ name: 'slack_status', arguments: {} }));
    expect(r).toMatchObject({ ok: true, bound: false });
    expect((r as { hint: string }).hint).toContain('绑定');
    expect(calls).toHaveLength(0);
  });

  it('桥缺失(null): fail-closed NOT_BOUND', async () => {
    const client = await connectServer({ getBridge: () => null });
    const raw = await client.callTool({ name: 'slack_list_tools', arguments: {} });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatchObject({ ok: false, errorCode: 'NOT_BOUND' });
  });

  it('slack_call_tool: name/arguments 组装成桥的 callTool 载荷; 错误码 + hint 透传', async () => {
    const { bridge, calls } = makeBridge({
      onCall: (tool) =>
        tool === 'callTool'
          ? { ok: false, error: { code: 'TOKEN_EXPIRED', message: 'token dead' } }
          : { ok: true, result: {} },
    });
    const client = await connectServer({ getBridge: () => bridge });
    const raw = await client.callTool({
      name: 'slack_call_tool',
      arguments: { name: 'search_messages', arguments: { query: 'x' } },
    });
    expect(calls).toEqual([
      { tool: 'callTool', args: { name: 'search_messages', arguments: { query: 'x' } } },
    ]);
    expect(raw.isError).toBe(true);
    const r = firstText(raw) as { errorCode: string; hint?: string };
    expect(r.errorCode).toBe('TOKEN_EXPIRED');
    expect(r.hint).toContain('重新完成一次授权');
  });

  it('大结果泄洪: >50k 自动落盘 workingDir 并返回相对路径', async () => {
    const workdir = tmpWorkdir();
    const big = { blob: 'x'.repeat(60_000) };
    const { bridge } = makeBridge({ onCall: () => ({ ok: true, result: big }) });
    const client = await connectServer({ getBridge: () => bridge, workingDir: workdir });
    const r = firstText(
      await client.callTool({ name: 'slack_list_tools', arguments: {} }),
    ) as { ok: boolean; saved_to: string };
    expect(r.ok).toBe(true);
    expect(r.saved_to).toBeTruthy();
    const onDisk = JSON.parse(readFileSync(path.join(workdir, r.saved_to), 'utf-8'));
    expect(onDisk).toEqual(big);
  });

  it('显式 out_file: 小结果也落盘到指定相对路径', async () => {
    const workdir = tmpWorkdir();
    const { bridge } = makeBridge({ onCall: () => ({ ok: true, result: { small: 1 } }) });
    const client = await connectServer({ getBridge: () => bridge, workingDir: workdir });
    const r = firstText(
      await client.callTool({
        name: 'slack_call_tool',
        arguments: { name: 'search', out_file: 'tmp/out.json' },
      }),
    ) as { saved_to: string };
    expect(r.saved_to.replace(/\\/g, '/')).toBe('tmp/out.json');
    expect(JSON.parse(readFileSync(path.join(workdir, 'tmp/out.json'), 'utf-8'))).toEqual({ small: 1 });
  });

  it('out_file 路径越界: PATH_NOT_ALLOWED 拒绝', async () => {
    const workdir = tmpWorkdir();
    const { bridge } = makeBridge({ onCall: () => ({ ok: true, result: {} }) });
    const client = await connectServer({ getBridge: () => bridge, workingDir: workdir });
    const raw = await client.callTool({
      name: 'slack_call_tool',
      arguments: { name: 'search', out_file: '../escape.json' },
    });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatchObject({ ok: false, errorCode: 'PATH_NOT_ALLOWED' });
  });

  it('自动泄洪撞上不可用 workingDir(如已删目录/远程路径): 降级截断而非 PATH_NOT_ALLOWED', async () => {
    const big = { blob: 'x'.repeat(60_000) };
    const { bridge } = makeBridge({ onCall: () => ({ ok: true, result: big }) });
    // 不存在的 workingDir: resolvePathInsideRoot 会抛 PathBoundaryError
    const client = await connectServer({
      getBridge: () => bridge,
      workingDir: path.join(os.tmpdir(), 'lizi-slack-gone-' + Date.now().toString(36)),
    });
    const raw = await client.callTool({ name: 'slack_list_tools', arguments: {} });
    expect(raw.isError).toBeUndefined(); // 数据已拿到, 不整体报错
    const r = firstText(raw) as { truncated: boolean; hint: string };
    expect(r.truncated).toBe(true);
    expect(r.hint).toContain('落盘未成功');
  });

  it('无 workingDir 的超大结果: 截断预览 + note, 不落盘', async () => {
    const big = { blob: 'x'.repeat(60_000) };
    const { bridge } = makeBridge({ onCall: () => ({ ok: true, result: big }) });
    const client = await connectServer({ getBridge: () => bridge });
    const r = firstText(
      await client.callTool({ name: 'slack_list_tools', arguments: {} }),
    ) as { truncated: boolean; preview: string; hint: string };
    expect(r.truncated).toBe(true);
    expect(r.preview.length).toBeLessThanOrEqual(50_000);
    expect(r.hint).toContain('无工作目录');
  });
});
