import { describe, expect, it, vi } from 'vitest';
import { CINDY_DEFAULT_IDENTITY } from '../../../shared/botTemplatePreset.js';
import { isCindyCompanion, mergeCompanionsInto, mergedRoutineId, mergedTodoId, renamedEntry } from '../merge.js';
import { fakeApi, fakeLocal } from './fakes.js';

const KEEP_ROOM = '10000000-0000-4000-8000-00000000000a';
const FROM_ROOM = '10000000-0000-4000-8000-00000000000b';
const keep = { id: 'actor-keep', externalId: 'cindy-default', name: 'Cindy', homeDeviceId: 'desk' };
const from = { id: 'actor-from', externalId: 'bot_laptop_cindy', name: 'Cindy', homeDeviceId: 'laptop', label: 'MacBook Pro' };

describe('telling the copies of Cindy apart', () => {
  it('goes by the preset, never by name', () => {
    expect(isCindyCompanion('cindy-default', null)).toBe(true);
    expect(isCindyCompanion('bot_1', { templateId: 'cindy' })).toBe(true);
    expect(isCindyCompanion('bot_1', { soul: CINDY_DEFAULT_IDENTITY })).toBe(true);
    expect(isCindyCompanion('bot_1', { name: 'Cindy', soul: 'my own' })).toBe(false);
  });

  it('names a second copy after where it came from', () => {
    expect(renamedEntry('user_tea.md', 'MacBook Pro')).toBe('user_tea-macbook-pro.md');
    expect(renamedEntry('brew', '工作')).toBe('brew-merged');
  });
});

describe('merging copies of Cindy', () => {
  function setup() {
    const imports: Array<{ room: string; messages: Array<{ sourceId: string; authorId: string; createdAt: string; content: unknown[] }> }> = [];
    const added: Array<{ key: string; value: unknown; revision: number }> = [];
    const files: Array<{ type: string; mediaId: string; caption: string }> = [];
    const { api, calls } = fakeApi((route, method, data, actorId) => {
      if (route === '/preferences' && method === 'GET' && actorId === 'actor-from') return [...added, 
        { key: 'companion.profile.v1', value: { name: 'Cindy', soul: 'theirs' }, revision: 1 },
        { key: 'companion.memory.v1:user_tea.md', value: { filename: 'user_tea.md', content: 'likes green tea' }, revision: 2 },
        { key: 'companion.memory.v1:user_new.md', value: { filename: 'user_new.md', content: 'only there' }, revision: 3 },
        { key: 'companion.memory.v1:user_same.md', value: { filename: 'user_same.md', content: 'same' }, revision: 4 },
        { key: 'companion.memory.v1:user_gone.md', value: null, revision: 5 },
        { key: 'companion.todo.v1:todo:1', value: { id: 'todo:1', title: 'x', history: [] }, revision: 6 },
        { key: 'companion.routine.v1:routine-1', value: { id: 'routine-1', input: { triggers: [] }, originDeviceId: 'laptop' }, revision: 7 },
      ];
      if (route.startsWith(`/conversations/${FROM_ROOM}/messages?`)) return [
        { id: 'm2', seq: '2', authorId: 'actor-from', createdAt: new Date(2_000).toISOString(), content: [{ type: 'text', text: 'hello back' }] },
        { id: 'm1', seq: '1', authorId: 'human', createdAt: new Date(1_000).toISOString(), content: [{ type: 'text', text: 'hi' }, ...files] },
      ];
      if (route.endsWith('/import')) { imports.push({ room: route.split('/')[2]!, messages: (data as { messages: never[] }).messages }); return {}; }
      if (method === 'PATCH') return {};
      throw new Error(`unexpected ${method} ${route}`);
    });
    const local = fakeLocal({ applyTodos: vi.fn(async () => undefined), applyRoutines: vi.fn(async () => undefined) });
    local.memories.set('user_tea.md', 'likes black tea');
    local.memories.set('user_same.md', 'same');
    const importHistory = vi.fn<() => Promise<void>>(async () => undefined);
    const run = () => mergeCompanionsInto({ api, host: local.host, keep, from: [from], humanActorId: 'human',
      roomOf: async (actor) => (actor.id === keep.id ? KEEP_ROOM : FROM_ROOM), importHistory, fence: { assertCurrent: () => undefined } });
    const addPreference = (n: number) => { added.push({ key: `companion.memory.v1:late-${n}.md`, value: { content: 'late' }, revision: Math.max(1, 100 + n) }); };
    const withAttachment = () => { files.push({ type: 'media', mediaId: 'media-1', caption: 'cat.png' }); };
    return { run, api, local, calls, imports, importHistory, addPreference, withAttachment };
  }

  it('brings memories, todos and the conversation over, keeping a different same-name memory as a copy', async () => {
    const t = setup();
    const summary = await t.run();
    expect(t.local.memories.get('user_tea.md')).toBe('likes black tea');
    expect(t.local.memories.get('user_tea-macbook-pro.md')).toBe('likes green tea');
    expect(t.local.memories.get('user_new.md')).toBe('only there');
    expect(summary).toMatchObject({ merged: 1, messages: 2, memories: 2, renamed: ['user_tea-macbook-pro.md'] });
    expect(t.local.host.applyTodos).toHaveBeenCalledWith('cindy-default', [{ id: mergedTodoId('cindy-default', 'actor-from', 'todo:1'), title: 'x', history: [] }], [], expect.anything());
    // In message-time order, authored by the kept companion, with the original times.
    expect(t.imports[0]!.room).toBe(KEEP_ROOM);
    expect(t.imports[0]!.messages.map(m => [m.authorId, m.createdAt])).toEqual([['human', new Date(1_000).toISOString()], ['actor-keep', new Date(2_000).toISOString()]]);
    expect(t.calls.find(call => call.method === 'PATCH')).toMatchObject({ route: '/actors/actor-from', data: { disabled: true } });
    expect(t.importHistory).toHaveBeenCalledOnce();
  });

  it('can run again without duplicating anything', async () => {
    const t = setup();
    await t.run();
    const second = await t.run();
    expect(second.memories).toBe(0);
    expect(second.renamed).toEqual([]);
    // The same batch: the server dedupes by operation and source id.
    expect(t.imports[1]!.messages.map(m => m.sourceId)).toEqual(t.imports[0]!.messages.map(m => m.sourceId));
  });

  it('retires the copies only after the history is in, so a failed merge can run again', async () => {
    const t = setup();
    t.importHistory.mockRejectedValueOnce(new Error('OFFLINE'));
    await expect(t.run()).rejects.toThrow('OFFLINE');
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    const summary = await t.run();
    expect(summary.merged).toBe(1);
    expect(t.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('never overwrites a renamed copy that holds something else', async () => {
    const t = setup();
    t.local.memories.set('user_tea-macbook-pro.md', 'likes oolong');
    const summary = await t.run();
    expect(t.local.memories.get('user_tea-macbook-pro.md')).toBe('likes oolong');
    expect(t.local.memories.get('user_tea-macbook-pro-2.md')).toBe('likes green tea');
    expect(summary.renamed).toEqual(['user_tea-macbook-pro-2.md']);
    expect((await t.run()).renamed).toEqual([]);
  });

  it('gives merged routines ids of their own in the kept Cindy', async () => {
    const t = setup();
    await t.run();
    const id = mergedRoutineId('cindy-default', 'actor-from', 'routine-1');
    expect(id).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
    expect(id).not.toBe(mergedRoutineId('bot_other', 'actor-from', 'routine-1'));
    // Two copies holding the same id (e.g. a todo from the same old workbench entry) never collide.
    expect(mergedTodoId('cindy-default', 'actor-a', 'todo:legacy-x')).not.toBe(mergedTodoId('cindy-default', 'actor-b', 'todo:legacy-x'));
    expect(mergedTodoId('cindy-default', 'actor-a', 'todo:legacy-x')).toMatch(/^todo:/);
    expect(t.local.host.applyRoutines).toHaveBeenCalledWith('cindy-default',
      [{ id, input: { triggers: [] }, originDeviceId: 'laptop' }], [], expect.anything());
  });

  it('stops with the copies active when one added something after it was read', async () => {
    const t = setup();
    let extra = 0;
    const run = () => mergeCompanionsInto({ api: t.api, host: t.local.host, keep, from: [from], humanActorId: 'human',
      roomOf: async (actor) => (actor.id === keep.id ? KEEP_ROOM : FROM_ROOM), importHistory: t.importHistory,
      fence: { assertCurrent: () => undefined }, beforeRetire: async () => { extra += 1; t.addPreference(extra); } });
    await expect(run()).rejects.toThrow('COMPANION_STILL_CHANGING');
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('notices a copy that changed a preference without raising the newest revision', async () => {
    const t = setup();
    // Revisions count per key: a new memory at revision 1 leaves the highest revision (7) as it was.
    const run = () => mergeCompanionsInto({ api: t.api, host: t.local.host, keep, from: [from], humanActorId: 'human',
      roomOf: async (actor) => (actor.id === keep.id ? KEEP_ROOM : FROM_ROOM), importHistory: t.importHistory,
      fence: { assertCurrent: () => undefined }, beforeRetire: async () => { t.addPreference(-99); } });
    await expect(run()).rejects.toThrow('COMPANION_STILL_CHANGING');
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('fails with the copies active while a file of the conversation may still come', async () => {
    const t = setup();
    const media = { upload: vi.fn(), download: vi.fn(async () => { throw new Error('MEDIA_DOWNLOAD_FAILED'); }) };
    t.withAttachment();
    await expect(mergeCompanionsInto({ api: t.api, host: t.local.host, keep, from: [from], humanActorId: 'human', media,
      roomOf: async (actor) => (actor.id === keep.id ? KEEP_ROOM : FROM_ROOM), importHistory: t.importHistory,
      fence: { assertCurrent: () => undefined } })).rejects.toThrow('MEDIA_DOWNLOAD_FAILED');
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
});
