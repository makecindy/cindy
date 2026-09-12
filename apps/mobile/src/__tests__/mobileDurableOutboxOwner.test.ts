import { beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '../auth/authOwnerGeneration';
import type { DurableOutboxRecord } from '../session/durableOutbox';

const mocks = vi.hoisted(() => ({ discard: vi.fn(), data: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getAllKeys: async () => [...mocks.data.keys()],
  getItem: async (key: string) => mocks.data.get(key) ?? null,
  setItem: async (key: string, value: string) => { mocks.data.set(key, value); },
  removeItem: async (key: string) => { mocks.data.delete(key); },
} }));
vi.mock('../session/durableOutboxFiles', () => ({ durableOutboxUploadUri: vi.fn() }));
vi.mock('../session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: mocks.discard }));
import { discardCancelledOutboxUploads, getCurrentMobileOutboxRecords, mobileDurableOutbox } from '../session/mobileDurableOutbox';

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
  mocks.data.clear();
  mocks.discard.mockReset();
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
});

it('hides the old realm ledger synchronously before the bridge activates the new owner', async () => {
  await mobileDurableOutbox.add(record());
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  setMobileAuthOwner('alice', 'cn');
  expect(mobileDurableOutbox.getSnapshot()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()).toEqual([]);
});

it('does not use a token that arrives after a same-membership realm switch', async () => {
  let resolve!: (token: string) => void;
  const token = new Promise<string>((done) => { resolve = done; });
  const getToken = vi.fn(() => token);
  discardCancelledOutboxUploads(record(), getMobileAuthOwner(), getToken);
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
  discardCancelledOutboxUploads(own, getMobileAuthOwner(), async () => 'token');
  expect(await mocks.discard.mock.calls[0]![1].getToken()).toBe('token');
  setMobileAuthOwner('alice', 'cn');
  discardCancelledOutboxUploads(own, getMobileAuthOwner(), async () => 'other-token');
  expect(mocks.discard).toHaveBeenCalledOnce();
});
