import { describe, expect, it, vi } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  projectSessionQueueForInspection,
  resolveSessionQueueCounts,
  type SessionQueueCountDeps,
  type SessionQueueInspectionEntry,
} from '../sessionQueueInspection.js';

function queuedItem(
  clientId: string,
  overrides: Partial<AgentInputQueuedMessage> = {},
): AgentInputQueuedMessage {
  return {
    clientId,
    text: `text-${clientId}`,
    persistedContent: `text-${clientId}`,
    model: 'gpt-5.6',
    effort: 'medium',
    permissionMode: 'bypassPermissions',
    workingDir: '/repo',
    chatMessage: {
      clientId,
      role: 'user',
      content: `text-${clientId}`,
      createdAt: '2026-08-16T01:02:03.000Z',
    },
    createOpts: {
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.6',
    },
    ...overrides,
  };
}

function inspectionEntry(queuedMessageId: string): SessionQueueInspectionEntry {
  return {
    queuedMessageId,
    position: 0,
    source: 'user',
    sourceLabel: null,
    enqueuedAtMs: null,
    content: queuedMessageId,
    consuming: false,
  };
}

describe('projectSessionQueueForInspection', () => {
  it('projects user, Orca, scheduler and session entries without leaking unrelated queue fields', () => {
    const result = projectSessionQueueForInspection(
      [
        queuedItem('q-orca', {
          hostAcceptedAtMs: Date.parse('2026-08-16T01:02:04.000Z'),
          origin: { kind: 'orca', senderLabel: 'Worker', displayText: 'raw worker update' },
        }),
        queuedItem('q-user'),
        queuedItem('q-scheduler', {
          chatMessage: {
            clientId: 'q-scheduler',
            role: 'user',
            content: 'scheduled',
            createdAt: 'not-a-date',
          },
          origin: { kind: 'scheduler', scheduleId: 's-1', scheduleName: 'PR sweep' },
        }),
        queuedItem('q-session', {
          origin: {
            kind: 'session',
            senderSessionId: 'sender-session',
            displayText: 'safe session summary',
          },
        }),
      ],
      ['q-user'],
    );

    expect(result).toEqual([
      {
        queuedMessageId: 'q-orca',
        position: 0,
        source: 'orca',
        sourceLabel: 'Worker',
        enqueuedAtMs: Date.parse('2026-08-16T01:02:04.000Z'),
        content: 'raw worker update',
        consuming: false,
      },
      {
        queuedMessageId: 'q-user',
        position: 1,
        source: 'user',
        sourceLabel: null,
        enqueuedAtMs: Date.parse('2026-08-16T01:02:03.000Z'),
        content: 'text-q-user',
        consuming: true,
      },
      {
        queuedMessageId: 'q-scheduler',
        position: 2,
        source: 'scheduler',
        sourceLabel: 'PR sweep',
        enqueuedAtMs: null,
        content: 'text-q-scheduler',
        consuming: false,
      },
      {
        queuedMessageId: 'q-session',
        position: 3,
        source: 'session',
        sourceLabel: 'sender-session',
        enqueuedAtMs: Date.parse('2026-08-16T01:02:03.000Z'),
        content: 'safe session summary',
        consuming: false,
      },
    ]);
  });

  it('keeps pre-dispatch and direct-steer items visible, ordered, and deduplicated', () => {
    const active = queuedItem('q-active');
    const direct = queuedItem('q-direct');
    const pending = queuedItem('q-pending');

    const result = projectSessionQueueForInspection([pending, direct], ['q-direct'], active, [
      direct,
    ]);

    expect(
      result.map(({ queuedMessageId, position, consuming }) => ({
        queuedMessageId,
        position,
        consuming,
      })),
    ).toEqual([
      { queuedMessageId: 'q-active', position: 0, consuming: true },
      { queuedMessageId: 'q-direct', position: 1, consuming: true },
      { queuedMessageId: 'q-pending', position: 2, consuming: false },
    ]);
  });

  it('uses live counts when restored and lightweight persisted counts otherwise', async () => {
    const loadPersistedCounts = vi.fn<SessionQueueCountDeps['loadPersistedCounts']>(
      async () => ({ cold: 3, raced: 4 }),
    );
    let racedIsLive = false;
    const getLiveQueue = vi.fn<SessionQueueCountDeps['getLiveQueue']>((sessionId) => {
      if (sessionId === 'live') return [inspectionEntry('live-1'), inspectionEntry('live-2')];
      if (sessionId === 'raced' && racedIsLive) return [inspectionEntry('raced-live')];
      return null;
    });
    loadPersistedCounts.mockImplementationOnce(async (sessionIds) => {
      expect(sessionIds).toEqual(['cold', 'raced']);
      racedIsLive = true;
      return { cold: 3, raced: 4 };
    });

    await expect(
      resolveSessionQueueCounts(['live', 'cold', 'raced', 'live'], {
        getLiveQueue,
        loadPersistedCounts,
      }),
    ).resolves.toEqual({ live: 2, cold: 3, raced: 1 });
  });

  it('isolates a live session whose queue has not finished restoring', async () => {
    const loadPersistedCounts = vi.fn<SessionQueueCountDeps['loadPersistedCounts']>(
      async () => ({ cold: 3 }),
    );

    await expect(
      resolveSessionQueueCounts(['live-unrestored', 'cold', 'live'], {
        getLiveQueue: (sessionId) => {
          if (sessionId === 'live-unrestored') return undefined;
          if (sessionId === 'live') return [inspectionEntry('live-1')];
          return null;
        },
        loadPersistedCounts,
      }),
    ).resolves.toEqual({ 'live-unrestored': 0, cold: 3, live: 1 });
    expect(loadPersistedCounts).toHaveBeenCalledWith(['cold']);
  });

  it('isolates one live queue inspection failure without dropping healthy sessions', async () => {
    const loadPersistedCounts = vi.fn<SessionQueueCountDeps['loadPersistedCounts']>(
      async () => ({ cold: 3 }),
    );

    await expect(
      resolveSessionQueueCounts(['broken-live', 'cold', 'healthy-live'], {
        getLiveQueue: (sessionId) => {
          if (sessionId === 'broken-live') throw new Error('coordinator unavailable');
          if (sessionId === 'healthy-live') return [inspectionEntry('healthy-live-1')];
          return null;
        },
        loadPersistedCounts,
      }),
    ).resolves.toEqual({ 'broken-live': 0, cold: 3, 'healthy-live': 1 });
    expect(loadPersistedCounts).toHaveBeenCalledWith(['cold']);
  });

  it('does not reuse a persisted count when the live recheck fails after the DB read', async () => {
    let reads = 0;
    await expect(
      resolveSessionQueueCounts(['raced-broken'], {
        getLiveQueue: () => {
          reads += 1;
          if (reads === 1) return null;
          throw new Error('live restore failed');
        },
        loadPersistedCounts: async () => ({ 'raced-broken': 4 }),
      }),
    ).resolves.toEqual({ 'raced-broken': 0 });
  });

  it('propagates persisted count failures instead of reporting zero', async () => {
    await expect(
      resolveSessionQueueCounts(['cold'], {
        getLiveQueue: () => null,
        loadPersistedCounts: async () => {
          throw new Error('snapshot unavailable');
        },
      }),
    ).rejects.toThrow('snapshot unavailable');
  });
});
