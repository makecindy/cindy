/**
 * cindy_docs 的 provider 装配测试。
 *
 * 钉住三件事:
 *  1. 只有 host 传了 docs deps 才出现这个 provider(与其它 server 同规矩);
 *  2. `enabled` 白名单能筛掉它(desktop 侧按 plugin 开关传 BUILTIN_LIZI_MCP_IDS);
 *  3. toClaudeSdkConfig 把 ctx 的 workingDir / sessionId / getSessionContext
 *     真的绑进 server —— 路径边界完全建立在这上面,绑错等于边界失效。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';
import type { LiziMcpSessionContext } from '../types.js';

const ctx: LiziMcpSessionContext = {
  agentKind: 'claude-code',
  workingDir: '/tmp/does-not-matter',
  sessionId: 'sess-42',
};

describe('createLiziMcpProviders — cindy_docs', () => {
  it('没传 docs deps 时不注册', () => {
    const names = createLiziMcpProviders({}).map((p) => p.name);
    expect(names).not.toContain('cindy_docs');
  });

  it('传了 docs deps(即使是空对象)就注册', () => {
    const names = createLiziMcpProviders({ docs: {} }).map((p) => p.name);
    expect(names).toContain('cindy_docs');
  });

  it('enabled 白名单不含 cindy_docs 时被筛掉', () => {
    const names = createLiziMcpProviders({ docs: {}, enabled: ['cindy_helper'] }).map(
      (p) => p.name,
    );
    expect(names).not.toContain('cindy_docs');
  });

  it('provider 没有自带 isEnabled 门控(启停由 host 的 plugin registry 包一层)', () => {
    const provider = createLiziMcpProviders({ docs: {} }).find((p) => p.name === 'cindy_docs')!;
    expect(provider.isEnabled).toBeUndefined();
  });

  it('toClaudeSdkConfig 产出可实例化的 sdk server,并绑定会话 ctx', async () => {
    const provider = createLiziMcpProviders({ docs: {} }).find((p) => p.name === 'cindy_docs')!;
    const config = provider.toClaudeSdkConfig(ctx) as {
      type: string;
      name: string;
      instance: { connect: (t: unknown) => Promise<void> };
    };
    expect(config.type).toBe('sdk');
    expect(config.name).toBe('cindy_docs');

    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-provider-test', version: '0.0.0' });
    await Promise.all([config.instance.connect(serverTx), client.connect(clientTx)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['call_tool', 'list_tools']);
  });

  it('ctx 的 getSessionContext 被透传:归属由每次调用现解析,而不是建 server 时冻结', async () => {
    const getSessionContext = vi.fn(() => undefined);
    const provider = createLiziMcpProviders({ docs: {} }).find((p) => p.name === 'cindy_docs')!;
    const config = provider.toClaudeSdkConfig({ ...ctx, getSessionContext }) as {
      instance: { connect: (t: unknown) => Promise<void> };
    };
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-ctx-test', version: '0.0.0' });
    await Promise.all([config.instance.connect(serverTx), client.connect(clientTx)]);

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'read_sheet', args: { path: 'a.csv' } },
    });
    const body = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    // accessor 返回 undefined = 无法确认归属 → fail closed
    expect(body.errorCode).toBe('NO_SESSION_CONTEXT');
    expect(getSessionContext).toHaveBeenCalled();
  });

  it('render_pdf / inspect_pdf 的注册取决于 host 是否注入了对应回调', async () => {
    async function toolNames(
      deps: Parameters<typeof createLiziMcpProviders>[0]['docs'],
      category: 'convert' | 'read' = 'convert',
    ) {
      const provider = createLiziMcpProviders({ docs: deps }).find(
        (p) => p.name === 'cindy_docs',
      )!;
      const config = provider.toClaudeSdkConfig(ctx) as {
        instance: { connect: (t: unknown) => Promise<void> };
      };
      const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'docs-render-gate', version: '0.0.0' });
      await Promise.all([config.instance.connect(serverTx), client.connect(clientTx)]);
      const result = await client.callTool({
        name: 'list_tools',
        arguments: { category },
      });
      const body = JSON.parse(
        (result as { content: Array<{ text: string }> }).content[0]!.text,
      ) as { tools: Array<{ name: string }> };
      return body.tools.map((t) => t.name).sort();
    }

    expect(await toolNames({})).toEqual([]);
    expect(
      await toolNames({
        renderHtmlToPdf: async () => ({ buffer: Buffer.alloc(0), fontsReady: true }),
      }),
    ).toEqual(['render_pdf']);

    // read 类目:read_sheet 恒在(纯 JS),inspect_pdf 要 host 注入 pdfjs 通道。
    expect(await toolNames({}, 'read')).toEqual(['read_sheet']);
    expect(
      await toolNames(
        { inspectPdf: async () => ({ numPages: 0, pagesInspected: 0, pages: [] }) },
        'read',
      ),
    ).toEqual(['inspect_pdf', 'read_sheet']);
  });
});
