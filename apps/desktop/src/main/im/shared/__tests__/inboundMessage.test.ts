import { describe, expect, it } from 'vitest';

import type { IMAttachment } from '@cindy/im';

import { buildImUserMessage } from '../inboundMessage';

const NOTE = '[渠道说明] 系统追加，不是用户消息。本条来自 Discord 私聊 (chat_id: dm_1)。';

describe('attached IM delivery context', () => {
  it('keeps the delivery rule transport-invariant; channel facts live only in the per-message note', () => {
    const message = buildImUserMessage('测试discord', [], true, NOTE);
    const content = message.content as string;
    const deliveryBlock = content.slice(0, content.indexOf('</cindy_delivery_context>'));

    expect(deliveryBlock).toContain('<cindy_delivery_context>');
    expect(deliveryBlock).toContain('automatically delivers');
    expect(deliveryBlock).toContain('bot, webhook, or outbound integration');
    expect(deliveryBlock).toContain('transport-independent');
    expect(deliveryBlock).not.toMatch(/Discord|Feishu|Slack|source=/);
    // 顺序：投递规则 → 本条渠道说明 → 渠道原文。
    expect(content.endsWith(`</cindy_delivery_context>\n\n${NOTE}\n\n测试discord`)).toBe(true);
  });

  it('keeps the delivery context and channel note ahead of attachment content blocks', () => {
    const attachment: IMAttachment = {
      kind: 'image',
      absPath: 'C:\\tmp\\image.png',
      originalName: 'image.png',
      mimeType: 'image/png',
    };

    expect(buildImUserMessage('', [attachment], true, NOTE)).toEqual({
      type: 'user',
      content: [
        {
          type: 'text',
          text: expect.stringContaining('<cindy_delivery_context>'),
        },
        { type: 'text', text: NOTE },
        {
          type: 'image',
          path: attachment.absPath,
          mimeType: attachment.mimeType,
        },
      ],
    });
  });

  it('prefixes non-takeover IM messages with the channel note only', () => {
    expect(buildImUserMessage('普通飞书消息', [], false, NOTE)).toEqual({
      type: 'user',
      content: `${NOTE}\n\n普通飞书消息`,
    });
  });

  it('leaves the message unchanged when no channel note is available', () => {
    expect(buildImUserMessage('普通飞书消息', [])).toEqual({
      type: 'user',
      content: '普通飞书消息',
    });
    expect(buildImUserMessage('普通飞书消息', [], false, '')).toEqual({
      type: 'user',
      content: '普通飞书消息',
    });
  });
});
