import { describe, expect, it, vi } from 'vitest';
import { resolveCompanionSkillFiles } from '../skillFiles.js';
import { canonicalJson, COMPANION_VALUE_MAX_BYTES, createCompanionUploader, valueHash as canonicalHash, type CompanionPreferenceValue } from '../uploader.js';
import { createCompanionStore, readCompanionRows, STORE_INLINE_MAX_BYTES } from '../store.js';
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

describe('skill files', () => {
  const key = 'companion.skill-files.v1:brew';
  const local = (name: string, sha256 = `sha-${name}`) =>
    ({ path: `scripts/${name}`, size: 3, sha256, absolutePath: `/skills/brew/scripts/${name}` });
  const run = async (localFiles: ReturnType<typeof local>[], upload: (file: { name: string }) => Promise<string>, known: Record<string, string> = {}) => {
    const retain = vi.fn();
    const values = await resolveCompanionSkillFiles([memory('a.md', 'a'), { key, value: null, localFiles }],
      { known: sha => known[sha], upload, retain, log: { warn: vi.fn() } });
    return { values, retain, list: values.find(value => value.key === key)! };
  };

  it('sends only what the room does not have, and reuses identical content', async () => {
    const upload = vi.fn(async (file: { name: string }) => `media-${file.name}`);
    const { values, list, retain } = await run([local('old.py'), local('new.py'), local('copy.py', 'sha-new.py')], upload, { 'sha-old.py': 'media-old' });
    expect(upload.mock.calls.map(([file]) => file.name)).toEqual(['new.py']);
    expect(values[0]?.key).toBe('companion.memory.v1:a.md');
    expect(list.value).toEqual({ slug: 'brew', files: [
      { path: 'scripts/old.py', size: 3, sha256: 'sha-old.py', mediaId: 'media-old' },
      { path: 'scripts/new.py', size: 3, sha256: 'sha-new.py', mediaId: 'media-new.py' },
      { path: 'scripts/copy.py', size: 3, sha256: 'sha-new.py', mediaId: 'media-new.py' }] });
    expect(retain).toHaveBeenCalledWith({ 'sha-old.py': 'media-old', 'sha-new.py': 'media-new.py' }, {});
  });

  it('holds the skill back while a failure may pass, so the upload cycle leaves its cloud list alone', async () => {
    const { list, retain } = await run([local('a.py')], async () => { throw new Error('ECONNRESET'); });
    expect(list).toEqual({ key, value: null, unread: true });
    expect(retain).not.toHaveBeenCalled();
  });

  it('moves on without a file that can never be sent, and says the list is incomplete', async () => {
    const upload = vi.fn(async (file: { name: string }) => {
      if (file.name === 'big.bin') throw new Error('ATTACHMENT_TOO_LARGE');
      return `media-${file.name}`;
    });
    const { list } = await run([local('big.bin'), local('a.py')], upload);
    expect(list.value).toEqual({ slug: 'brew', omitted: ['scripts/big.bin'], files: [{ path: 'scripts/a.py', size: 3, sha256: 'sha-a.py', mediaId: 'media-a.py' }] });
  });

  it('stops asking a server without file storage', async () => {
    const upload = vi.fn(async () => { throw rejection(503, 'MEDIA_STORAGE_UNAVAILABLE'); });
    const { list } = await run([local('a.py'), local('b.py')], upload);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(list.value).toEqual({ slug: 'brew', omitted: ['scripts/a.py', 'scripts/b.py'], files: [] });
  });

  it('lists an empty file without uploading it', async () => {
    const upload = vi.fn(async () => 'media');
    const { list } = await run([{ ...local('empty.py'), size: 0 }], upload);
    expect(upload).not.toHaveBeenCalled();
    expect(list.value).toEqual({ slug: 'brew', files: [{ path: 'scripts/empty.py', size: 0, sha256: 'sha-empty.py', mediaId: '' }] });
  });

  it('passes on what the cloud never had, until this computer has the file', async () => {
    const retain = vi.fn();
    const pass = (values: CompanionPreferenceValue[], gaps: Record<string, { omitted: string[] }>) =>
      resolveCompanionSkillFiles(values, { known: () => 'media', upload: async () => 'media', gaps, retain });
    const skill = { key: 'companion.skill.v1:brew', value: { slug: 'brew', content: 'steps' } };
    const gaps = { brew: { omitted: ['data/big.bin'] } };
    // The new home has only what arrived, or nothing at all: both still say the big file exists.
    const some = await pass([skill, { key, value: null, localFiles: [local('a.py')] }], gaps);
    expect(some[1]?.value).toMatchObject({ omitted: ['data/big.bin'] });
    expect(retain).toHaveBeenLastCalledWith({ 'sha-a.py': 'media' }, gaps);
    expect((await pass([skill], gaps)).find(value => value.key === key)?.value).toEqual({ slug: 'brew', files: [], omitted: ['data/big.bin'] });
    // Back where the file is, it is an ordinary file again; a skill that is gone takes its gap with it.
    const back = await pass([skill, { key, value: null, localFiles: [{ ...local('x'), path: 'data/big.bin' }] }], gaps);
    expect(back[1]?.value).not.toHaveProperty('omitted');
    expect(retain).toHaveBeenLastCalledWith(expect.anything(), {});
    expect(await pass([memory('a.md', 'a')], gaps)).toHaveLength(1);
  });

  it('does not publish an older copy kept because the newer one did not arrive, until it is edited', async () => {
    const retain = vi.fn();
    const held = { ...local('run.sh'), sha256: 'old' };
    const gaps = { brew: { omitted: ['scripts/run.sh'], stale: { 'scripts/run.sh': 'old' } } };
    const upload = vi.fn(async () => 'media');
    const unchanged = await resolveCompanionSkillFiles([{ key, value: null, localFiles: [held] }], { known: () => undefined, upload, gaps, retain });
    expect(upload).not.toHaveBeenCalled();
    expect(unchanged[0]?.value).toEqual({ slug: 'brew', files: [], omitted: ['scripts/run.sh'] });
    expect(retain).toHaveBeenLastCalledWith({}, gaps);
    const edited = await resolveCompanionSkillFiles([{ key, value: null, localFiles: [{ ...held, sha256: 'edited' }] }], { known: () => undefined, upload, gaps, retain });
    expect(edited[0]?.value).toMatchObject({ files: [{ path: 'scripts/run.sh', sha256: 'edited' }] });
    expect(retain).toHaveBeenLastCalledWith({ edited: 'media' }, {});
  });

  it('keeps the list inside one value', async () => {
    // Also the cost: once per upload cycle on the main process.
    const started = performance.now();
    await run(Array.from({ length: 5000 }, (_, index) => local(`${'n'.repeat(60)}${index}.py`)), async file => `media-${file.name}`);
    expect(performance.now() - started).toBeLessThan(1000);
    const many = Array.from({ length: 800 }, (_, index) => local(`${'n'.repeat(60)}${index}.py`));
    const { list } = await run(many, async file => `media-${file.name}`);
    const value = list.value as { files: unknown[]; omitted: string[]; truncated?: boolean };
    expect(Buffer.byteLength(canonicalJson(value))).toBeLessThanOrEqual(COMPANION_VALUE_MAX_BYTES);
    expect(value.omitted.length).toBeGreaterThan(0);
    expect(value.files.length + value.omitted.length === 800 || value.truncated === true).toBe(true);
  });
});

describe('companion store', () => {
  /** Preferences and the companion store of one actor, with the store's change cursor and private bucket. */
  function storeSetup(options: { off?: boolean; noBucket?: boolean } = {}) {
    const prefs = new Map<string, { key: string; value: unknown; revision: number }>();
    const entries = new Map<string, { key: string; revision: number; seq: number; hash: string; size: number; deleted: boolean; value?: unknown; blob?: Buffer }>();
    const bucket = new Map<string, Buffer>();
    const pending = new Map<string, { key: string; expectedRevision: number; hash: string; size: number }>();
    let seq = 0;
    const put = (key: string, expectedRevision: number, next: { value?: unknown; blob?: Buffer; hash: string; size: number }) => {
      const current = entries.get(key)?.revision ?? 0;
      if (current !== expectedRevision) throw rejection(409, 'REVISION_CONFLICT', { revision: current });
      entries.set(key, { key, revision: current + 1, seq: ++seq, deleted: next.value === null && !next.blob, ...next });
      return { revision: current + 1 };
    };
    const { api, calls } = fakeApi((route, method, data) => {
      if (route.startsWith('/companion-store') && options.off) throw rejection(404, 'COMPANION_STORE_DISABLED');
      const query = new URL(`https://chat.invalid${route}`).searchParams;
      const body = data as Record<string, any>;
      if (route === '/preferences') {
        if (method === 'GET') return [...prefs.values()];
        const current = prefs.get(body.key)?.revision ?? 0;
        if (current !== body.expectedRevision) throw rejection(409, 'REVISION_CONFLICT', { revision: current });
        prefs.set(body.key, { key: body.key, value: body.value, revision: current + 1 });
        return { revision: current + 1 };
      }
      if (route.startsWith('/companion-store/changes')) {
        const after = Number(query.get('after'));
        const list = [...entries.values()].filter(entry => entry.seq > after).sort((a, b) => a.seq - b.seq);
        return { entries: list.map(({ blob, value, seq: at, ...entry }) => ({ ...entry, cursor: String(at),
          ...(blob ? { blob: true } : query.get('values') ? { value } : {}) })), cursor: String(list.at(-1)?.seq ?? after), hasMore: false };
      }
      if (route.startsWith('/companion-store/entry') && method === 'GET') {
        const entry = entries.get(query.get('key')!);
        return entry ? { ...entry, blob: entry.blob ? true : undefined } : { key: query.get('key'), revision: 0, deleted: true };
      }
      if (route === '/companion-store/entry') {
        const json = canonicalJson(body.value);
        return put(body.key, body.expectedRevision, { value: body.value, hash: canonicalHash(body.value), size: json.length });
      }
      if (route === '/companion-store/blob' && options.noBucket) throw rejection(503, 'MEDIA_STORAGE_UNAVAILABLE');
      if (route === '/companion-store/blob') {
        pending.set('u1', { key: body.key, expectedRevision: body.expectedRevision, hash: body.hash, size: body.size });
        return { uploadId: 'u1', uploadUrl: 'https://bucket.invalid/u1' };
      }
      if (route === '/companion-store/blob/complete') {
        const upload = pending.get(body.uploadId)!;
        return put(upload.key, upload.expectedRevision, { blob: bucket.get('https://bucket.invalid/u1'), hash: upload.hash, size: upload.size });
      }
      if (route.startsWith('/companion-store/blob')) {
        const entry = entries.get(query.get('key')!)!;
        bucket.set('https://bucket.invalid/get', entry.blob!);
        return { url: 'https://bucket.invalid/get', size: entry.size, hash: entry.hash, revision: entry.revision };
      }
      throw new Error(`unexpected ${method} ${route}`);
    });
    const transfer = {
      putBlob: vi.fn(async (url: string, _type: string, bytes: Buffer) => { bucket.set(url, bytes); }),
      getBlob: vi.fn(async (url: string) => bucket.get(url)!),
    };
    const store = createCompanionStore(api, { enabled: () => true, transfer });
    const { state } = memoryState();
    let values: CompanionPreferenceValue[] = [];
    const log = { warn: vi.fn() };
    const uploader = createCompanionUploader({ api, state, readValues: async () => values, log, store });
    const posts = () => calls.filter(call => call.method === 'POST').map(call => `${call.route} ${(call.data as { key?: string }).key ?? ''}`);
    return { api, store, uploader, prefs, entries, transfer, log, posts, setValues: (next: CompanionPreferenceValue[]) => { values = next; } };
  }

  it('keeps a memory too large for the preferences in the store, and a restore reads it back', async () => {
    const t = storeSetup();
    const big = memory('big.md', 'x'.repeat(COMPANION_VALUE_MAX_BYTES + 1000));
    t.setValues([profile('soul'), big]);
    await t.uploader.syncBot('bot', 'actor', Number.POSITIVE_INFINITY, { requireAll: true });
    // Older versions read only the preferences: every value they can hold stays there too.
    expect([...t.prefs.keys()]).toEqual(['companion.profile.v1']);
    expect([...t.entries.keys()]).toEqual(['companion.memory.v1:big.md']);
    const restored = await readCompanionRows(t.api, t.store, 'actor');
    expect(restored.map(row => [row.key, row.value])).toEqual([[profile('soul').key, profile('soul').value], [big.key, big.value]]);
    // Nothing changed: no writes.
    const before = t.posts().length;
    await t.uploader.syncBot('bot', 'actor');
    expect(t.posts()).toHaveLength(before);
    // Shrunk back under the preferences limit: it moves there and leaves the store.
    t.setValues([profile('soul'), memory('big.md', 'small again')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.entries.get(big.key)?.deleted).toBe(true);
    expect((await readCompanionRows(t.api, t.store, 'actor')).find(row => row.key === big.key)?.value).toEqual(memory('big.md', 'small again').value);
  });

  it('passes a deletion of a value kept only in the store to the next restore', async () => {
    const t = storeSetup();
    const big = memory('big.md', 'x'.repeat(COMPANION_VALUE_MAX_BYTES + 1000));
    t.setValues([profile('soul'), big]);
    await t.uploader.syncBot('bot', 'actor');
    t.setValues([profile('soul')]);
    await t.uploader.syncBot('bot', 'actor');
    // Without the deletion the computer taking over would keep (and re-upload) its old copy.
    expect((await readCompanionRows(t.api, t.store, 'actor')).find(row => row.key === big.key))
      .toMatchObject({ value: null, fromStore: true });
  });

  it('sends a value over the inline limit through the bucket and checks it on the way back', async () => {
    const t = storeSetup();
    const huge = memory('huge.md', 'y'.repeat(STORE_INLINE_MAX_BYTES + 10_000));
    t.setValues([huge]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.posts()).toEqual(['/companion-store/blob companion.memory.v1:huge.md', '/companion-store/blob/complete ']);
    expect((await readCompanionRows(t.api, t.store, 'actor')).map(row => row.value)).toEqual([huge.value]);
    t.entries.get(huge.key)!.blob = Buffer.from(canonicalJson({ ...huge.value as object, content: 'tampered' }));
    t.entries.get(huge.key)!.size = t.entries.get(huge.key)!.blob!.length;
    await expect(readCompanionRows(t.api, t.store, 'actor')).rejects.toThrow('COMPANION_BLOB_MISMATCH');
  });

  it('skips a value the store can never take, once, and still refuses a hand-over without it', async () => {
    const t = storeSetup({ noBucket: true });
    t.setValues([profile('soul'), memory('huge.md', 'y'.repeat(STORE_INLINE_MAX_BYTES + 10_000))]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.log.warn).toHaveBeenCalledWith('Companion value too large to upload; skipped', expect.objectContaining({ code: 'MEDIA_STORAGE_UNAVAILABLE' }));
    const asked = t.posts().length;
    await t.uploader.syncBot('bot', 'actor');
    expect(t.posts()).toHaveLength(asked);
    await expect(t.uploader.syncBot('bot', 'actor', Number.POSITIVE_INFINITY, { requireAll: true })).rejects.toThrow('COMPANION_VALUE_TOO_LARGE');
  });

  it('carries on with preferences only when the server has the store switched off', async () => {
    const t = storeSetup({ off: true });
    t.setValues([profile('soul'), memory('big.md', 'x'.repeat(COMPANION_VALUE_MAX_BYTES + 1000))]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.store.active()).toBe(false);
    expect([...t.prefs.keys()]).toEqual(['companion.profile.v1']);
    expect(t.log.warn).toHaveBeenCalledWith('Companion value too large to upload; skipped', expect.anything());
    expect((await readCompanionRows(t.api, t.store, 'actor')).map(row => row.key)).toEqual(['companion.profile.v1']);
  });
});
