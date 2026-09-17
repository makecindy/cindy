import { afterEach, expect, it, vi } from 'vitest';
import { projectRemoteSessionResult, setRemoteBotSessionLookup } from '../remoteBotSessionBoundary';

afterEach(() => setRemoteBotSessionLookup(null));

it('bounds single-lookup adapters, deduplicates checks and preserves collection order', async () => {
  let active = 0;
  let peak = 0;
  const lookup = vi.fn(async (id: string) => {
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return id === 'hidden' ? 'hidden' as const : 'ordinary' as const;
  });
  setRemoteBotSessionLookup(lookup);
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}` }));
  expect(await projectRemoteSessionResult('local-db:sessions:list', { sessions: [null, ...rows, { id: 'hidden' }, rows[0]], count: 1002 }))
    .toEqual({ sessions: [...rows, rows[0]], count: 1002 });
  expect(lookup).toHaveBeenCalledTimes(1001);
  expect(peak).toBe(1);
});

it('batches Bot resource identities, preserves other resource kinds and recomputes filtered revision', async () => {
  const single = vi.fn(async () => 'visible' as const);
  const batch = vi.fn(async () => new Map([['visible', 'visible' as const], ['hidden', 'hidden' as const]]));
  setRemoteBotSessionLookup(single, batch);
  const other = { ref: { id: 'other', kind: 'document' }, revision: 'a' };
  const visible = { ref: { id: 'visible', kind: 'bot' }, revision: 'b' };
  const result = await projectRemoteSessionResult('maker:remote-resources:list', {
    items: [other, visible, { ref: { id: 'hidden', kind: 'bot' } }], revision: 'old', collectionId: 'teammates',
  });
  expect(result).toEqual({ items: [other, visible], revision: 'a|b', collectionId: 'teammates' });
  expect(batch).toHaveBeenCalledWith(['visible', 'hidden'], 'bot');
  expect(single).not.toHaveBeenCalled();
});

it('fails closed for incomplete batch results, rejects hidden gets and clears a replaced batch adapter', async () => {
  const batch = vi.fn(async () => new Map());
  setRemoteBotSessionLookup(async () => 'hidden', batch);
  expect(await projectRemoteSessionResult('maker:list-active', [{ sessionId: 's1' }])).toEqual([]);
  await expect(projectRemoteSessionResult('local-db:sessions:get', { id: 's1' })).rejects.toThrow('[NOT_FOUND]');
  setRemoteBotSessionLookup(async () => 'ordinary');
  expect(await projectRemoteSessionResult('maker:list-active', [{ sessionId: 's1' }])).toEqual([{ sessionId: 's1' }]);
  expect(batch).toHaveBeenCalledTimes(1);
});
