// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSerializedAttachment } from '@/session/types';
import type { MobileLocalAttachmentUploadCandidate } from '@/session/mobileLocalAttachmentUpload';
import { useComposerImageExpansion } from '@/session/useComposerImageExpansion';
import { ComposerNativeInput } from '@/session/ComposerNativeInput.ios';
import {
  useMobileLocalAttachments,
  type UseMobileLocalAttachmentsOptions,
  type UseMobileLocalAttachmentsResult,
} from '@/session/useMobileLocalAttachments';

const runtime = vi.hoisted(() => ({
  uploads: [] as Array<{ name: string; uri: string; resolve: () => void }>,
  discarded: [] as unknown[],
  pickPhotos: vi.fn(),
  pickCamera: vi.fn(),
  pickDocument: vi.fn(),
  durablePreviewUri: null as string | null,
  deletedUris: [] as string[],
  nativePasteEvents: new Map<string, (event: { nativeEvent: { images: string[] } }) => void>(),
  nativeWrites: [] as Array<{ uri: string; data: string }>,
  nativeWriteBarriers: new Map<string, Promise<void>>(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo', () => ({
  requireOptionalNativeModule: () => ({}),
  requireNativeView: () => (props: { inputID: string; onPasteImages: (event: { nativeEvent: { images: string[] } }) => void }) => {
    runtime.nativePasteEvents.set(props.inputID, props.onPasteImages);
    return null;
  },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children: React.ReactNode }) => children },
  useAnimatedStyle: (read: () => unknown) => read(),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ mode: 'light' }) }));
vi.mock('expo-file-system', () => ({
  File: class { uri: string; constructor(cache: string, name: string) { this.uri = `${cache}${name}`; } },
  Paths: { cache: 'file:///cache/' },
}));
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
  deleteAsync: async (uri: string) => { runtime.deletedUris.push(uri); },
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: async (uri: string, data: string) => {
    runtime.nativeWrites.push({ uri, data });
    await runtime.nativeWriteBarriers.get(data);
  },
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
  uploadMobileAttachmentFromFile: (candidate: { name: string }, uri: string) => new Promise((resolve) => {
    runtime.uploads.push({
      name: candidate.name,
      uri,
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
  runtime.deletedUris = [];
  runtime.nativePasteEvents.clear();
  runtime.nativeWrites = [];
  runtime.nativeWriteBarriers.clear();
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

function mount(scopeKey: string, optionsOrUpload: Partial<UseMobileLocalAttachmentsOptions> | UseMobileLocalAttachmentsOptions['upload'] = {}, nativeEditorKey?: string) {
  const initialOptions = typeof optionsOrUpload === 'function' ? { upload: optionsOrUpload } : optionsOrUpload ?? {};
  const options: UseMobileLocalAttachmentsOptions = {
    attachmentScopeKey: scopeKey,
    getAccessToken: async () => 'token',
    getAttachmentCount: () => 0,
    onUploaded: vi.fn(),
    onError: vi.fn(),
    onPicked: vi.fn(),
    ...initialOptions,
  };
  const results: UseMobileLocalAttachmentsResult[] = [];
  let expansion!: ReturnType<typeof useComposerImageExpansion>;
  function Harness({ scope, editorKey }: { scope: string; editorKey?: string }) {
    const local = useMobileLocalAttachments({ ...options, attachmentScopeKey: scope });
    results.push(local);
    expansion = useComposerImageExpansion(
      local.pendingUploads.filter((item) => item.kind === 'image').length + local.pastePlaceholderCount,
      local.imageSelectionRevision,
    );
    return editorKey ? <ComposerNativeInput
      key={editorKey}
      testID={editorKey}
      accessibilityLabel="Message"
      document={{ version: 1, nodes: [] }}
      height={40}
      maxHeight={120}
      placeholder=""
      theme={{ background: '', border: '', chip: '', focus: '', placeholder: '', text: '', textSecondary: '' }}
      onChangeDocument={() => {}}
      onPasteImagesLoading={local.beginPastePlaceholders}
      onPasteImages={(uris, batchId) => { void local.addPastedImages(uris, batchId); }}
      onPasteImagesLoadFailed={local.failPastePlaceholders}
    /> : null;
  }
  act(() => root.render(<Harness scope={scopeKey} editorKey={nativeEditorKey} />));
  return {
    options,
    first: results[0],
    latest: () => results.at(-1)!,
    expansion: () => expansion,
    rerender: (scope: string, editorKey = nativeEditorKey) => act(() => root.render(<Harness scope={scope} editorKey={editorKey} />)),
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

// 测试价值：通过真实 hook 的 loading / images / wait 入口验证文字引擎拒绝后
// 不留占位、发送等待或临时图片（review #8）。原有 scope 用例没有引擎切换。
// 最小失败输入：一次 loading 后切到文字引擎，旧回调再兑现一张粘贴图。
// tier：unit；文件与上传用内存 fake，不读取源码，超时只推进假时钟。
// 原 pastedImageAttachment.test.ts 的 FIFO / 限额 / 超时源码断言迁入此处。
// 实测耗时：单文件 Vitest 1.90s / 墙钟 2.44s（23 条用例，本机）。
describe('useMobileLocalAttachments text-only paste rejection', () => {
  const disabledReason = 'session.zcodeTextOnly';
  const pastedUri = 'file:///cache/cindy-composer-paste-rejected.png';

  // 实际 iOS TS 包装器事件 + 可控写盘 Promise：原生事件顺序不代表 JS 写盘完成顺序。
  // 旧 hook-only 测试未经过这个并发边界；同实例与共用 hook 的输入框替换都需隔离批次。
  it.each([
    { replaceEditor: false, failB: false },
    { replaceEditor: true, failB: false },
    { replaceEditor: false, failB: true },
  ])('keeps native paste ownership when B settles before A ($replaceEditor, failure $failB)', async ({ replaceEditor, failB }) => {
    let finishA!: () => void;
    let finishB!: () => void;
    let rejectB!: () => void;
    runtime.nativeWriteBarriers.set('A', new Promise<void>(resolve => { finishA = resolve; }));
    runtime.nativeWriteBarriers.set('B', new Promise<void>((resolve, reject) => {
      finishB = resolve;
      rejectB = () => reject(new Error('write failed'));
    }));
    const harness = mount('session-a', { pasteImagesDisabledReason: disabledReason }, 'editor-a');
    try {
      act(() => runtime.nativePasteEvents.get('editor-a')!({ nativeEvent: { images: ['A'] } }));
      harness.options.pasteImagesDisabledReason = null;
      const editorKey = replaceEditor ? 'editor-b' : 'editor-a';
      harness.rerender('session-a', editorKey);
      act(() => runtime.nativePasteEvents.get(editorKey)!({ nativeEvent: { images: ['B'] } }));
      const aUri = runtime.nativeWrites.find(write => write.data === 'A')!.uri;
      const bUri = runtime.nativeWrites.find(write => write.data === 'B')!.uri;
      await act(async () => { if (failB) rejectB(); else finishB(); await flush(); });
      expect(runtime.uploads.map(upload => upload.uri)).toEqual(failB ? [] : [bUri]);
      expect(harness.latest().pastePlaceholderCount).toBe(0);
      expect(runtime.deletedUris.includes(bUri)).toBe(failB);
      await act(async () => { finishA(); await flush(); });
      expect(runtime.uploads.map(upload => upload.uri)).toEqual(failB ? [] : [bUri]);
      expect(runtime.deletedUris).toContain(aUri);
      expect(harness.latest().pastePlaceholderCount).toBe(0);
      await act(async () => { runtime.uploads[0]?.resolve(); await harness.latest().waitForPendingUploads(); });
      if (failB) {
        expect(harness.options.onUploaded).not.toHaveBeenCalled();
      } else {
        expect(harness.options.onUploaded).toHaveBeenCalledExactlyOnceWith(
          expect.anything(), expect.objectContaining({ uri: bUri }), expect.any(String),
        );
      }
    } finally {
      await act(async () => { finishA(); finishB(); await flush(); });
      await act(async () => { for (const upload of runtime.uploads) upload.resolve(); await flush(); });
    }
  });

  it('drops an invalidated native batch without consuming a newer placeholder or its file', async () => {
    let finishA!: () => void;
    let finishB!: () => void;
    runtime.nativeWriteBarriers.set('A', new Promise<void>(resolve => { finishA = resolve; }));
    runtime.nativeWriteBarriers.set('B', new Promise<void>(resolve => { finishB = resolve; }));
    const harness = mount('session-a', {}, 'editor');
    try {
      act(() => runtime.nativePasteEvents.get('editor')!({ nativeEvent: { images: ['A'] } }));
      act(() => harness.latest().discardAllPendingUploads());
      act(() => runtime.nativePasteEvents.get('editor')!({ nativeEvent: { images: ['B'] } }));
      const aUri = runtime.nativeWrites.find(write => write.data === 'A')!.uri;
      const bUri = runtime.nativeWrites.find(write => write.data === 'B')!.uri;
      // 空的原生事件没有对应 loading，也不能借失败回调消费 B 的占位。
      act(() => runtime.nativePasteEvents.get('editor')!({ nativeEvent: { images: [] } }));
      await act(async () => { finishA(); await flush(); });
      expect(harness.latest().pastePlaceholderCount).toBe(1);
      expect(runtime.uploads).toEqual([]);
      expect(runtime.deletedUris).toEqual([aUri]);
      await act(async () => { finishB(); await flush(); });
      expect(runtime.uploads.map(upload => upload.uri)).toEqual([bUri]);
      await act(async () => { runtime.uploads[0].resolve(); await harness.latest().waitForPendingUploads(); });
      expect(harness.latest().pastePlaceholderCount).toBe(0);
    } finally {
      await act(async () => { finishA(); finishB(); await flush(); });
      await act(async () => { for (const upload of runtime.uploads) upload.resolve(); await flush(); });
    }
  });

  it('rejects before creating placeholders and reclaims only composer-owned paste files', async () => {
    const harness = mount('session-a', { pasteImagesDisabledReason: disabledReason });
    act(() => harness.latest().beginPastePlaceholders(1));
    expect(harness.latest().pastePlaceholderCount).toBe(0);
    expect(harness.latest().hasAttachmentInput()).toBe(false);
    await act(async () => {
      await harness.latest().addPastedImages([pastedUri, 'file:///photos/original.png', 'content://photos/1']);
    });
    expect(runtime.deletedUris).toEqual([pastedUri]);
    expect(runtime.uploads).toEqual([]);
    expect(harness.options.onError).toHaveBeenLastCalledWith(disabledReason);
    await expect(harness.latest().waitForPendingUploads()).resolves.toEqual({ failedCount: 0, abandoned: false });
  });

  it('settles an accepted paste when its old callback arrives after switching to a text-only engine', async () => {
    const harness = mount('session-a');
    const finishPaste = harness.first.addPastedImages;
    act(() => harness.first.beginPastePlaceholders(1));
    const waiting = harness.first.waitForPendingUploads();
    harness.options.pasteImagesDisabledReason = disabledReason;
    harness.rerender('session-a');
    await act(async () => { await finishPaste([pastedUri]); });
    expect(harness.latest().pastePlaceholderCount).toBe(0);
    expect(harness.latest().pendingUploads).toEqual([]);
    await expect(waiting).resolves.toEqual({ failedCount: 0, abandoned: false });
    expect(runtime.deletedUris).toEqual([pastedUri]);
    expect(runtime.uploads).toEqual([]);
    expect(harness.options.onError).toHaveBeenLastCalledWith(disabledReason);
  });

  it.each(['images', 'failed'])('does not consume a later accepted placeholder when a rejected batch reports %s', async completion => {
    const harness = mount('session-a', { pasteImagesDisabledReason: disabledReason });
    act(() => harness.first.beginPastePlaceholders(1));
    harness.options.pasteImagesDisabledReason = null;
    harness.rerender('session-a');
    act(() => harness.latest().beginPastePlaceholders(1));
    await act(async () => {
      if (completion === 'images') await harness.first.addPastedImages([pastedUri]);
      else harness.first.failPastePlaceholders();
    });
    expect(harness.latest().pastePlaceholderCount).toBe(1);
    expect(harness.latest().pendingUploads).toEqual([]);
    expect(runtime.deletedUris).toEqual(completion === 'images' ? [pastedUri] : []);
    expect(harness.options.onError).toHaveBeenLastCalledWith(disabledReason);
    act(() => harness.latest().failPastePlaceholders());
    await expect(harness.latest().waitForPendingUploads()).resolves.toEqual({ failedCount: 0, abandoned: false });
  });

  it('keeps accepted paste uploads in the send wait until delivery and then releases their source', async () => {
    const harness = mount('session-a', { getAttachmentCount: () => 19 });
    const uri = 'file:///cache/cindy-composer-paste-accepted.gif';
    runtime.durablePreviewUri = 'file:///durable/accepted.gif';
    act(() => harness.first.beginPastePlaceholders(1));
    expect(harness.first.getPendingUploadCount()).toBe(1);
    await act(async () => { await harness.latest().addDocument(); });
    expect(runtime.pickDocument).not.toHaveBeenCalled();
    expect(harness.options.onError).toHaveBeenLastCalledWith('composer.upload.maxAttachments');
    let settled = false;
    const waiting = harness.first.waitForPendingUploads().then(result => { settled = true; return result; });
    await act(async () => { await harness.latest().addPastedImages([uri]); await flush(); });
    expect(harness.latest().pastePlaceholderCount).toBe(0);
    expect(harness.latest().pendingUploads).toHaveLength(1);
    expect(settled).toBe(false);
    expect(runtime.deletedUris).toEqual([]);
    await act(async () => { runtime.uploads[0].resolve(); await waiting; });
    expect(harness.options.onUploaded).toHaveBeenCalledOnce();
    expect(harness.latest().pendingUploads).toEqual([]);
    expect(runtime.deletedUris).toEqual([uri]);
  });

  it('settles paste batches in FIFO order and releases waiters when the remaining batch times out', async () => {
    vi.useFakeTimers();
    try {
      const harness = mount('session-a');
      act(() => {
        harness.first.beginPastePlaceholders(2);
        harness.first.beginPastePlaceholders(3);
      });
      expect(harness.latest().getPendingUploadCount()).toBe(5);
      let settled = false;
      const waiting = harness.latest().waitForPendingUploads().then(result => { settled = true; return result; });
      await act(async () => { harness.latest().failPastePlaceholders(); });
      expect(harness.latest().pastePlaceholderCount).toBe(3);
      expect(harness.latest().getPendingUploadCount()).toBe(3);
      expect(settled).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); await waiting; });
      expect(harness.latest().pastePlaceholderCount).toBe(0);
      expect(harness.latest().hasAttachmentInput()).toBe(false);
      expect(harness.options.onError).toHaveBeenLastCalledWith('composer.upload.pasteTimeout');
    } finally {
      vi.useRealTimers();
    }
  });
});

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

  it('uses a supplied direct transport while retaining the same picker queue and delivery', async () => {
    const attachment = { id: 'server-media', name: 'report.pdf', path: '', ext: 'pdf', size: 1000,
      category: 'file' as const, mimeType: 'application/pdf' };
    const upload = vi.fn(async () => attachment);
    const harness = mount('direct-group', upload);
    act(() => harness.first.enqueueUploads([{ kind: 'file', uri: 'file:///picked', name: 'report.pdf', size: 1000,
      mimeType: 'application/pdf' }], { token: 'token' }));
    await act(async () => { await flush(); });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ name: 'report.pdf', size: 1000 }),
      'file:///picked', expect.objectContaining({ token: 'token', signal: expect.any(AbortSignal) }));
    expect(runtime.uploads).toHaveLength(0);
    expect(harness.options.onUploaded).toHaveBeenCalledWith(attachment, expect.any(Object), expect.any(String));
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
