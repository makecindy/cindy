import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import { CAPABILITIES, findCapability, listCapabilityIndex } from '../xdt-helper/capabilities.js';
import type { LiziMcpLogger } from '../types.js';

/**
 * get_capabilities 的行为契约测试。
 *
 * 此前只有 toolErrorTelemetry.test.ts 覆盖了它的 schema / 遥测,没有任何测试校验
 * 「能力索引与按 key 查询」这条真正被模型走的路径 —— 新增或改名 capability 时,
 * 索引缺项、detail 为空、UNKNOWN_KEY 的 available 列表过期都不会被发现。
 */

const sessionCtx = {
  agentKind: 'claude-code' as const,
  workingDir: '/tmp',
  sessionId: 'sess-capabilities',
};

function makeLogger(): LiziMcpLogger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function connect(server: McpServer) {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'capabilities-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** call_tool 的返回体是 JSON 文本块,取出来解析。 */
function parsePayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== 'text' || !first.text) {
    throw new Error('tool result has no text content');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('capabilities data source', () => {
  it('每条 capability 的 key / title / oneLiner / detail 都非空', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const entry of CAPABILITIES) {
      expect(entry.key.trim()).not.toBe('');
      expect(entry.title.trim()).not.toBe('');
      expect(entry.oneLiner.trim()).not.toBe('');
      expect(entry.detail.trim()).not.toBe('');
    }
  });

  it('key 不重复', () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('listCapabilityIndex 只暴露索引字段,不带 detail', () => {
    for (const item of listCapabilityIndex()) {
      expect(Object.keys(item).sort()).toEqual(['key', 'oneLiner', 'title']);
    }
  });

  it('about-cindy 覆盖产品身份与源码仓库', () => {
    const entry = findCapability('about-cindy');
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('https://github.com/makecindy/cindy');
    // 执行位置不能被写死成客户端:SSH 远程工作区下 agent 进程在远端主机。
    expect(entry!.detail).toContain('SSH 远程工作区');
    // 官网是区域敏感的:两个都要给,只给国际版会把大陆用户导错。
    expect(entry!.detail).toContain('https://cindy.cn');
    expect(entry!.detail).toContain('https://cindy.app');
  });
});

describe('get_capabilities tool', () => {
  it('不传 key 时返回包含 about-cindy 的索引', async () => {
    const h = await connect(createXdtHelperMcpServer({ logger: makeLogger() }, sessionCtx));
    try {
      const payload = parsePayload(
        await h.client.callTool({
          name: 'call_tool',
          arguments: { name: 'get_capabilities', args: {} },
        }),
      );

      expect(payload.ok).toBe(true);
      const caps = payload.capabilities as Array<{ key: string; detail?: unknown }>;
      expect(caps.map((c) => c.key)).toContain('about-cindy');
      // 索引不应该带 detail —— 否则渐进式发现省 token 的意义就没了。
      expect(caps.every((c) => c.detail === undefined)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('传 key=about-cindy 时返回 ok 与非空 detail', async () => {
    const h = await connect(createXdtHelperMcpServer({ logger: makeLogger() }, sessionCtx));
    try {
      const payload = parsePayload(
        await h.client.callTool({
          name: 'call_tool',
          arguments: { name: 'get_capabilities', args: { key: 'about-cindy' } },
        }),
      );

      expect(payload.ok).toBe(true);
      const capability = payload.capability as { key: string; detail: string };
      expect(capability.key).toBe('about-cindy');
      expect(capability.detail.trim().length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });

  it('未知 key 返回 UNKNOWN_KEY,且 available 列表与当前清单同步', async () => {
    const h = await connect(createXdtHelperMcpServer({ logger: makeLogger() }, sessionCtx));
    try {
      const payload = parsePayload(
        await h.client.callTool({
          name: 'call_tool',
          arguments: { name: 'get_capabilities', args: { key: 'no-such-capability' } },
        }),
      );

      expect(payload.ok).toBe(false);
      expect(payload.errorCode).toBe('UNKNOWN_KEY');
      const data = payload.data as { requested: string; available: string[] };
      expect(data.requested).toBe('no-such-capability');
      expect(data.available).toContain('about-cindy');
      expect(data.available).toEqual(CAPABILITIES.map((c) => c.key));
    } finally {
      await h.cleanup();
    }
  });
});
