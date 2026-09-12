import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedSharePayload } from 'expo-sharing';
import { getMobileAuthOwner, setMobileAuthOwner, __testing as authOwnerTesting } from '@/auth/authOwnerGeneration';

import {
  __resetIncomingShareForTest,
  consumeIncomingShareBatch,
  incomingShareBatchId,
  selectIncomingShareUploadCandidates,
  stageIncomingShareBatch,
  receiveIncomingShare,
  watchIncomingShareAccount,
} from '@/session/incomingShare';

const convertToJpeg = vi.fn(async (uri: string) => `${uri}.jpg`);
const deleteAsync = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('expo-file-system/legacy', () => ({ deleteAsync }));

vi.mock('@/session/pastedImageAttachment', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/session/pastedImageAttachment')>();
  return {
    ...original,
    resolvePastedImageAsset: async (uri: string, index: number) => {
      const classified = original.classifyPastedImageUri(uri);
      if (classified.needsJpegConversion) {
        return {
          uri: await convertToJpeg(uri),
          fileName: `pasted-image-${index + 1}.jpg`,
          mimeType: 'image/jpeg',
        };
      }
      return original.resolvePastedImageAsset(uri, index);
    },
  };
});

function payload(
  patch: Partial<ResolvedSharePayload>,
): ResolvedSharePayload {
  return {
    value: 'file:///shared/report.pdf',
    shareType: 'file',
    mimeType: 'application/pdf',
    contentUri: 'file:///shared/report.pdf',
    contentType: 'file',
    contentMimeType: 'application/pdf',
    originalName: 'report.pdf',
    contentSize: 1024,
    ...patch,
  } as ResolvedSharePayload;
}

describe('incoming Share Extension payloads', () => {
  beforeEach(() => {
    __resetIncomingShareForTest();
    authOwnerTesting.reset();
    setMobileAuthOwner('account-a');
    deleteAsync.mockClear();
    convertToJpeg.mockClear();
  });

  it('converts non-sendable iOS image formats before entering the attachment uploader', async () => {
    const result = selectIncomingShareUploadCandidates([
      payload({
        value: 'file:///shared/IMG_0001.HEIC',
        shareType: 'image',
        mimeType: 'image/heic',
        contentUri: 'file:///shared/IMG_0001.HEIC',
        contentType: 'image',
        contentMimeType: 'image/heic',
        originalName: 'IMG_0001.HEIC',
      }),
    ]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: 'image',
      name: 'IMG_0001.HEIC',
      mimeType: 'image/heic',
    });
    await expect(result.candidates[0]!.resolve!()).resolves.toEqual({
      uri: 'file:///shared/IMG_0001.HEIC.jpg',
      name: 'IMG_0001.jpg',
      mimeType: 'image/jpeg',
      size: 0,
      skipPreprocess: true,
    });
    expect(convertToJpeg).toHaveBeenCalledWith('file:///shared/IMG_0001.HEIC');
  });

  it('converts supported files and images into the existing attachment upload candidates', () => {
    const result = selectIncomingShareUploadCandidates([
      payload({}),
      payload({
        value: 'file:///shared/screenshot.png',
        shareType: 'image',
        mimeType: 'image/png',
        contentUri: 'file:///shared/screenshot.png',
        contentType: 'image',
        contentMimeType: 'image/png',
        originalName: 'screenshot.png',
        contentSize: 2048,
      }),
    ]);

    expect(result).toEqual({
      candidates: [
        {
          kind: 'file',
          uri: 'file:///shared/report.pdf',
          name: 'report.pdf',
          size: 1024,
          mimeType: 'application/pdf',
        },
        {
          kind: 'image',
          uri: 'file:///shared/screenshot.png',
          name: 'screenshot.png',
          size: 2048,
          mimeType: 'image/png',
        },
      ],
      rejectedUris: [],
    });
  });

  it('falls back to a decoded URI basename and rejects unsupported attachment types', () => {
    const result = selectIncomingShareUploadCandidates([
      payload({
        contentUri: 'file:///shared/My%20Notes.md',
        originalName: null,
        contentSize: null,
        contentMimeType: null,
        mimeType: 'text/markdown',
      }),
      payload({
        value: 'file:///shared/archive.zip',
        contentUri: 'file:///shared/archive.zip',
        originalName: 'archive.zip',
      }),
    ]);

    expect(result.candidates).toEqual([{
      kind: 'file',
      uri: 'file:///shared/My%20Notes.md',
      name: 'My Notes.md',
      size: 0,
      mimeType: 'text/markdown',
    }]);
    expect(result.rejectedUris).toEqual(['file:///shared/archive.zip']);
  });

  it('keeps a batch until the matching consumer acknowledges it exactly once', () => {
    const acknowledge = vi.fn();
    const shared = [payload({})];
    const first = stageIncomingShareBatch(shared, acknowledge);
    const duplicate = stageIncomingShareBatch(shared, vi.fn());

    expect(first?.id).toBe(incomingShareBatchId(shared));
    expect(duplicate).toBe(first);
    expect(consumeIncomingShareBatch('wrong-id')).toBe(false);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(consumeIncomingShareBatch(first!.id)).toBe(true);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(consumeIncomingShareBatch(first!.id)).toBe(false);
  });

  it('retains successive shares during login and does not clear the newer native slot', () => {
    setMobileAuthOwner(null);
    let raw = [{ value: 'file:///group/cindy-share-a/report.pdf', shareType: 'file' as const }];
    const native = { getSharedPayloads: () => raw, clearSharedPayloads: vi.fn((expected) => {
      if (expected === raw) raw = [];
    }) };
    receiveIncomingShare(native);
    const first = stageIncomingShareBatch([payload({
      value: raw[0]!.value, contentUri: raw[0]!.value, mimeType: undefined,
      contentMimeType: null, contentSize: null,
    })], vi.fn())!;
    raw = [{ value: 'file:///group/cindy-share-b/report.pdf', shareType: 'file' }];
    receiveIncomingShare(native);
    receiveIncomingShare(native);
    expect(consumeIncomingShareBatch(first.id)).toBe(false);
    setMobileAuthOwner('account-a');
    expect(consumeIncomingShareBatch(first.id)).toBe(true);
    expect(native.clearSharedPayloads).toHaveBeenCalledTimes(1);
    expect(consumeIncomingShareBatch(first.id)).toBe(false);
    const secondId = incomingShareBatchId([payload({
      value: raw[0]!.value, contentUri: raw[0]!.value, mimeType: undefined,
      contentMimeType: null, contentSize: null,
    })]);
    expect(consumeIncomingShareBatch(secondId)).toBe(true);
    expect(native.clearSharedPayloads).toHaveBeenCalledTimes(2);
  });

  it('never treats remote URLs as local upload/cleanup targets', () => {
    expect(selectIncomingShareUploadCandidates([payload({ contentUri: 'https://example.com/report.pdf' })]))
      .toEqual({ candidates: [], rejectedUris: [] });
  });

  it.each(['switch', 'logout', 'same-account-relogin', 'realm-switch'])('discards received shares on %s', async (transition) => {
    const acknowledge = vi.fn();
    const batch = stageIncomingShareBatch([payload({})], acknowledge)!;
    if (transition === 'switch') setMobileAuthOwner('account-b');
    else if (transition === 'realm-switch') setMobileAuthOwner('account-a', 'cn');
    else {
      setMobileAuthOwner(null);
      if (transition === 'same-account-relogin') setMobileAuthOwner('account-a');
    }
    expect(consumeIncomingShareBatch(batch.id)).toBe(false);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deleteAsync).toHaveBeenCalledWith('file:///shared/report.pdf', { idempotent: true }));
  });

  it('keeps shares across a same-account refresh, but not first-login then switch', () => {
    const batch = stageIncomingShareBatch([payload({})], vi.fn())!;
    setMobileAuthOwner('account-a');
    expect(consumeIncomingShareBatch(batch.id)).toBe(true);
    setMobileAuthOwner(null);
    const loggedOutBatch = stageIncomingShareBatch([payload({})], vi.fn())!;
    setMobileAuthOwner('account-a');
    setMobileAuthOwner('account-b');
    expect(consumeIncomingShareBatch(loggedOutBatch.id)).toBe(false);
  });

  it('clears an unobserved native slot on switch and allows new shares for the new account', () => {
    let raw = [{ value: 'file:///shared/report.pdf', shareType: 'file' as const }];
    const native = { getSharedPayloads: () => raw, clearSharedPayloads: vi.fn(() => { raw = []; }) };
    const stop = watchIncomingShareAccount(native);
    setMobileAuthOwner('account-b');
    expect(raw).toEqual([]);
    raw = [{ value: 'file:///shared/new.pdf', shareType: 'file' }];
    receiveIncomingShare(native);
    const batch = stageIncomingShareBatch([payload({
      value: raw[0]!.value, contentUri: raw[0]!.value, originalName: 'new.pdf',
      contentSize: null, contentMimeType: null, mimeType: undefined,
    })], vi.fn())!;
    expect(batch.owner.accountId).toBe('account-b');
    expect(consumeIncomingShareBatch(batch.id)).toBe(true);
    expect(raw).toEqual([]);
    stop();
  });

  it('does not reassign native files when login and switch happen during module loading', () => {
    setMobileAuthOwner(null);
    const initialOwner = getMobileAuthOwner();
    setMobileAuthOwner('account-a');
    setMobileAuthOwner('account-b');
    const native = { getSharedPayloads: () => [], clearSharedPayloads: vi.fn() };
    const stop = watchIncomingShareAccount(native, initialOwner);
    expect(native.clearSharedPayloads).toHaveBeenCalledOnce();
    stop();
  });
});
