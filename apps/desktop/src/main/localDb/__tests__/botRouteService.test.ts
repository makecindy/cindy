import { describe, expect, it } from 'vitest';

import {
  botChannelMountIdentity,
  sameBotChannelMountIdentity,
} from '../../../shared/botChannelRegistry.js';
import {
  botChannelMatchesSource,
  botRouteLaneKey,
  botRouteMatches,
  botRouteOwnsSourceLane,
} from '../botRouteService.js';

describe('botRouteMatches', () => {
  it('requires every discriminator declared by a Hermes-style route to match', () => {
    const route = { scopeKey: 'workspace-1', principalKey: 'channel-1', threadKey: 'thread-1' };
    expect(
      botRouteMatches(route, {
        platform: 'slack',
        scopeKey: 'workspace-1',
        principalKey: 'channel-1',
        threadKey: 'thread-1',
      }),
    ).toBe(true);
    expect(
      botRouteMatches(route, {
        platform: 'slack',
        scopeKey: 'workspace-2',
        principalKey: 'channel-1',
        threadKey: 'thread-1',
      }),
    ).toBe(false);
  });

  it('lets a parent channel route match a child thread while keeping thread routes exact', () => {
    const source = {
      platform: 'discord' as const,
      principalKey: 'post-1',
      parentPrincipalKey: 'forum-1',
      threadKey: 'post-1',
    };
    expect(botRouteMatches({ principalKey: 'forum-1' }, source)).toBe(true);
    expect(botRouteMatches({ principalKey: 'forum-1', threadKey: 'post-2' }, source)).toBe(false);
  });

  it('treats omitted discriminators as wildcards within the selected platform', () => {
    expect(
      botRouteMatches(
        { scopeKey: '', principalKey: '', threadKey: null },
        { platform: 'telegram', principalKey: '-100123' },
      ),
    ).toBe(true);
  });

  it('uses wildcard and parent routes only as templates, never as shared task owners', () => {
    const threaded = {
      platform: 'slack' as const,
      accountKey: 'T1',
      scopeKey: 'T1',
      principalKey: 'C1',
      threadKey: '100.1',
    };
    expect(
      botRouteOwnsSourceLane({ scopeKey: '', principalKey: '', threadKey: null }, threaded),
    ).toBe(false);
    expect(
      botRouteOwnsSourceLane({ scopeKey: 'T1', principalKey: 'C1', threadKey: null }, threaded),
    ).toBe(false);
    expect(
      botRouteOwnsSourceLane({ scopeKey: 'T1', principalKey: 'C1', threadKey: '100.1' }, threaded),
    ).toBe(true);
  });

  it('derives a stable key per concrete lane without exposing raw IM identifiers', () => {
    const base = {
      platform: 'telegram' as const,
      accountKey: 'bot-account',
      scopeKey: 'bot-account',
      principalKey: '-100123',
    };
    expect(botRouteLaneKey(base)).toBe(botRouteLaneKey({ ...base }));
    expect(botRouteLaneKey(base)).not.toContain('-100123');
    expect(botRouteLaneKey({ ...base, threadKey: 'topic-7' })).not.toBe(botRouteLaneKey(base));
  });

  it('binds non-local Channels to one concrete IM account and fails closed when unbound', () => {
    const source = { platform: 'telegram' as const, accountKey: 'bot-token-fingerprint' };
    expect(
      botChannelMatchesSource(
        'telegram',
        JSON.stringify({ accountKey: 'bot-token-fingerprint' }),
        source,
      ),
    ).toBe(true);
    expect(botChannelMatchesSource('telegram', '{}', source)).toBe(false);
    expect(
      botChannelMatchesSource(
        'telegram',
        JSON.stringify({ accountKey: 'another-account' }),
        source,
      ),
    ).toBe(false);
  });

  it('treats kind, ownership and account identity as one exclusive mount key', () => {
    const local = botChannelMountIdentity('telegram', {
      ownership: 'local-adapter',
      accountKey: 'bot-account',
    });
    expect(local).toEqual({
      kind: 'telegram',
      ownership: 'local-adapter',
      accountKey: 'bot-account',
    });
    expect(
      sameBotChannelMountIdentity(
        local,
        botChannelMountIdentity('telegram', {
          ownership: 'local-adapter',
          accountKey: ' bot-account ',
        }),
      ),
    ).toBe(true);
    expect(
      sameBotChannelMountIdentity(
        local,
        botChannelMountIdentity('telegram', {
          ownership: 'server-relay',
          accountKey: 'bot-account',
        }),
      ),
    ).toBe(false);
    expect(botChannelMountIdentity('telegram', { accountKey: 'bot-account' })).toBeNull();
  });
});
