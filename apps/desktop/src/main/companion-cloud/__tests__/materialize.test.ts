import { describe, expect, it, vi } from 'vitest';
import { materializeCompanion } from '../materialize.js';
import { valueHash } from '../uploader.js';
import { fakeApi, fakeLocal, memoryState } from './fakes.js';

const ROOM = '10000000-0000-4000-8000-000000000001';
const actor = { id: 'actor-1', externalId: 'bot_mia', name: 'Mia', avatar: '🦊' };
const iso = (ms: number) => new Date(ms).toISOString();

const roomMessage = (id: string, seq: number, authorId: string, text: string, createdAt: number) =>
  ({ id, seq: String(seq), authorId, origin: 'chat', deleted: false, threadRootId: null, createdAt: iso(createdAt), content: [{ type: 'text', text }] });

function cloud(prefs: Array<{ key: string; value: unknown }>, room: unknown[] = []) {
  return fakeApi((route, method) => {
    if (route === '/preferences' && method === 'GET') return prefs.map((p, i) => ({ ...p, revision: i + 1 }));
    if (route.startsWith(`/conversations/${ROOM}/messages?`)) return room;
    throw new Error(`unexpected ${method} ${route}`);
  });
}

const profilePref = { key: 'companion.profile.v1', value: { name: 'Mia', description: 'helper', soul: 'I am Mia', systemPrompt: 'custom', user: 'Owner likes tea' } };

describe('materializeCompanion', () => {
  it('creates a missing companion from its cloud profile, memories and skills', async () => {
    const { api, calls } = cloud([profilePref,
      { key: 'companion.memory.v1:user_tea.md', value: { filename: 'user_tea.md', content: '---\ntitle: Tea\n---\nlikes tea' } },
      { key: 'companion.skill.v1:brew', value: { slug: 'brew', content: '---\nname: brew\n---\n\nsteps' } }]);
    const local = fakeLocal();
    const { state } = memoryState();
    state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(calls[0]).toMatchObject({ route: '/preferences', method: 'GET', actorId: 'actor-1' });
    expect(local.host.createProfile).toHaveBeenCalledWith({ id: 'bot_mia', name: 'Mia', description: 'helper',
      identitySource: 'I am Mia', userContextSource: 'Owner likes tea', avatar: '🦊' }, expect.anything());
    expect(local.host.updateProfile).not.toHaveBeenCalled();
    expect(local.host.writeSystemPrompt).toHaveBeenCalledWith('bot_mia', 'custom', expect.anything());
    expect(local.memories.get('user_tea.md')).toContain('likes tea');
    expect(local.skills.get('brew')).toContain('steps');
    expect(result).toEqual({ created: true, inserted: 0, rebuild: 'skipped', notices: ['permissions'] });
    expect(state.bot('bot_mia')?.demoted).toBeUndefined();
    expect(local.host.rebuildContext).not.toHaveBeenCalled();
  });

  it('updates an existing companion from the cloud; a tombstone deletes the local file whatever it holds', async () => {
    const { api } = cloud([profilePref,
      { key: 'companion.memory.v1:user_old.md', value: null },
      { key: 'companion.memory.v1:user_edited.md', value: null },
      { key: 'companion.memory.v1:user_never.md', value: null },
      { key: 'companion.memory.v1:user_same.md', value: { filename: 'user_same.md', content: 'same' } },
      { key: 'companion.skill.v1:gone', value: null }]);
    const local = fakeLocal();
    local.setProfile({ status: 'paused', displayName: 'Old', description: '' });
    local.memories.set('user_old.md', 'old'); local.memories.set('user_edited.md', 'edited here');
    local.memories.set('user_never.md', 'only here'); local.memories.set('user_same.md', 'same');
    local.skills.set('gone', 'x');
    const { state } = memoryState();
    state.update('bot_mia', 'actor-1', entry => {
      entry.prefs['companion.memory.v1:user_old.md'] = { hash: valueHash({ filename: 'user_old.md', content: 'old' }), revision: 1, local: true };
      entry.prefs['companion.memory.v1:user_edited.md'] = { hash: valueHash({ filename: 'user_edited.md', content: 'original' }), revision: 1, local: true };
    });
    const backupHome = vi.fn(async () => '/backup');
    local.host.backupHome = backupHome;
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(local.host.createProfile).not.toHaveBeenCalled();
    expect(local.host.updateProfile).toHaveBeenCalledWith({ id: 'bot_mia', name: 'Mia', description: 'helper', identitySource: 'I am Mia', userContextSource: 'Owner likes tea', avatar: '🦊' }, expect.anything());
    // Deleted in the cloud means deleted here too, so the uploader cannot bring it back;
    // the copy was backed up first.
    expect(vi.mocked(local.host.removeMemory).mock.calls.map(call => call[1]).sort()).toEqual(['user_edited.md', 'user_never.md', 'user_old.md']);
    expect([...local.memories.keys()].sort()).toEqual(['user_same.md']);
    expect(local.host.restoreMemory).not.toHaveBeenCalled();
    expect(local.host.removeSkill).toHaveBeenCalledWith('bot_mia', 'gone', expect.anything());
    expect(backupHome).toHaveBeenCalledOnce();
    expect(result.backup).toBe('/backup');
    expect(state.bot('bot_mia')?.prefs['companion.memory.v1:user_never.md']).toMatchObject({ local: true });
    expect(state.bot('bot_mia')?.backedUp).toBeUndefined();
    expect(state.bot('bot_mia')?.prefs['companion.memory.v1:user_same.md']).toMatchObject({ local: true });
  });

  it('backs up a local copy that never synced before overwriting it', async () => {
    const { api } = cloud([profilePref]);
    const local = fakeLocal({ backupHome: vi.fn(async () => '/backups/bot_mia-1') });
    local.setProfile({ status: 'active', displayName: 'Cindy', description: '' });
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM, log });
    expect(result.backup).toBe('/backups/bot_mia-1');
    expect(local.host.backupHome).toHaveBeenCalledBefore(local.host.updateProfile as never);
    expect(log.info).toHaveBeenCalledWith('Companion local copy backed up before take-over', { actorId: 'actor-1', backup: '/backups/bot_mia-1' });
  });

  it('stops at the first step after the account changed', async () => {
    const { api } = cloud([profilePref, { key: 'companion.memory.v1:user_tea.md', value: { filename: 'user_tea.md', content: 'tea' } }],
      [roomMessage('m1', 1, 'human', 'hello', 1_700_000_000_000)]);
    let current = true;
    const local = fakeLocal({ createProfile: vi.fn(async () => { current = false; }) });
    await expect(materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM,
      fence: { assertCurrent: () => { if (!current) throw new Error('OWNER_CHANGED'); } } })).rejects.toThrow('OWNER_CHANGED');
    expect(local.host.restoreMemory).not.toHaveBeenCalled();
    expect(local.host.writeSystemPrompt).not.toHaveBeenCalled();
    expect(local.host.insertHistory).not.toHaveBeenCalled();
    expect(local.host.rebuildContext).not.toHaveBeenCalled();
  });

  it('applies the cloud skill\'s enabled state even when the body is unchanged', async () => {
    const { api } = cloud([profilePref,
      { key: 'companion.skill.v1:brew', value: { slug: 'brew', content: 'same', enabled: false } },
      { key: 'companion.skill.v1:tea', value: { slug: 'tea', content: 'same' } }]);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    local.skills.set('brew', 'same'); local.skills.set('tea', 'same'); local.disabledSkills.add('tea');
    await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM });
    expect([...local.disabledSkills]).toEqual(['brew']);
  });

  it('publishes the demotion before the first local write', async () => {
    const { api } = cloud([profilePref]);
    const local = fakeLocal();
    const { state } = memoryState();
    const onDemoted = vi.fn(() => {
      expect(state.isDemoted('bot_mia')).toBe(true);
      expect(local.host.createProfile).not.toHaveBeenCalled();
    });
    await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM, onDemoted });
    expect(onDemoted).toHaveBeenCalledOnce();
  });

  it('retries history by room message id, so parts sharing a timestamp are not skipped', async () => {
    const at = 1_700_000_000_000;
    // Two parts of one split reply share role and time; the first was inserted before a failure.
    const { api } = cloud([profilePref], [roomMessage('m2', 2, 'actor-1', 'part two', at), roomMessage('m1', 1, 'actor-1', 'part one', at)]);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    local.rows.push({ id: 'p1', clientId: 'cloud-history:m1', role: 'assistant', content: 'part one', agentMeta: null, createdAt: at });
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.inserted).toBe(1);
    expect(vi.mocked(local.host.insertHistory).mock.calls.map(call => call[1].clientId)).toEqual(['cloud-history:m2']);
  });

  it('does not bring back a message that was rewound or deleted here', async () => {
    const at = 1_700_000_000_000;
    const { api } = cloud([profilePref], [roomMessage('m1', 1, 'human', 'regretted', at)]);
    const local = fakeLocal({ localMessageTimes: vi.fn(async () => [{ role: 'message_tombstone', createdAt: at, clientId: 'c1', removed: true }]) });
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.inserted).toBe(0);
  });

  it('inserts the room history that is not local yet, then rebuilds the context once', async () => {
    const mirroredAt = 1_700_000_000_000;
    const room = [
      roomMessage('m3', 3, 'actor-1', 'reply from laptop', mirroredAt + 2000),
      roomMessage('m2', 2, 'human', 'question on laptop', mirroredAt + 1000),
      roomMessage('m1', 1, 'human', 'mirrored from here', mirroredAt),
    ];
    const { api } = cloud([profilePref], room);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    local.rows.push({ id: 'own', clientId: 'c-own', role: 'user', content: 'mirrored from here', agentMeta: null, createdAt: mirroredAt });
    const { state } = memoryState();
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(vi.mocked(local.host.insertHistory).mock.calls.map(call => call[1])).toEqual([
      { clientId: 'cloud-history:m2', role: 'user', text: 'question on laptop', createdAt: mirroredAt + 1000 },
      { clientId: 'cloud-history:m3', role: 'assistant', text: 'reply from laptop', createdAt: mirroredAt + 2000 },
    ]);
    expect(result).toMatchObject({ inserted: 2, rebuild: 'rebuilt' });
    expect(local.host.rebuildContext).toHaveBeenCalledOnce();
    // Imported history never moves the mirror cursor: it stays on the newest row written here.
    expect(state.bot('bot_mia')).toMatchObject({ mirror: { sessionId: 'session-1', createdAt: mirroredAt, id: 'own' } });
    expect(state.bot('bot_mia')?.pendingRebuild).toBeUndefined();
    // A second run finds everything local and does not rebuild again.
    const again = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(again).toMatchObject({ inserted: 0, rebuild: 'skipped' });
    expect(local.host.rebuildContext).toHaveBeenCalledOnce();
  });

  it('does not re-insert a room message that was already delivered here as a direct-room input', async () => {
    const room = [roomMessage('m9', 9, 'human', 'from the phone', 1_700_000_000_000)];
    const { api } = cloud([profilePref], room);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    // Delivered later than the room message was written, under its own client id.
    local.rows.push({ id: 'd', clientId: 'chat-direct:exec-1:m9', role: 'user', content: 'from the phone', agentMeta: null, createdAt: 1_700_000_005_000 });
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.inserted).toBe(0);
    expect(local.host.insertHistory).not.toHaveBeenCalled();
  });

  it('stays demoted while the Session is busy, and completes once a retry can rebuild', async () => {
    const { api } = cloud([profilePref], [roomMessage('m1', 1, 'human', 'hello', 1_700_000_000_000)]);
    const local = fakeLocal({ rebuildContext: vi.fn(async (): Promise<'rebuilt' | 'busy'> => 'busy') });
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    const { state } = memoryState();
    await expect(materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM })).rejects.toThrow('CONTEXT_REBUILD_PENDING');
    expect(state.bot('bot_mia')).toMatchObject({ demoted: true, pendingRebuild: true });
    vi.mocked(local.host.rebuildContext).mockResolvedValue('rebuilt');
    expect((await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM })).rebuild).toBe('rebuilt');
    expect(state.bot('bot_mia')?.demoted).toBeUndefined();
  });

  it('stays demoted until every memory is restored, then the retry completes the take-over', async () => {
    const { api } = cloud([profilePref,
      { key: 'companion.memory.v1:user_ok.md', value: { filename: 'user_ok.md', content: 'ok' } },
      { key: 'companion.memory.v1:user_bad.md', value: { filename: 'user_bad.md', content: 'x' } }]);
    let broken = true;
    const backupHome = vi.fn(async () => '/backup');
    const local = fakeLocal({ backupHome });
    vi.mocked(local.host.restoreMemory).mockImplementation(async (_bot: string, filename: string, raw: string) => {
      if (broken && filename === 'user_bad.md') throw new Error('EBUSY');
      local.memories.set(filename, raw);
    });
    local.setProfile({ status: 'active', displayName: 'Old', description: '' });
    local.memories.set('user_bad.md', 'stale');
    const log = { warn: vi.fn(), info: vi.fn() };
    const { state } = memoryState();
    await expect(materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM, log })).rejects.toThrow('RESTORE_INCOMPLETE');
    expect(log.warn).toHaveBeenCalledWith('Companion content could not be restored', { actorId: 'actor-1', kind: 'memory', code: 'EBUSY' });
    // Not runnable, so the stale file is never uploaded over the cloud value.
    expect(state.bot('bot_mia')?.demoted).toBe(true);
    expect(state.bot('bot_mia')?.prefs['companion.memory.v1:user_ok.md']?.local).toBe(true);
    expect(state.bot('bot_mia')?.prefs['companion.memory.v1:user_bad.md']).toBeUndefined();
    expect(local.host.ensureCanonicalSession).not.toHaveBeenCalled();

    broken = false;
    await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM, log });
    expect(local.memories.get('user_bad.md')).toBe('x');
    expect(state.bot('bot_mia')?.demoted).toBeUndefined();
    // The never-synced copy was backed up once, not again on the retry.
    expect(backupHome).toHaveBeenCalledTimes(1);
  });

  it('stays demoted when the cloud avatar cannot be restored, and backs the copy up only once', async () => {
    const { api } = cloud([profilePref]);
    const backupHome = vi.fn(async () => '/backup');
    const local = fakeLocal({ backupHome, updateProfile: vi.fn(async () => { throw new Error('AVATAR_UNAVAILABLE'); }) });
    local.setProfile({ status: 'active', displayName: 'Old', description: '' });
    const { state } = memoryState();
    const run = () => materializeCompanion({ api, state, host: local.host, actor: { ...actor, avatar: 'https://cdn/a.png' }, roomId: async () => ROOM });
    await expect(run()).rejects.toThrow('AVATAR_UNAVAILABLE');
    await expect(run()).rejects.toThrow('AVATAR_UNAVAILABLE');
    expect(state.bot('bot_mia')?.demoted).toBe(true);
    expect(backupHome).toHaveBeenCalledTimes(1);
  });

  it('stays demoted until the home has uploaded a profile snapshot', async () => {
    const { api } = cloud([{ key: 'companion.memory.v1:user_tea.md', value: { filename: 'user_tea.md', content: 'tea' } }]);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mine', description: 'local only' });
    const { state } = memoryState();
    await expect(materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM })).rejects.toThrow('PROFILE_SNAPSHOT_MISSING');
    expect(state.bot('bot_mia')?.demoted).toBe(true);
    expect(local.host.updateProfile).not.toHaveBeenCalled();
    expect(local.host.createProfile).not.toHaveBeenCalled();
  });

  it('seeds the mirror cursor at the newest own row even under many newer imported history rows', async () => {
    const room = Array.from({ length: 60 }, (_, i) => roomMessage(`m${i}`, i + 1, i % 2 ? 'actor-1' : 'human', `cloud ${i}`, 1_700_000_100_000 + i * 1000));
    const { api } = cloud([profilePref], room);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    local.rows.push({ id: 'own-last', clientId: 'c-own', role: 'assistant', content: 'old local reply', agentMeta: null, createdAt: 1_600_000_000_000 });
    const { state } = memoryState();
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.inserted).toBe(60);
    // The copy's own older conversation is behind the cursor: it never goes up to the room.
    expect(state.bot('bot_mia')?.mirror).toMatchObject({ id: 'own-last', createdAt: 1_600_000_000_000 });
  });

  it('stays demoted when the context rebuild fails, until a retry rebuilds it', async () => {
    const { api } = cloud([profilePref], [roomMessage('m1', 1, 'human', 'hello', 1_700_000_000_000)]);
    const local = fakeLocal({ rebuildContext: vi.fn(async (): Promise<'rebuilt' | 'busy'> => { throw new Error('RECOVERY_FAILED'); }) });
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    const { state } = memoryState();
    await expect(materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM })).rejects.toThrow('RECOVERY_FAILED');
    expect(state.bot('bot_mia')).toMatchObject({ demoted: true, pendingRebuild: true });
    vi.mocked(local.host.rebuildContext).mockResolvedValue('rebuilt');
    const retried = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(retried.rebuild).toBe('rebuilt');
    expect(state.bot('bot_mia')?.demoted).toBeUndefined();
    expect(state.bot('bot_mia')?.pendingRebuild).toBeUndefined();
  });

  it('refuses a profile that is being deleted', async () => {
    const { api } = cloud([profilePref]);
    const local = fakeLocal();
    local.setProfile({ status: 'deleting', displayName: 'Mia', description: '' });
    await expect(materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM })).rejects.toThrow('PROFILE_DELETING');
  });

  it('brings the room\'s files along with the history, and keeps a name for one that cannot come', async () => {
    const withFiles = { ...roomMessage('m1', 1, 'human', 'look', 1_000), content: [{ type: 'text', text: 'look' },
      { type: 'media', mediaId: 'media-1', caption: 'cat.png' }, { type: 'media', mediaId: 'media-2', caption: 'gone.pdf' }] };
    const { api } = cloud([profilePref], [withFiles]);
    const local = fakeLocal();
    const { state } = memoryState();
    const download = vi.fn(async (_room: string, mediaId: string) => {
      if (mediaId === 'media-2') throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      return { name: 'cat.png', category: 'image', mimeType: 'image/png', size: 3, url: 'cindy-media://blobs/x.png', path: null };
    });
    await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM, download });
    expect(download).toHaveBeenCalledWith(ROOM, 'media-1');
    expect(local.host.insertHistory).toHaveBeenCalledWith('session-1', expect.objectContaining({
      text: 'look\n[附件: gone.pdf]', attachments: [expect.objectContaining({ url: 'cindy-media://blobs/x.png' })] }), expect.anything());
  });

  it('fails the take-over while a file may still come, and brings it on the retry', async () => {
    const withFile = { ...roomMessage('m1', 1, 'human', 'look', 1_000), content: [{ type: 'text', text: 'look' },
      { type: 'media', mediaId: 'media-1', caption: 'cat.png' }] };
    const { api } = cloud([profilePref], [withFile]);
    const local = fakeLocal();
    const { state } = memoryState();
    let online = false;
    const download = vi.fn(async () => {
      if (!online) throw new Error('MEDIA_DOWNLOAD_FAILED');
      return { name: 'cat.png', category: 'image', mimeType: 'image/png', size: 3, url: 'cindy-media://blobs/x.png', path: null };
    });
    await expect(materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM, download })).rejects.toThrow('MEDIA_DOWNLOAD_FAILED');
    expect(local.host.insertHistory).not.toHaveBeenCalled();
    expect(state.bot('bot_mia')?.demoted).toBe(true);
    online = true;
    await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM, download });
    expect(local.host.insertHistory).toHaveBeenCalledWith('session-1', expect.objectContaining({
      text: 'look', attachments: [expect.objectContaining({ url: 'cindy-media://blobs/x.png' })] }), expect.anything());
  });

  it('imports the whole room, in message-time order', async () => {
    // The second page holds older history that arrived later (seq after the first page).
    const page1 = Array.from({ length: 100 }, (_, i) => roomMessage(`n${i}`, 300 - i, 'human', `new ${i}`, 50_000 - i));
    const page2 = [roomMessage('old', 100, 'human', 'oldest', 1_000)];
    const { api } = fakeApi((route, method) => {
      if (route === '/preferences' && method === 'GET') return [{ ...profilePref, revision: 1 }];
      if (route.startsWith(`/conversations/${ROOM}/messages?`)) return route.includes('before=') ? page2 : page1;
      throw new Error(`unexpected ${method} ${route}`);
    });
    const local = fakeLocal();
    const { state } = memoryState();
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.inserted).toBe(101);
    expect(local.rows[0]!.content).toBe('oldest');
  });

  it('brings todos, routines and the workbench along in one batch each; a routine tombstone removes it, a todo one keeps it', async () => {
    const todo = { id: 'todo:1', title: 'Compare quotes', history: [] };
    const routine = { id: 'routine-1', input: { name: 'Daily', prompt: 'p', enabled: true, triggers: [] }, originDeviceId: 'laptop' };
    const workbench = { directories: [{ path: '/projects/game', addedAt: 'x', deviceId: 'laptop' }], tasks: {} };
    const { api } = cloud([profilePref, { key: 'companion.todo.v1:todo:1', value: todo }, { key: 'companion.todo.v1:todo:gone', value: null },
      { key: 'companion.routine.v1:routine-1', value: routine }, { key: 'companion.routine.v1:routine-gone', value: null },
      { key: 'companion.workbench.v1', value: workbench }]);
    const applyTodos = vi.fn(async () => undefined);
    const applyRoutines = vi.fn(async () => undefined);
    const applyWorkbench = vi.fn(async () => undefined);
    const local = fakeLocal({ applyTodos, applyRoutines, applyWorkbench });
    const { state } = memoryState();
    await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    // A todo tombstone only means it left the travelling window: this computer keeps its copy.
    expect(applyTodos).toHaveBeenCalledWith('bot_mia', [todo], [], expect.anything());
    expect(applyRoutines).toHaveBeenCalledWith('bot_mia', [routine], ['routine-gone'], expect.anything());
    expect(applyWorkbench).toHaveBeenCalledWith('bot_mia', workbench, expect.anything(), { replace: false });
    // Applied keys may be tombstoned later by this computer.
    expect(state.bot('bot_mia')?.prefs['companion.todo.v1:todo:1']?.local).toBe(true);
  });

  it('lets the cloud workbench replace one this computer synced before, a tombstone included; an unsynced one joins', async () => {
    const { api } = cloud([profilePref, { key: 'companion.workbench.v1', value: null }]);
    const applyWorkbench = vi.fn(async () => undefined);
    const synced = memoryState();
    synced.state.update('bot_mia', actor.id, entry => { entry.prefs['companion.workbench.v1'] = { hash: 'old', revision: 2, local: true }; });
    await materializeCompanion({ api, state: synced.state, host: fakeLocal({ applyWorkbench }).host, actor, roomId: async () => ROOM });
    expect(applyWorkbench).toHaveBeenCalledWith('bot_mia', null, expect.anything(), { replace: true });
    expect(synced.state.bot('bot_mia')?.prefs['companion.workbench.v1']?.hash).not.toBe('old');
    applyWorkbench.mockClear();
    await materializeCompanion({ api, state: memoryState().state, host: fakeLocal({ applyWorkbench }).host, actor, roomId: async () => ROOM });
    expect(applyWorkbench).not.toHaveBeenCalled();
  });

  it('stays demoted and retries when the routines cannot be restored', async () => {
    const { api } = cloud([profilePref, { key: 'companion.routine.v1:r', value: { id: 'r', input: { triggers: [] } } }]);
    const local = fakeLocal({ applyRoutines: vi.fn(async () => { throw new Error('ROUTINES_UNAVAILABLE'); }) });
    const { state } = memoryState();
    await expect(materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM })).rejects.toThrow('RESTORE_INCOMPLETE');
    expect(state.bot('bot_mia')?.demoted).toBe(true);
  });

  describe('capability setup', () => {
    const capabilitiesPref = (value: unknown) => ({ key: 'companion.capabilities.v1', value });
    const setup = (overrides: Parameters<typeof fakeLocal>[0] = {}) => {
      const local = fakeLocal({ applyCapabilities: vi.fn(async () => []), ...overrides });
      return { local, state: memoryState().state };
    };

    it('applies the cloud setup to a new copy, which gets the default permission level and says so', async () => {
      const { api } = cloud([{ ...profilePref, value: { ...profilePref.value, templateId: 'cindy' } },
        capabilitiesPref({ skills: ['a'], skillMode: 'allowlist', mcpServers: ['gone-here'], mcpMode: 'allowlist', memory: false, permissions: 'trusted' })]);
      const { local, state } = setup();
      const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
      expect(local.host.createProfile).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'cindy' }), expect.anything());
      // Whatever the cloud holds is handed over as read; the permission level is not part of it.
      expect(local.host.applyCapabilities).toHaveBeenCalledWith('bot_mia',
        { skills: ['a'], skillMode: 'allowlist', mcpServers: ['gone-here'], mcpMode: 'allowlist', memory: false }, expect.anything());
      expect(result.notices).toEqual(['permissions']);
      expect(state.bot('bot_mia')?.arrivalNotices).toEqual(['permissions']);
      expect(state.bot('bot_mia')?.prefs['companion.capabilities.v1']).toMatchObject({ local: true });
    });

    it('also tells when a saved model could not be kept, but not about permissions of a copy that already existed', async () => {
      const { api } = cloud([profilePref, capabilitiesPref({ modelChain: [{ harness: 'codex', model: 'gpt-x', providerId: 'p', effort: '', fastMode: false }] })]);
      const { local, state } = setup({ applyCapabilities: vi.fn(async () => ['model' as const]) });
      local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
      const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
      expect(result.notices).toEqual(['model']);
      expect(state.bot('bot_mia')?.arrivalNotices).toEqual(['model']);
    });

    it('keeps the copy as it is when the home predates the setup (no key), or the value is not an object', async () => {
      for (const prefs of [[profilePref], [profilePref, capabilitiesPref('nope')], [profilePref, capabilitiesPref(null)]]) {
        const { api } = cloud(prefs);
        const { local, state } = setup();
        local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
        const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
        expect(local.host.applyCapabilities).not.toHaveBeenCalled();
        expect(result.notices).toEqual([]);
        expect(state.bot('bot_mia')?.arrivalNotices).toBeUndefined();
      }
    });

    it('stays demoted when the setup cannot be applied, and still remembers the permission reset on the retry', async () => {
      const { api } = cloud([profilePref, capabilitiesPref({ memory: true })]);
      let fail = true;
      const { local, state } = setup({ applyCapabilities: vi.fn(async () => { if (fail) throw new Error('DB_BUSY'); return []; }) });
      await expect(materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM })).rejects.toThrow('RESTORE_INCOMPLETE');
      expect(state.bot('bot_mia')?.demoted).toBe(true);
      // The copy exists now, so the retry no longer sees it as new.
      fail = false;
      const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
      expect(result.notices).toEqual(['permissions']);
      expect(state.bot('bot_mia')?.demoted).toBeUndefined();
    });
  });

  it('brings the files a companion reply refers to, written into the reply on this computer', async () => {
    const answer = { ...roomMessage('m2', 2, 'actor-1', '做好了 documents/report.docx', 2_000), content: [{ type: 'text', text: '做好了 documents/report.docx' },
      { type: 'media', mediaId: 'media-9', caption: 'report.docx' }] };
    const { api } = cloud([profilePref], [answer]);
    const local = fakeLocal();
    const download = vi.fn(async () => ({ name: 'report.docx', category: 'file', mimeType: 'application/octet-stream', size: 3, url: null, path: '/attachments/media-9/report.docx' }));
    await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM, download });
    expect(local.host.insertHistory).toHaveBeenCalledWith('session-1', expect.objectContaining({
      role: 'assistant', attachments: [expect.objectContaining({ path: '/attachments/media-9/report.docx' })] }), expect.anything());
  });
});

