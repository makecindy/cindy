import { describe, expect, it } from 'vitest';

import {
  BOT_CHANNEL_FEATURES,
  LOCAL_BOT_CHANNEL_FEATURES,
  RELAY_BOT_CHANNEL_FEATURES,
  botChannelFeatureCapabilitiesFor,
} from '../botChannelRegistry';

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

  it('describes every surface instead of leaving unsupported behavior undefined', () => {
    const matrix = botChannelFeatureCapabilitiesFor('feishu', 'local-adapter');
    expect(matrix.map((item) => item.feature)).toEqual(BOT_CHANNEL_FEATURES);
    expect(matrix.find((item) => item.feature === 'group-history')).toEqual({
      feature: 'group-history',
      availability: 'degraded',
      detail: 'feishu-turn-context-only',
    });
    expect(matrix.find((item) => item.feature === 'durable-delivery')).toEqual({
      feature: 'durable-delivery',
      availability: 'degraded',
      detail: 'process-lifetime-delivery',
    });
  });

  it('keeps relay Telegram cards and durable delivery explicit', () => {
    expect(RELAY_BOT_CHANNEL_FEATURES.telegram).toEqual(
      expect.arrayContaining(['cards', 'durable-delivery']),
    );
    expect(botChannelFeatureCapabilitiesFor('telegram', 'server-relay')).toEqual(
      expect.arrayContaining([
        { feature: 'cards', availability: 'native' },
        { feature: 'durable-delivery', availability: 'native' },
      ]),
    );
  });
});
