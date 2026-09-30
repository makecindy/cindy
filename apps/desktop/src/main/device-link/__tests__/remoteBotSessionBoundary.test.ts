import { afterEach, expect, it, vi } from 'vitest';
import {
  assertRemoteBotInvocationAllowed,
  projectRemoteSessionResult, setRemoteBotSessionLookup } from '../remoteBotSessionBoundary';

afterEach(() => setRemoteBotSessionLookup(null));

it.each(['turn-list', 'turn-get'])('rechecks nested %s targets before returning remote snapshots', async (op) => {
  let hidden = false;
  setRemoteBotSessionLookup(async () => hidden ? 'hidden' : 'visible');
  const args = [{ op, payload: { sessionId: 'task', ids: ['set'] } }];
  await assertRemoteBotInvocationAllowed(args, 'git-review:remote-op');
  hidden = true;
  await expect(assertRemoteBotInvocationAllowed(args, 'git-review:remote-op')).rejects.toThrow('[NOT_FOUND]');
});

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

it('filters hidden runtime rows inside a complete active-session snapshot', async () => {
  setRemoteBotSessionLookup(async (id) => id === 'hidden' ? 'hidden' : 'ordinary');
  expect(await projectRemoteSessionResult('maker:list-active', {
    format: 'active-sessions-v2', sessions: [
      { sessionId: 'visible' }, { sessionId: 'hidden' },
    ],
  })).toEqual({ format: 'active-sessions-v2', sessions: [{ sessionId: 'visible' }] });
});


it('filters batch detail reads using the shared fresh visibility lookup', async () => {
  let hidden = false;
  const batch = vi.fn(async () => new Map([['s', hidden ? 'hidden' as const : 'visible' as const]]));
  setRemoteBotSessionLookup(async () => 'visible', batch);
  expect(await projectRemoteSessionResult('local-db:sessions:get-many', [{ id: 's' }])).toEqual([{ id: 's' }]);
  hidden = true;
  expect(await projectRemoteSessionResult('local-db:sessions:get-many', [{ id: 's' }])).toEqual([]);
  expect(batch).toHaveBeenCalledTimes(2);
});

it('checks every target of a label batch and filters only task rows in label results', async () => {
  setRemoteBotSessionLookup(async (id) => (id === 'hidden' ? 'hidden' : 'ordinary'));
  await expect(
    assertRemoteBotInvocationAllowed(
      [{ action: 'attach', sessionIds: ['ordinary', 'hidden'], tagIds: ['label'] }],
      'local-db:task-tags:execute',
    ),
  ).rejects.toThrow('[NOT_FOUND]');
  const tags = [{ id: 'hidden', name: 'A label ID is not a task ID' }];
  expect(
    await projectRemoteSessionResult('local-db:task-tags:execute', {
      tags,
      sessions: [
        { sessionId: 'ordinary', tags: [] },
        { sessionId: 'hidden', tags: [] },
      ],
    }),
  ).toEqual({ tags, sessions: [{ sessionId: 'ordinary', tags: [] }] });
});

it.each(['get', 'attach', 'detach'])('checks normalized task IDs for tag %s', async (action) => {
  setRemoteBotSessionLookup(async (id) => (id === 'hidden' ? 'hidden' : 'missing'));
  await expect(
    assertRemoteBotInvocationAllowed(
      [{ action, sessionIds: [' hidden '], tagIds: ['label'] }],
      'local-db:task-tags:execute',
    ),
  ).rejects.toThrow('[NOT_FOUND]');
});

it.each([
  undefined, [], [''], ['   '], [123], ['x'.repeat(129)],
  Array.from({ length: 101 }, () => 'same'),
  Array.from({ length: 10000 }, (_, i) => `session-${i}`),
])('rejects malformed tag targets before any authorization lookup (%#)', async (sessionIds) => {
  const lookup = vi.fn(async () => 'ordinary' as const);
  setRemoteBotSessionLookup(lookup);
  await expect(assertRemoteBotInvocationAllowed(
    [{ action: 'get', sessionIds }], 'local-db:task-tags:execute',
  )).rejects.toThrow('[INVALID_PARAMS]');
  expect(lookup).not.toHaveBeenCalled();
});

it('bounds normalized tag authorization and ignores unrelated object references', async () => {
  const lookup = vi.fn(async () => 'ordinary' as const);
  setRemoteBotSessionLookup(lookup);
  const sessionIds = Array.from({ length: 100 }, (_, i) => ` ${String(i).padStart(128, 'x')} `);
  await assertRemoteBotInvocationAllowed(
    [{ action: 'get', sessionIds, sessionId: 'unused', session: { id: 'unused' } }],
    'local-db:task-tags:execute',
  );
  expect(lookup).toHaveBeenCalledTimes(100);
  expect(lookup).toHaveBeenNthCalledWith(1, sessionIds[0].trim(), 'session');
  lookup.mockClear();
  await assertRemoteBotInvocationAllowed(
    [{ action: 'attach', sessionIds: [' task ', 'task'], tagIds: ['label'] }],
    'local-db:task-tags:execute',
  );
  expect(lookup).toHaveBeenCalledTimes(1);
});
