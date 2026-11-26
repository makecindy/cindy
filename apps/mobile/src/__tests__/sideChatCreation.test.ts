import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { flushComposerDraftWrites, readComposerDraftSync, saveComposerDraft } from '@/session/composerDraftStore';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { readPendingSideChats, runSideChatCreation, startSideChatCreation } from '@/session/sideChatCreation';
import type { RemoteSession } from '@/session/types';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
  removeItem: async (key: string) => { storage.delete(key); },
} }));
vi.mock('@/session/newSessionCreation', () => ({ createNewSessionId: () => randomUUID() }));

const parent: RemoteSession = {
  id: 'main', userId: 'user', title: 'Task', workingDir: '/project', workspaceKind: 'project',
  agentKind: 'cc', model: 'selected', effort: 'high', permissionMode: 'default', fastMode: false,
  status: 'active', userSendAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const device = { deviceId: 'computer', deviceName: 'Mac' };
const noHostChildren = new Set<string>();
function slowFork() {
  let finish!: (row: RemoteSession) => void;
  const createSideChat = vi.fn((_parent: string, _id?: string) =>
    new Promise<RemoteSession>(resolve => { finish = resolve; }));
  return { createSideChat, acknowledge: (id: string) => finish({ ...parent, id, parentSessionId: parent.id, source: 'side-chat' }) };
}
beforeEach(() => {
  storage.clear();
  setMobileAuthOwner(parent.userId);
  remoteSessionStore.clear();
});

// Unit, mobile counterpart of #12799. A normal task snapshot cannot exercise
// editing before a host fork, losing its receipt, or restoring its identity.
it('opens a writable child before the fork replies, retains the draft and binds the same session', async () => {
  const maker = slowFork();
  const preview = startSideChatCreation(parent, device, maker);
  expect(remoteSessionStore.getSessions()).toContainEqual(expect.objectContaining({
    id: preview.id, model: parent.model, pendingLocalCreation: true,
  }));
  saveComposerDraft(preview.id, '追问');
  await vi.waitFor(() => expect(maker.createSideChat).toHaveBeenCalledExactlyOnceWith(parent.id, preview.id));
  await runSideChatCreation(preview, device, maker);
  expect(maker.createSideChat).toHaveBeenCalledOnce();
  expect((await readPendingSideChats(parent, device.deviceId, noHostChildren)).map(row => row.id)).toEqual([preview.id]);
  maker.acknowledge(preview.id);
  await vi.waitFor(() => expect(remoteSessionStore.getSessions()[0].pendingLocalCreation).toBeUndefined());
  expect(readComposerDraftSync(preview.id)).toBe('追问');
  await flushComposerDraftWrites(preview.id);
  expect(await readPendingSideChats(parent, device.deviceId, noHostChildren)).toEqual([]);
});

it('recovers a failed fork after leaving, then retries it without creating a second child', async () => {
  const failed = { createSideChat: vi.fn().mockRejectedValue(new Error('NO_PRIOR_ASSISTANT')) };
  const preview = startSideChatCreation(parent, device, failed);
  await vi.waitFor(() => expect(remoteSessionStore.getSessions()[0].sideChatCreationError).toBe('session.sideChat.waitForReply'));
  remoteSessionStore.clear();
  expect(await readPendingSideChats(parent, 'other-device', noHostChildren)).toEqual([]);
  const [restored] = await readPendingSideChats(parent, device.deviceId, noHostChildren);
  expect(restored).toMatchObject({ id: preview.id, pendingLocalCreation: true, sideChatCreationError: 'session.sideChat.createFailed' });
  const retry = slowFork();
  const finished = runSideChatCreation(restored, device, retry);
  await vi.waitFor(() => expect(retry.createSideChat).toHaveBeenCalledExactlyOnceWith(parent.id, preview.id));
  retry.acknowledge(preview.id);
  await finished;
  expect(remoteSessionStore.getSessions().map(row => row.id)).toEqual([preview.id]);
});

it('ignores an old account’s late reply and keeps its unfinished IDs private', async () => {
  const maker = slowFork();
  const preview = startSideChatCreation(parent, device, maker);
  await vi.waitFor(() => expect(maker.createSideChat).toHaveBeenCalledOnce());
  setMobileAuthOwner('other');
  remoteSessionStore.clear();
  maker.acknowledge(preview.id);
  expect(await readPendingSideChats(parent, device.deviceId, noHostChildren)).toEqual([]);
  expect(remoteSessionStore.getSessions()).toEqual([]);
});
