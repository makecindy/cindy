import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectRemoteSessionResult,
  setRemoteBotSessionLookup,
  type RemoteBotSessionAccess,
} from '../remoteBotSessionBoundary';

afterEach(() => setRemoteBotSessionLookup(null));

describe('remote visibility batches', () => {
  it('batches each controller list independently and rechecks changed visibility on replay', async () => {
    const rows = Array.from({ length: 774 }, (_, i) => ({ id: `s${i}`, title: `t${i}` }));
    let hidden = false;
    const single = vi.fn(async () => 'ordinary' as const);
    const batch = vi.fn(
      async (ids: readonly string[]) =>
        new Map(
          ids.map((id) => [
            id,
            hidden && id === 's0' ? 'hidden' : ('ordinary' as RemoteBotSessionAccess),
          ]),
        ),
    );
    setRemoteBotSessionLookup(single, batch);
    expect(
      await Promise.all([
        projectRemoteSessionResult('local-db:sessions:list', rows),
        projectRemoteSessionResult('local-db:sessions:list', rows),
      ]),
    ).toEqual([rows, rows]);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(single).not.toHaveBeenCalled();
    hidden = true;
    expect(await projectRemoteSessionResult('local-db:sessions:list', rows)).toEqual(rows.slice(1));
    expect(batch).toHaveBeenCalledTimes(3);
  });

  it('preserves mixed resources, ordering and revision while filtering hidden or unchecked bots', async () => {
    const batch = vi.fn(
      async () =>
        new Map([
          ['visible', 'visible' as const],
          ['hidden', 'hidden' as const],
        ]),
    );
    setRemoteBotSessionLookup(async () => 'ordinary', batch);
    const items = [
      { ref: { kind: 'schedule', id: 'ordinary' }, revision: 'a' },
      { ref: { kind: 'bot', id: 'hidden' }, revision: 'b' },
      { ref: { kind: 'bot', id: 'visible' }, revision: 'c' },
      { ref: { kind: 'bot', id: 'unchecked' }, revision: 'd' },
    ];
    expect(
      await projectRemoteSessionResult('maker:remote-resources:list', { items, revision: 'old' }),
    ).toEqual({ items: [items[0], items[2]], revision: 'a|c' });
    expect(batch).toHaveBeenCalledWith(['hidden', 'visible', 'unchecked'], 'bot');
  });

  it('filters batch detail reads and keeps single GET denial', async () => {
    setRemoteBotSessionLookup(
      async () => 'hidden',
      async () => new Map([['s', 'hidden']]),
    );
    expect(await projectRemoteSessionResult('local-db:sessions:list', [{ id: 's' }])).toEqual([]);
    await expect(projectRemoteSessionResult('local-db:sessions:get', { id: 's' })).rejects.toThrow(
      'NOT_FOUND',
    );
  });
});

it('keeps the legacy single lookup bounded and preserves wrapped list ordering', async () => {
  let inFlight = 0;
  let peak = 0;
  setRemoteBotSessionLookup(async (id) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return id === 'hidden' ? 'hidden' : 'ordinary';
  });
  const rows = Array.from({ length: 774 }, (_, i) => ({ id: String(i) }));
  expect(
    await projectRemoteSessionResult('local-db:sessions:list', {
      sessions: [...rows, { id: 'hidden' }],
      marker: true,
    }),
  ).toEqual({ sessions: rows, marker: true });
  expect(peak).toBe(1);
});

it('propagates batch failure instead of sending unfiltered rows', async () => {
  setRemoteBotSessionLookup(
    async () => 'ordinary',
    async () => {
      throw new Error('db unavailable');
    },
  );
  await expect(projectRemoteSessionResult('local-db:bots:list', [{ id: 'bot' }])).rejects.toThrow(
    'db unavailable',
  );
});
