/**
 * cindy_feishu_bot 渠道路由提示的回归测试。
 *
 * 背景(2026-07-16 实踩):hook 会话里模型把「把文件发给我」路由到了飞书通道
 * 并失败。修复方式是构建期按 sessionSource 给飞书侧全部工具描述追加路由提示
 * (规则 9:通道路由确定性用代码保证)。本测试锁两件事:
 *   1. Cindy hook source 时,每个工具描述 === 基线描述 + 对应固定提示
 *      后缀(锁"前缀确定、note 无易变内容");
 *   2. 非 hook 会话(缺省 / 'feishu')描述与基线字节级一致。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import {
  createFeishuBotMcpServer,
  SLACK_HOOK_SESSION_CHANNEL_NOTE,
  TELEGRAM_HOOK_SESSION_CHANNEL_NOTE,
  type FeishuBotMcpDeps,
} from '../cindy_feishuBotMcpServer';

function makeDeps(sessionSource?: string): FeishuBotMcpDeps {
  return {
    getChatId: () => 'oc_test',
    sendFile: vi.fn(async () => ({ ok: true })),
    sendMessage: vi.fn(async () => ({ ok: true, messageId: 'om_test' })),
    ...(sessionSource !== undefined ? { sessionSource } : {}),
  };
}

async function makeHarness(deps: FeishuBotMcpDeps) {
  const server = createFeishuBotMcpServer(deps);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'feishu-bot-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** 收集入口工具 + list_tools 返回的细粒度工具的全部描述,按名字索引。 */
async function readAllDescriptions(client: Client): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const tool of (await client.listTools()).tools) {
    out.set(`entry:${tool.name}`, tool.description ?? '');
  }
  const result = await client.callTool({
    name: 'list_tools',
    arguments: { category: 'bot' },
  });
  const text = (result as { content: Array<{ text?: string }> }).content[0]?.text;
  if (!text) throw new Error('missing list_tools payload');
  const payload = JSON.parse(text) as {
    tools: Array<{ name: string; description: string }>;
  };
  for (const tool of payload.tools) {
    out.set(`registry:${tool.name}`, tool.description);
  }
  return out;
}

const ALL_TOOL_KEYS = [
  'entry:list_tools',
  'entry:call_tool',
  'registry:send_file_to_user',
  'registry:send_message_to_user',
] as const;

describe('cindy_feishu_bot channel routing note', () => {
  it.each([
    ['slack-hook', SLACK_HOOK_SESSION_CHANNEL_NOTE],
    ['telegram', TELEGRAM_HOOK_SESSION_CHANNEL_NOTE],
  ] as const)(
    '%s description === base description + fixed note, for every tool',
    async (source, note) => {
      const withNote = await makeHarness(makeDeps(source));
      const base = await makeHarness(makeDeps());
      try {
        const noteDescs = await readAllDescriptions(withNote.client);
        const baseDescs = await readAllDescriptions(base.client);
        expect([...noteDescs.keys()].sort()).toEqual([...ALL_TOOL_KEYS].sort());
        for (const key of ALL_TOOL_KEYS) {
          expect(noteDescs.get(key)).toBe(baseDescs.get(key) + note);
        }
      } finally {
        await withNote.cleanup();
        await base.cleanup();
      }
    },
  );

  it('feishu source keeps descriptions identical to the undefined-source baseline', async () => {
    const feishu = await makeHarness(makeDeps('feishu'));
    const base = await makeHarness(makeDeps());
    try {
      const feishuDescs = await readAllDescriptions(feishu.client);
      const baseDescs = await readAllDescriptions(base.client);
      expect(feishuDescs).toEqual(baseDescs);
      for (const description of feishuDescs.values()) {
        expect(description).not.toContain(SLACK_HOOK_SESSION_CHANNEL_NOTE.trim());
        expect(description).not.toContain(TELEGRAM_HOOK_SESSION_CHANNEL_NOTE.trim());
      }
    } finally {
      await feishu.cleanup();
      await base.cleanup();
    }
  });
});
