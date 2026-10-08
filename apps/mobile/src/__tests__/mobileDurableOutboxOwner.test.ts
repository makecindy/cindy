import { beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '../auth/authOwnerGeneration';
import type { DurableOutboxRecord } from '../session/durableOutbox';

const mocks = vi.hoisted(() => ({ discard: vi.fn(), removeFiles: vi.fn(async () => {}), data: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getAllKeys: async () => [...mocks.data.keys()],
  getItem: async (key: string) => mocks.data.get(key) ?? null,
  setItem: async (key: string, value: string) => { mocks.data.set(key, value); },
  removeItem: async (key: string) => { mocks.data.delete(key); },
} }));
vi.mock('../session/durableOutboxFiles', () => ({ durableOutboxUploadUri: vi.fn(), removeOutboxFiles: mocks.removeFiles }));
vi.mock('../session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: mocks.discard }));
import { cleanupOutboxResources, discardOutboxUploads, getCurrentMobileOutboxRecords, mobileDurableOutbox, persistCancelledCreationDraft } from '../session/mobileDurableOutbox';

function record(): DurableOutboxRecord {
  return { version: 1, accountId: getMobileAuthOwner().accountKey, deviceId: 'mac', createdAt: 1,
    state: 'queued', uploads: [], item: { clientId: 'message', sessionId: 'task',
      text: 'draft', quotesEncoded: false, agentReferences: [], pastedTextRanges: [],
      slashCommandRanges: [], permissionModeAtSend: 'ask', slotMeta: [], slotByLocalId: {},
      waitingIds: [], failedIds: [], enqueueError: null, phase: 'uploading',
      attachmentSlots: [{ id: 'attachment', path: 'oss-ref', name: 'photo.png', ext: 'png',
        size: 1, category: 'image', mimeType: 'image/png' }],
    } };
}
beforeEach(async () => {
  setMobileAuthOwner(null);
  await mobileDurableOutbox.activate('');
  mocks.data.clear();
  mocks.discard.mockReset();
  mocks.removeFiles.mockReset();
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
});

it('persists cancellation for only the matching device and restores it after a cold activation', async () => {
  const own = record();
  own.creation = { draft: { workingDir: '/repo/.cindy-worktrees/failed', firstMessage: 'draft' } as NonNullable<DurableOutboxRecord['creation']>['draft'],
    originalWorkingDir: '/repo', deviceName: 'PC', planModeArm: false, restorePermissionMode: null };
  await mobileDurableOutbox.add(own);
  const other = { ...own, deviceId: 'other-device' };
  await mobileDurableOutbox.add(other);
  await persistCancelledCreationDraft({ sessionId: 'task', deviceId: 'mac' });
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const restored = getCurrentMobileOutboxRecords().find((r) => r.deviceId === 'mac')!;
  expect(restored).toMatchObject({ suspended: true, state: 'failed', item: own.item,
    creation: { cancelled: true, draft: { workingDir: '/repo', firstMessage: 'draft' } } });
  expect(getCurrentMobileOutboxRecords().find((r) => r.deviceId === 'other-device')).toEqual(other);
});

it('does not cancel another account draft when the owner switches during activation', async () => {
  await mobileDurableOutbox.add(record());
  const original = new Map(mocks.data);
  const pending = persistCancelledCreationDraft({ sessionId: 'task', deviceId: 'mac' });
  setMobileAuthOwner('bob', 'global');
  await expect(pending).rejects.toThrow('OUTBOX_OWNER_CHANGED');
  expect(mocks.data).toEqual(original);
});

it('still disposes confirmed-cancelled uploads when local deletion rejects', async () => {
  mocks.removeFiles.mockRejectedValueOnce(new Error('filesystem unavailable'));
  await expect(cleanupOutboxResources(record(), getMobileAuthOwner(), async () => 'token', true)).rejects.toThrow('filesystem unavailable');
  expect(mocks.discard).toHaveBeenCalledOnce();
  expect(await mocks.discard.mock.calls[0]![1].getToken()).toBe('token');
});

it('never disposes host-owned uploads even when local deletion rejects', async () => {
  mocks.removeFiles.mockRejectedValueOnce(new Error('filesystem unavailable'));
  await expect(cleanupOutboxResources(record(), getMobileAuthOwner(), async () => 'token', false)).rejects.toThrow('filesystem unavailable');
  expect(mocks.discard).not.toHaveBeenCalled();
});

it('hides the old realm ledger synchronously before the bridge activates the new owner', async () => {
  await mobileDurableOutbox.add(record());
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  setMobileAuthOwner('alice', 'cn');
  expect(mobileDurableOutbox.getSnapshot()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()).toEqual([]);
});

it('keeps cleanup-only rows durable but hides them from sending and creation recovery views', async () => {
  await mobileDurableOutbox.add(record());
  await mobileDurableOutbox.update(mobileDurableOutbox.getSnapshot()[0]!, { state: 'host-owned', cleanupOutcome: 'cancelled' });
  expect(mobileDurableOutbox.getSnapshot()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()).toEqual([]);
});

it('does not use a token that arrives after a same-membership realm switch', async () => {
  let resolve!: (token: string) => void;
  const token = new Promise<string>((done) => { resolve = done; });
  const getToken = vi.fn(() => token);
  discardOutboxUploads(record(), getMobileAuthOwner(), getToken);
  const readToken = mocks.discard.mock.calls[0]![1].getToken as () => Promise<string | null>;
  const pending = readToken();
  setMobileAuthOwner('alice', 'cn');
  resolve('old-realm-token');
  expect(await pending).toBeNull();
  expect(await readToken()).toBeNull();
  expect(getToken).toHaveBeenCalledOnce();
});

it('uses the current owner token for confirmed cancellation and refuses a different owner record', async () => {
  const own = record();
  discardOutboxUploads(own, getMobileAuthOwner(), async () => 'token');
  expect(await mocks.discard.mock.calls[0]![1].getToken()).toBe('token');
  setMobileAuthOwner('alice', 'cn');
  discardOutboxUploads(own, getMobileAuthOwner(), async () => 'other-token');
  expect(mocks.discard).toHaveBeenCalledOnce();
});
