import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, createCompanionUploader, valueHash as canonicalHash, type CompanionPreferenceValue } from '../uploader.js';
import { fakeApi, memoryState, rejection } from './fakes.js';

const profile = (soul: string): CompanionPreferenceValue =>
  ({ key: 'companion.profile.v1', value: { name: 'Mia', description: '', soul, systemPrompt: '', user: '' } });
const memory = (filename: string, content: string): CompanionPreferenceValue =>
  ({ key: `companion.memory.v1:${filename}`, value: { filename, content } });

function setup(server: Array<{ key: string; value: unknown; revision: number }> = [], options: { home?: () => boolean } = {}) {
  const rows = new Map(server.map(row => [row.key, { ...row }]));
  const { api, calls } = fakeApi((route, method, data) => {
    if (route === '/preferences' && method === 'GET') return [...rows.values()];
    const body = data as { key: string; expectedRevision: number; value: unknown };
    const current = rows.get(body.key)?.revision ?? 0;
    if (current !== body.expectedRevision) throw rejection(409, 'REVISION_CONFLICT', { revision: current });
    rows.set(body.key, { key: body.key, value: body.value, revision: current + 1 });
    return { revision: current + 1 };
  });
  const { state } = memoryState();
  let values: CompanionPreferenceValue[] = [];
  const log = { warn: vi.fn() };
  const onLostHome = vi.fn();
  const uploader = createCompanionUploader({ api, state, readValues: async () => values, log, maxValueBytes: 2000,
    ...(options.home ? { confirmHome: async () => options.home!(), onLostHome } : {}) });
  const writes = () => calls.filter(call => call.method === 'POST').map(call => call.data as { key: string; value: unknown; expectedRevision: number });
  return { uploader, state, calls, rows, writes, log, onLostHome, setValues: (next: CompanionPreferenceValue[]) => { values = next; } };
}

describe('companion profile uploader', () => {
  it('uploads only changed values, as the companion actor', async () => {
    const t = setup();
    t.setValues([profile('soul v1'), memory('a.md', 'alpha')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().map(w => [w.key, w.expectedRevision])).toEqual([['companion.profile.v1', 0], ['companion.memory.v1:a.md', 0]]);
    expect(t.calls.every(call => call.actorId === 'actor')).toBe(true);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes()).toHaveLength(2);
    t.setValues([profile('soul v2'), memory('a.md', 'alpha')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().slice(2).map(w => [w.key, w.expectedRevision])).toEqual([['companion.profile.v1', 1]]);
    expect(t.state.bot('bot')?.prefs['companion.profile.v1']?.revision).toBe(2);
  });

  it('writes a null tombstone once for a value that disappeared locally', async () => {
    const t = setup();
    t.setValues([profile('soul'), memory('a.md', 'alpha')]);
    await t.uploader.syncBot('bot', 'actor');
    t.setValues([profile('soul')]);
    await t.uploader.syncBot('bot', 'actor');
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().slice(2)).toEqual([expect.objectContaining({ key: 'companion.memory.v1:a.md', value: null, expectedRevision: 1 })]);
  });

  it('seeds revisions from the server and never tombstones keys this device did not have', async () => {
    const t = setup([
      { key: 'companion.profile.v1', value: profile('soul').value, revision: 4 },
      // E.g. a memory another computer uploaded, or one this device could not restore.
      { key: 'companion.memory.v1:elsewhere.md', value: { filename: 'elsewhere.md', content: 'x' }, revision: 2 },
      { key: 'other.app.key', value: 1, revision: 9 },
    ]);
    t.setValues([profile('soul'), memory('new.md', 'n')]);
    await t.uploader.syncBot('bot', 'actor');
    // The unchanged profile is recognised regardless of key order on the server.
    expect(t.writes().map(w => [w.key, w.expectedRevision])).toEqual([['companion.memory.v1:new.md', 0]]);
    expect(t.rows.get('companion.memory.v1:elsewhere.md')?.value).toEqual({ filename: 'elsewhere.md', content: 'x' });
    // Its own key disappears locally: that one is tombstoned.
    t.setValues([profile('soul')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().slice(1).map(w => [w.key, w.value])).toEqual([['companion.memory.v1:new.md', null]]);
  });

  it('keeps a late server value the take-over did not restore, until this device really edits the key', async () => {
    // The take-over restored soul v1; the old home's late upload then wrote v2 before the first sync here.
    const t = setup([{ key: 'companion.profile.v1', value: profile('v2').value, revision: 5 }]);
    t.state.update('bot', 'actor', entry => {
      entry.prefsSeeded = false;
      entry.prefs['companion.profile.v1'] = { hash: canonicalHash(profile('v1').value), revision: 4, local: true };
    });
    t.setValues([profile('v1')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes()).toEqual([]);
    expect(t.rows.get('companion.profile.v1')?.value).toEqual(profile('v2').value);
    // A real edit here still goes up, against the server's current revision.
    t.setValues([profile('v3')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().map(w => [w.key, w.expectedRevision])).toEqual([['companion.profile.v1', 5]]);
  });

  it('re-checks the home and re-reads the server before overwriting a conflicting value, once', async () => {
    let home = true;
    const t = setup([], { home: () => home });
    t.setValues([memory('a.md', 'mine')]);
    await t.uploader.syncBot('bot', 'actor');
    // Someone else wrote the key meanwhile.
    t.rows.set('companion.memory.v1:a.md', { key: 'companion.memory.v1:a.md', value: { filename: 'a.md', content: 'theirs' }, revision: 5 });
    t.setValues([memory('a.md', 'mine v2')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().slice(1).map(w => w.expectedRevision)).toEqual([1, 5]);
    expect(t.state.bot('bot')?.prefs['companion.memory.v1:a.md']).toMatchObject({ revision: 6, local: true });
    // When the home moved away, nothing is overwritten and actors are re-read.
    t.rows.set('companion.memory.v1:a.md', { key: 'companion.memory.v1:a.md', value: { filename: 'a.md', content: 'new home' }, revision: 9 });
    home = false;
    t.setValues([memory('a.md', 'mine v3')]);
    await expect(t.uploader.syncBot('bot', 'actor')).rejects.toThrow('NOT_HOME');
    expect(t.onLostHome).toHaveBeenCalledOnce();
    expect(t.rows.get('companion.memory.v1:a.md')?.value).toEqual({ filename: 'a.md', content: 'new home' });
  });

  it('leaves a part that could not be read untouched in the cloud, and refuses a hand-over', async () => {
    const t = setup();
    const routine = { key: 'companion.routine.v1:r1', value: { id: 'r1' } };
    t.setValues([profile('soul'), routine]);
    await t.uploader.syncBot('bot', 'actor');
    // The routine engine is not ready this time: the profile still goes up, the routine is not tombstoned.
    t.setValues([profile('soul v2'), { key: 'companion.routine.v1:', value: null, unread: true }]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().map(w => [w.key, w.value === null])).toEqual([
      ['companion.profile.v1', false], ['companion.routine.v1:r1', false], ['companion.profile.v1', false]]);
    await expect(t.uploader.syncBot('bot', 'actor', Number.POSITIVE_INFINITY, { requireAll: true })).rejects.toThrow('COMPANION_READ_INCOMPLETE');
  });

  it('clears a todo that left the travelling window from the cloud', async () => {
    const t = setup();
    t.setValues([profile('soul'), { key: 'companion.todo.v1:todo:1', value: { id: 'todo:1' } }]);
    await t.uploader.syncBot('bot', 'actor');
    t.setValues([profile('soul')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().filter(w => w.key === 'companion.todo.v1:todo:1').map(w => w.value)).toEqual([{ id: 'todo:1' }, null]);
  });

  it('spreads a large first upload over cycles', async () => {
    const t = setup();
    t.setValues(Array.from({ length: 45 }, (_, i) => memory(`m${i}.md`, `v${i}`)));
    expect(await t.uploader.syncAll([{ botId: 'bot', actorId: 'actor' }])).toBe(true);
    expect(t.writes()).toHaveLength(30);
    expect(await t.uploader.syncAll([{ botId: 'bot', actorId: 'actor' }])).toBe(false);
    expect(t.writes()).toHaveLength(45);
  });

  it('skips oversized values without truncating and keeps going', async () => {
    const t = setup();
    t.setValues([memory('big.md', 'x'.repeat(5000)), memory('small.md', 's')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().map(w => w.key)).toEqual(['companion.memory.v1:small.md']);
    expect(t.log.warn).toHaveBeenCalledWith('Companion value too large to upload; skipped', expect.objectContaining({ keyKind: 'companion.memory.v1' }));
  });

  it('logs and retries later when the server keeps failing', async () => {
    const { api } = fakeApi(() => { throw rejection(503, 'UNAVAILABLE'); });
    const log = { warn: vi.fn() };
    const uploader = createCompanionUploader({ api, state: memoryState().state, readValues: async () => [profile('s')], log });
    await uploader.syncAll([{ botId: 'bot', actorId: 'actor' }]);
    expect(log.warn).toHaveBeenCalledWith('Companion upload will retry', { actorId: 'actor', code: 'UNAVAILABLE' });
  });

  it('uploads the capability setup like any value: once, on change, with a hand-over waiting for it too', async () => {
    const t = setup();
    const caps = (memory: boolean): CompanionPreferenceValue => ({ key: 'companion.capabilities.v1', value: { skills: ['a'], memory } });
    t.setValues([profile('soul'), caps(true)]);
    await t.uploader.syncBot('bot', 'actor', undefined, { requireAll: true });
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().filter(w => w.key === 'companion.capabilities.v1').map(w => w.value)).toEqual([{ skills: ['a'], memory: true }]);
    t.setValues([profile('soul'), caps(false)]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().filter(w => w.key === 'companion.capabilities.v1')).toHaveLength(2);
    // A record that could not be read keeps the cloud value; a hand-over refuses to go without it.
    t.setValues([profile('soul'), { key: 'companion.capabilities.v1', value: null, unread: true }]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().filter(w => w.key === 'companion.capabilities.v1')).toHaveLength(2);
    await expect(t.uploader.syncBot('bot', 'actor', undefined, { requireAll: true })).rejects.toThrow('COMPANION_READ_INCOMPLETE');
  });

  it('serialises JSON with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], e: undefined })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  });
});
