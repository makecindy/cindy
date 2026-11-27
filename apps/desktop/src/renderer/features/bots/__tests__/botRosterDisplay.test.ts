import { describe, expect, it } from 'vitest';

import type { BotProfile } from '../botStore';
import {
  botRosterActivityAt,
  botDeviceLabel,
  filterBotRoster,
  partitionBotRoster,
  partitionRemoteBotRoster,
  pruneHiddenRemoteBotKeys,
  sortBotRoster,
} from '../botRosterDisplay';

function bot(
  id: string,
  patch: Partial<BotProfile> = {},
): BotProfile {
  return {
    id,
    name: id,
    description: '',
    avatar: '🤖',
    avatarColor: 'violet',
    enabled: true,
    skills: [],
    capabilities: {
      model: 'claude-sonnet-4-6',
      effort: 'high',
      fastMode: false,
      harness: 'claude',
      modelChain: [{ harness: 'claude', model: 'claude-sonnet-4-6', providerId: null, effort: 'high', fastMode: false }],
      skillMode: 'inherit',
      skillsExcluded: [],
      toolsetMode: 'inherit',
      toolsets: [],
      mcpMode: 'inherit',
      mcpServers: [],
      memory: true,
      permissions: 'ask',
    },
    createdAt: 1,
    sessions: [],
    ...patch,
  };
}

describe('Hermes-style Bot roster display', () => {
  it('distinguishes missing and duplicate host names without exposing device IDs', () => {
    const device = { deviceId: 'mac-1', name: ' Studio ' };
    expect(botDeviceLabel(device, [device, device])).toBe('Studio');
    expect(botDeviceLabel(device, [device, { deviceId: 'mac-2', name: 'studio' }])).toBe('Studio (1)');
    expect(botDeviceLabel({ deviceId: 'mac-2', name: ' ' }, [])).toBe('another computer');
  });
  it('sorts pinned Bots first and keeps recency ordering inside both groups', () => {
    const rows = sortBotRoster([
      bot('recent', { lastMessageAt: 90 }),
      bot('pinned-old', { pinnedAt: 1, lastMessageAt: 10 }),
      bot('old', { lastMessageAt: 20 }),
      bot('pinned-recent', { pinnedAt: 2, lastMessageAt: 80 }),
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      'pinned-recent',
      'pinned-old',
      'recent',
      'old',
    ]);
  });

  it('hides roster rows without removing them from the full Bot collection', () => {
    const all = [bot('visible'), bot('hidden', { hiddenAt: 5 })];

    expect(partitionBotRoster(all, { query: '', showHidden: false })).toMatchObject({
      visible: [{ id: 'visible' }],
      hidden: [{ id: 'hidden' }],
      showHiddenSection: true,
      showHiddenRows: false,
    });
    expect(all.map((row) => row.id)).toEqual(['visible', 'hidden']);
  });

  it('reveals matching hidden Bots while searching so they are recoverable', () => {
    const all = [
      bot('visible'),
      bot('hidden', { name: 'Release steward', hiddenAt: 5 }),
      bot('other-hidden', { hiddenAt: 6 }),
    ];

    const partition = partitionBotRoster(all, { query: 'release', showHidden: false });
    expect(partition.visible).toEqual([]);
    expect(partition.hidden.map((row) => row.id)).toEqual(['hidden']);
    expect(partition.showHiddenRows).toBe(true);
  });

  it('searches name, description, and Skill names without changing the source list', () => {
    const all = [
      bot('writer', { description: 'Release notes', skills: ['summarize'] }),
      bot('researcher', { description: 'Evidence', skills: ['web-research'] }),
    ];

    expect(filterBotRoster(all, 'WEB').map((row) => row.id)).toEqual(['researcher']);
    expect(filterBotRoster(all, 'release').map((row) => row.id)).toEqual(['writer']);
    expect(all).toHaveLength(2);
  });

  it('uses creation time only as a stable roster-ordering fallback', () => {
    const row = bot('fresh-profile', { createdAt: 900 });
    expect(botRosterActivityAt(row)).toBe(900);
  });

  // Issue #13461 (unit): remote roster partitioning and stale-key pruning must distinguish
  // devices for identical bot IDs and keep offline/startup preferences intact while dropping
  // keys deleted on online hosts or migrated home via companion cloud.
  it('partitions hidden remote bots by device+bot key and sorts hidden rows by recency', () => {
    const result = partitionRemoteBotRoster(
      [
        { deviceId: 'mac-1', id: 'cindy-default', activityAt: 10 },
        { deviceId: 'mac-2', id: 'cindy-default', activityAt: 30 },
        { deviceId: 'mac-1', id: 'writer', activityAt: 50 },
      ],
      new Set(['mac-1:cindy-default', 'mac-1:writer']),
    );
    expect(result.visible.map((item) => `${item.deviceId}:${item.id}`)).toEqual(['mac-2:cindy-default']);
    expect(result.hidden.map((item) => `${item.deviceId}:${item.id}`)).toEqual([
      'mac-1:writer',
      'mac-1:cindy-default',
    ]);
  });

  it('prunes migrated-home and malformed keys while preserving absent online-host hide choices', () => {
    const emptyCloud = { enabled: false, selfDeviceId: null, actors: [], demotedBotIds: [] };
    // Startup/offline empty roster keeps stored keys intact.
    expect(
      pruneHiddenRemoteBotKeys(['mac-1:temporarily-absent', 'offline-mac:cached'], {
        remoteBots: [],
        localBots: [],
        cloud: emptyCloud,
      }),
    ).toEqual(['mac-1:temporarily-absent', 'offline-mac:cached']);

    // Roster absence on an online host (e.g. hidden/archived on home host or >200 limit)
    // must not wipe local hide choice; migrated cloud companion and malformed keys are pruned.
    expect(
      pruneHiddenRemoteBotKeys(
        ['mac-1:keep', 'mac-1:temporarily-absent', 'offline-mac:keep-offline', 'mac-2:migrated', 'malformed'],
        {
          remoteBots: [{ deviceId: 'mac-1', id: 'keep' }],
          localBots: [{ id: 'migrated' }],
          cloud: {
            enabled: true,
            selfDeviceId: 'self-mac',
            demotedBotIds: [],
            actors: [{ id: 'a1', externalId: 'migrated', name: 'Migrated', avatar: null, homeDeviceId: 'self-mac' }],
          },
        },
      ),
    ).toEqual(['mac-1:keep', 'mac-1:temporarily-absent', 'offline-mac:keep-offline']);
  });
});
