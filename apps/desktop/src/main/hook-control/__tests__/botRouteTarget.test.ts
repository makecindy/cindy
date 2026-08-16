import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/cindy-bot-route-target-test') },
}));

import {
  hookBotRouteSourceFromExternalKey,
  slackBotRouteSourceFromExternalKey,
  telegramBotRouteSourceFromExternalKey,
} from '../botRouteTarget';

describe('telegramBotRouteSourceFromExternalKey', () => {
  it('keeps Bot identity on account plus chat/topic, not relay generation or sender', () => {
    expect(telegramBotRouteSourceFromExternalKey('telegram:dm:bot-1:user-1:g2')).toEqual({
      platform: 'telegram', accountKey: 'bot-1', scopeKey: 'bot-1', principalKey: 'user-1',
      deliveryKey: 'telegram:dm:bot-1:user-1:g2',
    });
    expect(telegramBotRouteSourceFromExternalKey('telegram:group:bot-1:-100:owner:g2')).toEqual({
      platform: 'telegram', accountKey: 'bot-1', scopeKey: 'bot-1', principalKey: '-100',
      deliveryKey: 'telegram:group:bot-1:-100:owner:g2',
    });
    expect(telegramBotRouteSourceFromExternalKey('telegram:topic:bot-1:-100:42:owner:g2')).toEqual({
      platform: 'telegram', accountKey: 'bot-1', scopeKey: 'bot-1', principalKey: '-100',
      parentPrincipalKey: '-100', threadKey: '42',
      deliveryKey: 'telegram:topic:bot-1:-100:42:owner:g2',
    });
  });

  it('fails closed for legacy or malformed keys', () => {
    expect(telegramBotRouteSourceFromExternalKey('telegram:123:456')).toBeNull();
    expect(telegramBotRouteSourceFromExternalKey('telegram:topic:bot-1:-100:g2')).toBeNull();
    expect(telegramBotRouteSourceFromExternalKey('slack:dm:T1:U1')).toBeNull();
  });
});

describe('slackBotRouteSourceFromExternalKey', () => {
  it('maps production channel/thread and DM keys without generation identity', () => {
    expect(slackBotRouteSourceFromExternalKey('slack:T1:C1:171234.5678')).toEqual({
      platform: 'slack', accountKey: 'T1', scopeKey: 'T1', principalKey: 'C1',
      parentPrincipalKey: 'C1', threadKey: '171234.5678',
      deliveryKey: 'slack:T1:C1:171234.5678',
    });
    expect(slackBotRouteSourceFromExternalKey('slack:dm:T1:U1:g7')).toEqual({
      platform: 'slack', accountKey: 'T1', scopeKey: 'T1', principalKey: 'U1',
      deliveryKey: 'slack:dm:T1:U1:g7',
    });
  });

  it('uses TaskSource only to complete the old provider-prefixed channel key', () => {
    expect(slackBotRouteSourceFromExternalKey('team-slack:C1:171234.5678')).toBeNull();
    expect(
      slackBotRouteSourceFromExternalKey('team-slack:C1:171234.5678', {
        im: 'slack', teamId: 'T1',
      }),
    ).toEqual({
      platform: 'slack', accountKey: 'T1', scopeKey: 'T1', principalKey: 'C1',
      parentPrincipalKey: 'C1', threadKey: '171234.5678',
      deliveryKey: 'team-slack:C1:171234.5678',
    });
  });

  it('fails closed for malformed, ambiguous, or source-mismatched Slack keys', () => {
    expect(slackBotRouteSourceFromExternalKey('slack:dm:U1:g2')).toBeNull();
    expect(slackBotRouteSourceFromExternalKey('slack:dm:T1:U1:not-a-generation')).toBeNull();
    expect(slackBotRouteSourceFromExternalKey('slack:T1:C1:not-a-timestamp')).toBeNull();
    expect(
      slackBotRouteSourceFromExternalKey('team-slack:C1:171234.5678', {
        im: 'telegram', teamId: 'T1',
      }),
    ).toBeNull();
  });
});

describe('hookBotRouteSourceFromExternalKey', () => {
  it('keeps Telegram and Slack on their own route identity grammars', () => {
    expect(hookBotRouteSourceFromExternalKey('telegram:dm:bot:user:g1')?.platform).toBe('telegram');
    expect(hookBotRouteSourceFromExternalKey('slack:dm:T1:U1:g1')?.platform).toBe('slack');
  });
});
