import { describe, expect, it } from 'vitest';

import { LOCAL_BOT_CHANNEL_FEATURES } from '../botChannelRegistry';

describe('local Bot Channel capability catalog', () => {
  it('keeps the personal Discord mount honest about its DM-only adapter', () => {
    expect(LOCAL_BOT_CHANNEL_FEATURES.discord).toEqual([
      'direct-messages',
      'cards',
      'reactions',
      'attachments',
    ]);
  });

  it('advertises the Telegram card and Feishu topic surfaces they actually implement', () => {
    expect(LOCAL_BOT_CHANNEL_FEATURES.telegram).toContain('cards');
    expect(LOCAL_BOT_CHANNEL_FEATURES.feishu).toContain('threads');
  });
});
