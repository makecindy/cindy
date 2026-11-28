/** #10050. Integration tier: real MCP gateway/JSON validation, no Feishu account.
 * Existing lane-tool tests require a live lease and have no asynchronous-card entry.
 * Minimal input: send_card with no getLaneScope, then update the returned message id.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createFeishuBotMcpServer } from '../cindy_feishuBotMcpServer';

describe('managed cards through the MCP gateway', () => {
  it('discovers, sends and updates without an active Feishu lease; never accepts a model-supplied chat', async () => {
    const send = vi.fn(async () => ({
      messageId: 'om_card',
      registered: true,
    }));
    const update = vi.fn(async () => ({ ok: true }));
    const server = createFeishuBotMcpServer({
      getChatId: () => null,
      sendFile: vi.fn(),
      sendMessage: vi.fn(),
      managedCards: { send, update },
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    const card = { schema: '2.0', body: { elements: [] } };
    try {
      const listed = await client.callTool({
        name: 'list_tools',
        arguments: { category: 'bot' },
      });
      expect(JSON.stringify(listed)).toContain('send_card');
      const sent = await client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'send_card',
          args: { card, requestId: 'request-1' },
        },
      });
      expect(JSON.stringify(sent)).toContain('om_card');
      await client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'update_card',
          args: { messageId: 'om_card', card },
        },
      });
      expect(send).toHaveBeenCalledWith(card, 'request-1');
      expect(update).toHaveBeenCalledWith('om_card', card);
      const invalid = await client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'send_card',
          args: { card, requestId: 'request-1', chatId: 'oc_other' },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
