import { describe, expect, it } from 'vitest';

import type { BotProfile } from '../botStore';
import {
  BOT_ACTIVE_WINDOW_MS,
  botRosterActivityAt,
  filterBotRoster,
  isBotActiveNow,
  partitionBotRoster,
  sortBotRoster,
} from '../botRosterDisplay';

function bot(
  id: string,
  patch: Partial<BotProfile> = {},
): BotProfile {
  return {
    id,
    name: id,
    channel: 'local',
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

  it('treats a busy canonical turn, recent canonical message, or recent worker as Active now', () => {
    const now = 1_000_000;
    expect(isBotActiveNow(bot('busy'), { working: true, now })).toBe(true);
    expect(
      isBotActiveNow(bot('message', { lastMessageAt: now - BOT_ACTIVE_WINDOW_MS + 1 }), {
        working: false,
        now,
      }),
    ).toBe(true);
    expect(
      isBotActiveNow(
        bot('worker', {
          sessions: [
            {
              id: 'worker-session',
              title: 'Worker',
              kind: 'worker',
              channel: 'local',
              updatedAt: now - BOT_ACTIVE_WINDOW_MS + 1,
            },
          ],
        }),
        { working: false, now },
      ),
    ).toBe(true);
    expect(
      isBotActiveNow(bot('stale', { lastMessageAt: now - BOT_ACTIVE_WINDOW_MS }), {
        working: false,
        now,
      }),
    ).toBe(false);
  });

  it('uses creation only for roster ordering, not Active now', () => {
    const row = bot('fresh-profile', { createdAt: 900 });
    expect(botRosterActivityAt(row)).toBe(900);
    expect(isBotActiveNow(row, { working: false, now: 1_000 })).toBe(false);
  });
});
