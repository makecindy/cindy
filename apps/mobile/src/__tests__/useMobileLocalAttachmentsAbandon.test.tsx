// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSerializedAttachment } from '@/session/types';
import type { MobileLocalAttachmentUploadCandidate } from '@/session/mobileLocalAttachmentUpload';
import { useComposerImageExpansion } from '@/session/useComposerImageExpansion';
import {
  useMobileLocalAttachments,
  type UseMobileLocalAttachmentsOptions,
  type UseMobileLocalAttachmentsResult,
} from '@/session/useMobileLocalAttachments';

const runtime = vi.hoisted(() => ({
  uploads: [] as Array<{ name: string; resolve: () => void }>,
  discarded: [] as unknown[],
  pickPhotos: vi.fn(),
  pickCamera: vi.fn(),
  pickDocument: vi.fn(),
  durablePreviewUri: null as string | null,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-i18next', async (importOriginal) => {
  const t = (key: string) => key;
  return { ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t }) };
});
vi.mock('expo-document-picker', () => ({ getDocumentAsync: runtime.pickDocument }));
vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  launchCameraAsync: runtime.pickCamera,
}));
vi.mock('@/session/deferredPhotoLibrary', () => ({ pickDeferredLibraryPhotos: runtime.pickPhotos }));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  deleteAsync: async () => undefined,
}));
vi.mock('@/session/durableOutboxFiles', () => ({
  retainComposerAttachmentFile: async (_owner: string, id: string) => `file:///stage/${id}`,
}));
vi.mock('@/session/sentAttachmentThumbStore', () => ({
  getSentAttachmentThumbUri: () => runtime.durablePreviewUri,
  registerSentAttachmentThumb: async () => undefined,
}));
vi.mock('@/session/mobileAttachmentUpload', () => ({
  statMobileAttachmentFileSize: async () => 1000,
  discardMobileUploadedAttachment: (attachment: unknown) => { runtime.discarded.push(attachment); },
  uploadMobileAttachmentFromFile: (candidate: { name: string }) => new Promise((resolve) => {
    runtime.uploads.push({
      name: candidate.name,
      resolve: () => resolve({
        id: `att-${candidate.name}`,
        name: candidate.name,
        path: `cindy-oss-attach://key/${candidate.name}`,
        ext: '.png',
        size: 1000,
        category: 'image',
        mimeType: 'image/png',
      }),
    });
  }),
}));

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.uploads = [];
  runtime.discarded = [];
  runtime.pickPhotos.mockReset();
  runtime.pickCamera.mockReset();
  runtime.pickDocument.mockReset();
  runtime.durablePreviewUri = null;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

function mount(scopeKey: string) {
  const options: UseMobileLocalAttachmentsOptions = {
    attachmentScopeKey: scopeKey,
    getAccessToken: async () => 'token',
    getAttachmentCount: () => 0,
    onUploaded: vi.fn(),
    onError: vi.fn(),
    onPicked: vi.fn(),
  };
  const results: UseMobileLocalAttachmentsResult[] = [];
  let expansion!: ReturnType<typeof useComposerImageExpansion>;
  function Harness({ scope }: { scope: string }) {
    const local = useMobileLocalAttachments({ ...options, attachmentScopeKey: scope });
    results.push(local);
    expansion = useComposerImageExpansion(
      local.pendingUploads.filter((item) => item.kind === 'image').length + local.pastePlaceholderCount,
      local.imageSelectionRevision,
    );
    return null;
  }
  act(() => root.render(<Harness scope={scopeKey} />));
  return {
    options,
    first: results[0],
    latest: () => results.at(-1)!,
    expansion: () => expansion,
    rerender: (scope: string) => act(() => root.render(<Harness scope={scope} />)),
  };
}

const imageCandidate = (name: string, onAbandoned: () => void): MobileLocalAttachmentUploadCandidate => ({
  kind: 'image',
  uri: `file:///cache/annotation-burned/${name}`,
  name,
  size: 1000,
  mimeType: 'image/png',
  onAbandoned,
});
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('useMobileLocalAttachments abandonment on scope change', () => {
  it.each(['paste', 'upload'])('reports %s input synchronously before React commits the tray', async kind => {
    const harness = mount('session-a');
    expect(harness.first.hasAttachmentInput()).toBe(false);
    act(() => {
      if (kind === 'paste') harness.first.beginPastePlaceholders(1);
      else harness.first.enqueueUploads([imageCandidate('a.png', vi.fn())], { token: 'token' });
      expect(harness.first.hasAttachmentInput()).toBe(true);
    });
    act(() => harness.first.discardAllPendingUploadsForScopeChange());
    expect(harness.first.hasAttachmentInput()).toBe(false);
  });

  // PR #6291: unit integration through the real selection/upload and expansion
  // hooks. Count-only tests miss a completion and addition in the same render.
  it('reopens for a new selection during completion but not for paste materialization or retry', async () => {
    const harness = mount('session-a');
    act(() => harness.latest().enqueueUploads([imageCandidate('first.png', vi.fn())], { token: 'token' }));
    await act(async () => { await flush(); });
    expect(harness.expansion().active).toBe(true);
    act(() => harness.expansion().collapse());
    await act(async () => {
      runtime.uploads[0].resolve();
      await harness.latest().waitForPendingUploads();
      harness.latest().enqueueUploads([imageCandidate('next.png', vi.fn())], { token: 'token' });
      await flush();
    });
    expect(harness.latest().pendingUploads).toHaveLength(1);
    expect(harness.expansion().active).toBe(true);
    act(() => harness.expansion().collapse());
    act(() => harness.latest().beginPastePlaceholders(1));
    expect(harness.expansion().active).toBe(true);
    act(() => harness.expansion().collapse());
    // Keep this upload at the token boundary, without native file conversion.
    harness.options.getAccessToken = () => new Promise(() => {});
    harness.rerender('session-a');
    await act(async () => { await harness.latest().addPastedImages(['file:///cache/paste.png']); });
    expect(harness.latest().pastePlaceholderCount).toBe(0);
    expect(harness.expansion().active).toBe(false);
    act(() => harness.latest().beginPastePlaceholders(1));
    expect(harness.expansion().active).toBe(true);
    act(() => harness.expansion().collapse());
    act(() => {
      harness.latest().failPastePlaceholders();
      harness.latest().beginPastePlaceholders(1);
    });
    expect(harness.expansion().active).toBe(true);
    act(() => harness.latest().failPastePlaceholders());
    act(() => harness.expansion().collapse());
    // Direct paste (without a loading event) is a new selection as well.
    await act(async () => { await harness.latest().addPastedImages(['file:///cache/direct.png']); });
    expect(harness.expansion().active).toBe(true);
    act(() => harness.latest().discardAllPendingUploads());
    await act(async () => {
      harness.latest().enqueueUploads([imageCandidate('failed.png', vi.fn())], { token: Promise.resolve(null) });
      await harness.latest().waitForPendingUploads();
    });
    expect(harness.latest().pendingUploads[0].failed).toBe(true);
    act(() => harness.expansion().collapse());
    act(() => harness.latest().retryPendingUpload(harness.latest().pendingUploads[0].localId));
    expect(harness.latest().pendingUploads[0].failed).toBeFalsy();
    expect(harness.expansion().active).toBe(false);
  });

  // PR #6291: the real upload hook must publish the local-id handoff before
  // reclaiming a pasted source. Tray-only tests cannot prove this ordering.
  it('keeps upload identity resolvable after source cleanup and releases it with the attachment', async () => {
    const harness = mount('session-a');
    runtime.durablePreviewUri = 'file:///durable/pasted.png';
    let localId = '';
    let attachmentAtCleanup: string | undefined;
    let deliveriesAtCleanup = 0;
    const cleanup = vi.fn(async () => {
      attachmentAtCleanup = harness.latest().getUploadedAttachmentId(localId);
      deliveriesAtCleanup = vi.mocked(harness.options.onUploaded).mock.calls.length;
    });
    act(() => harness.first.enqueueUploads([{
      ...imageCandidate('pasted.png', vi.fn()), cleanupLocalUris: cleanup,
    }], { token: 'token' }));
    await act(async () => { await flush(); });
    localId = harness.latest().pendingUploads[0].localId;
    expect(harness.latest().getUploadedAttachmentId(localId)).toBeUndefined();
    await act(async () => { runtime.uploads[0].resolve(); await harness.latest().waitForPendingUploads(); });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(attachmentAtCleanup).toBe('att-pasted.png');
    expect(deliveriesAtCleanup).toBe(1);
    expect(harness.options.onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'att-pasted.png' }),
      expect.objectContaining({ uri: 'file:///durable/pasted.png' }), localId,
    );
    expect(harness.latest().pendingUploads).toEqual([]);
    expect(harness.latest().getUploadedAttachmentId(localId)).toBe('att-pasted.png');
    act(() => harness.latest().releaseUploadedSources(['att-pasted.png']));
    expect(harness.latest().getUploadedAttachmentId(localId)).toBeUndefined();
  });

  it('puts selected photos in the tray and closes the context panel before their originals load', async () => {
    const harness = mount('session-a');
    runtime.pickPhotos.mockResolvedValue([{
      ...imageCandidate('cloud.jpg', vi.fn()),
      uri: 'data:image/jpeg;base64,preview',
      resolve: () => new Promise(() => {}),
    }]);
    await act(async () => { await harness.first.addImages('library'); });
    expect(harness.latest().pendingUploads).toHaveLength(1);
    expect(harness.latest().pendingUploads[0].previewUri).toBe('data:image/jpeg;base64,preview');
    expect(harness.options.onPicked).toHaveBeenCalledOnce();
    expect(runtime.uploads).toHaveLength(0);
  });

  it.each(['library', 'camera', 'document'] as const)('reports %s input before a slot exists and ignores late selections after scope exit', async source => {
    const harness = mount('session-a');
    let finish!: (value: unknown) => void;
    const picker = source === 'library' ? runtime.pickPhotos : source === 'camera' ? runtime.pickCamera : runtime.pickDocument;
    picker.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    let picking!: Promise<void>;
    await act(async () => { picking = source === 'document' ? harness.first.addDocument() : harness.first.addImages(source); });
    expect(harness.first.getPendingUploadCount()).toBe(0);
    expect(harness.first.hasAttachmentInput()).toBe(true);
    act(() => harness.first.discardAllPendingUploadsForScopeChange());
    expect(harness.first.hasAttachmentInput()).toBe(false);
    const abandoned = vi.fn();
    await act(async () => {
      finish(source === 'library' ? [imageCandidate('late.jpg', abandoned)] : {
        canceled: false, assets: [{ uri: 'file:///late.jpg', name: 'late.jpg', fileName: 'late.jpg' }],
      });
      await picking;
    });
    if (source === 'library') expect(abandoned).toHaveBeenCalledOnce();
    expect(harness.latest().pendingUploads).toEqual([]);
    expect(harness.options.onPicked).not.toHaveBeenCalled();
    expect(runtime.uploads).toHaveLength(0);
  });

  it('abandons a candidate enqueued from a stale scope without starting an upload', async () => {
    const harness = mount('session-a');
    act(() => harness.first.discardAllPendingUploadsForScopeChange());
    const abandoned = vi.fn();
    act(() => harness.first.enqueueUploads([imageCandidate('late.png', abandoned)], { token: 'token' }));
    await flush();
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(runtime.uploads).toHaveLength(0);
  });

  // Leaving the new-task page mid-upload used to send the message without its image:
  // unmount discards the upload, which does not count as a failure.
  it('tells a send waiting on uploads that the composer left', async () => {
    const harness = mount('session-a');
    act(() => harness.first.enqueueUploads([imageCandidate('a.png', vi.fn())], { token: 'token' }));
    await act(async () => { await flush(); });
    const waiting = harness.latest().waitForPendingUploads();
    act(() => root.render(null));
    await expect(waiting).resolves.toEqual({ failedCount: 0, abandoned: true });
  });

  it('abandons exactly once when an upload finishes after the composer scope moved on', async () => {
    const harness = mount('session-a');
    const abandoned = vi.fn();
    act(() => harness.first.enqueueUploads([imageCandidate('a.png', abandoned)], { token: 'token' }));
    await act(async () => { await flush(); });
    expect(runtime.uploads.map((u) => u.name)).toEqual(['a.png']);
    // 作用域换到另一个任务,但旧任务没有被显式丢弃(防御性代际闸路径)。
    harness.rerender('session-b');
    await act(async () => {
      runtime.uploads[0].resolve();
      await flush();
      await flush();
    });
    expect(harness.options.onUploaded).not.toHaveBeenCalled();
    expect(runtime.discarded).toHaveLength(1);
    expect(abandoned).toHaveBeenCalledTimes(1);
  });
});

it('restores share source order when concurrent uploads complete in reverse order', async () => {
  const harness = mount('session-a');
  let attachments: RemoteSerializedAttachment[] = [];
  vi.mocked(harness.options.onUploaded).mockImplementation(attachment => {
    attachments = harness.latest().insertUploadedAttachment(attachments, attachment);
  });
  act(() => harness.first.enqueueUploads(['first.pdf', 'second.pdf'].map((name, index) => ({
    kind: 'file', uri: `file:///share/${name}`, name, size: 1000,
    incomingShareOrder: { batchId: 'batch', index },
  })), { token: 'token' }));
  await act(async () => { await flush(); });
  expect(runtime.uploads).toHaveLength(2);
  await act(async () => { runtime.uploads[1].resolve(); await flush(); });
  expect(attachments.map(item => item.name)).toEqual(['second.pdf']);
  await act(async () => { runtime.uploads[0].resolve(); await harness.latest().waitForPendingUploads(); });
  expect(attachments.map(item => item.name)).toEqual(['first.pdf', 'second.pdf']);
});

it('cleans a shared file only after staging takes ownership, retaining failed originals for retry', async () => {
  const harness = mount('session-a');
  const cleanup = vi.fn(async () => {
    expect(harness.latest().getUploadedSource('att-report.pdf')?.uri).toBe('file:///stage/att-report.pdf');
    expect(harness.options.onUploaded).toHaveBeenCalledOnce();
  });
  act(() => harness.first.enqueueUploads([{
    kind: 'file', uri: 'file:///share/report.pdf', name: 'report.pdf', size: 1000, cleanupLocalUris: cleanup,
  }], { token: Promise.resolve(null) }));
  await act(async () => { await harness.latest().waitForPendingUploads(); });
  expect(cleanup).not.toHaveBeenCalled();
  const localId = harness.latest().pendingUploads[0].localId;
  act(() => harness.latest().retryPendingUpload(localId));
  await act(async () => { await flush(); });
  await act(async () => { runtime.uploads[0].resolve(); await harness.latest().waitForPendingUploads(); });
  expect(cleanup).toHaveBeenCalledExactlyOnceWith(['file:///share/report.pdf']);
});
