import { describe, expect, it } from 'vitest';

import { botRouteSourceForMessage } from '../botRouteSource';

describe('botRouteSourceForMessage', () => {
  it('keeps account, chat surface, outbound principal and thread dimensions separate', () => {
    expect(
      botRouteSourceForMessage('feishu', {
        contextId: 'cli_bot_app',
        chatId: 'oc_group_chat',
        senderId: 'g/oc_group_chat/omt_thread',
        scopeKey: 'omt_thread',
        threadTs: 'omt_thread',
      }),
    ).toEqual({
      platform: 'feishu',
      accountKey: 'cli_bot_app',
      scopeKey: 'oc_group_chat',
      principalKey: 'g/oc_group_chat/omt_thread',
      parentPrincipalKey: 'g/oc_group_chat/omt_thread',
      threadKey: 'omt_thread',
    });
  });

  it('uses the adapter sender lane for direct-message delivery', () => {
    expect(
      botRouteSourceForMessage('telegram', {
        contextId: 'telegram_bot_id',
        chatId: 'chat_42',
        senderId: 'user_42',
      }),
    ).toEqual({
      platform: 'telegram',
      accountKey: 'telegram_bot_id',
      scopeKey: 'chat_42',
      principalKey: 'user_42',
    });
  });
});
