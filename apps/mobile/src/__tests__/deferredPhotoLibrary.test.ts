import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { pickDeferredLibraryPhotos } from '@/session/deferredPhotoLibrary';
import { createMobileLocalAttachmentUploadController } from '@/session/mobileLocalAttachmentUpload';
import type { PendingLocalAttachmentUpload } from '@/session/mobileLocalAttachmentUpload';
import type { RemoteSerializedAttachment } from '@/session/types';

const mock = vi.hoisted(() => ({
  available: true,
  native: { pick: vi.fn(), pickMedia: undefined as undefined | ReturnType<typeof vi.fn>, load: vi.fn(), cancel: vi.fn(), release: vi.fn() },
  deleteAsync: vi.fn(),
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mock.available ? mock.native : null }));
vi.mock('expo-file-system/legacy', () => ({ deleteAsync: mock.deleteAsync }));

const selection = (id: string) => ({ id, name: `${id}.jpg`, previewUri: `data:image/jpeg;base64,${id}` });
const file = (id: string) => ({ uri: `file:///cache/${id}.jpg`, fileName: `${id}.jpg`, mimeType: 'image/jpeg', fileSize: 100 });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const initialLanguage = i18n.language;

afterEach(async () => { await i18n.changeLanguage(initialLanguage); });

beforeEach(() => {
  vi.resetAllMocks();
  mock.available = true;
  mock.native.pickMedia = mock.native.pick;
  mock.native.pick.mockResolvedValue([selection('cloud'), selection('local')]);
  mock.native.load.mockImplementation(async (id: string) => file(id));
  mock.native.cancel.mockResolvedValue(undefined);
  mock.native.release.mockResolvedValue(undefined);
  mock.deleteAsync.mockResolvedValue(undefined);
});

function makeController() {
  let pending: readonly PendingLocalAttachmentUpload[] = [];
  const uploaded = vi.fn();
  const upload = vi.fn(async (candidate: { name: string }) => ({ id: candidate.name, name: candidate.name } as RemoteSerializedAttachment));
  const controller = createMobileLocalAttachmentUploadController({
    preprocess: async (source) => source,
    statSize: async () => 100,
    assertSize: () => {},
    upload,
    discard: vi.fn(),
    onPendingChange: (value) => { pending = value; },
    onUploaded: uploaded,
    onFailed: vi.fn(),
  });
  return { controller, upload, uploaded, pending: () => pending };
}

describe('deferred photo library', () => {
  // unit: mixed native selections must retain the deferred iCloud lifecycle,
  // while videos bypass image conversion and keep their file metadata.
  it('resolves a mixed selection as an image and a video file without converting the video', async () => {
    mock.native.pick.mockResolvedValue([selection('still'), {
      id: 'movie', name: 'clip', previewUri: '', mediaType: 'video',
    }]);
    mock.native.load.mockImplementation(async (id: string) => id === 'movie'
      ? { uri: 'file:///cache/clip.mov', fileName: 'clip.mov', mimeType: 'video/quicktime', fileSize: 500 }
      : file(id));
    const candidates = (await pickDeferredLibraryPhotos(2))!;
    expect(candidates.map(item => item.kind)).toEqual(['image', 'file']);
    expect(mock.native.load).not.toHaveBeenCalled();
    const { controller, upload } = makeController();
    controller.enqueue(candidates, { token: 'token' });
    expect(await controller.waitForIdle()).toEqual({ failedCount: 0 });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      name: 'clip.mov', mimeType: 'video/quicktime', size: 500,
    }), 'file:///cache/clip.mov', expect.anything());
    expect(mock.native.release).toHaveBeenCalledWith('movie');
    controller.dispose();
  });

  it('retains a failed video for retry and cleans a late cancelled movie', async () => {
    mock.native.pick.mockResolvedValue([{ id: 'movie', name: 'clip', previewUri: '', mediaType: 'video' }]);
    const movie = { uri: 'file:///cache/clip.mov', fileName: 'clip.mov', mimeType: 'video/quicktime', fileSize: 500 };
    mock.native.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(movie);
    const { controller, pending, upload } = makeController();
    controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: 'token' });
    expect(await controller.waitForIdle()).toEqual({ failedCount: 1 });
    expect(mock.native.release).not.toHaveBeenCalled();
    controller.retry(pending()[0].localId, { token: 'token' });
    expect(await controller.waitForIdle()).toEqual({ failedCount: 0 });
    expect(mock.native.release).toHaveBeenCalledExactlyOnceWith('movie');
    controller.dispose();

    let finish!: (value: typeof movie) => void;
    mock.native.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const cancelled = makeController();
    cancelled.controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: 'token' });
    await flush();
    cancelled.controller.remove(cancelled.pending()[0].localId);
    finish(movie);
    await flush();
    expect(cancelled.upload).not.toHaveBeenCalled();
    expect(mock.native.cancel).toHaveBeenCalledWith('movie');
    expect(mock.deleteAsync).toHaveBeenCalledWith(movie.uri, { idempotent: true });
    expect(upload).toHaveBeenCalledOnce();
    cancelled.controller.dispose();
  });

  it.each([
    ['zh-CN', '没有读取到可上传的图片。', '附件上传已取消。'],
    ['en', 'No uploadable image was read.', 'Attachment upload cancelled.'],
  ])('localizes native failures using the current %s app language', async (locale, failed, cancelled) => {
    const candidates = (await pickDeferredLibraryPhotos(1))!;
    // A language change after selection must also apply to a later load/retry.
    await i18n.changeLanguage(locale);
    for (const code of ['ERR_PHOTO_PICKER_BUSY', 'ERR_PHOTO_PICKER_PRESENTER']) {
      mock.native.pick.mockRejectedValueOnce(Object.assign(new Error('Native English message'), { code }));
      await expect(pickDeferredLibraryPhotos(1)).rejects.toThrow(failed);
    }
    for (const code of ['ERR_PHOTO_LOAD', 'ERR_PHOTO_LOAD_BUSY', 'ERR_PHOTO_SELECTION_RELEASED', 'ERR_PHOTO_CANCELLED', undefined]) {
      mock.native.load.mockRejectedValueOnce(Object.assign(new Error('Provider failure at /private/photo.jpg'), { code }));
      await expect(candidates[0].resolve!()).rejects.toThrow(code === 'ERR_PHOTO_CANCELLED' ? cancelled : failed);
    }
    expect(mock.native.release).not.toHaveBeenCalled();
    await expect(candidates[0].resolve!()).resolves.toMatchObject({ uri: file('cloud').uri });
  });

  it('returns every preview before downloading, and a local image completes while iCloud is pending', async () => {
    let finishCloud!: (value: ReturnType<typeof file>) => void;
    mock.native.load.mockImplementation((id: string) => id === 'cloud'
      ? new Promise((resolve) => { finishCloud = resolve; }) : Promise.resolve(file(id)));
    const candidates = (await pickDeferredLibraryPhotos(8))!;
    expect(mock.native.pick).toHaveBeenCalledWith(8);
    expect(mock.native.load).not.toHaveBeenCalled();
    const { controller, pending, upload } = makeController();
    controller.enqueue(candidates, { token: 'token' });
    expect(pending().map((item) => item.previewUri)).toEqual(candidates.map((item) => item.uri));
    await flush();
    expect(upload.mock.calls.map(([item]) => item.name)).toEqual(['local.jpg']);
    expect(mock.native.release).toHaveBeenCalledWith('local');
    expect(mock.native.release).not.toHaveBeenCalledWith('cloud');
    finishCloud(file('cloud'));
    expect(await controller.waitForIdle()).toEqual({ failedCount: 0 });
    expect(mock.native.release).toHaveBeenCalledWith('cloud');
    controller.dispose();
  });

  it('keeps a failed selection for retry and releases it only after successful delivery', async () => {
    mock.native.pick.mockResolvedValue([selection('cloud')]);
    mock.native.load.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(file('cloud'));
    const { controller, pending } = makeController();
    controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: 'token' });
    expect(await controller.waitForIdle()).toEqual({ failedCount: 1 });
    expect(pending()[0]).toMatchObject({ failed: true, previewUri: selection('cloud').previewUri });
    expect(mock.native.release).not.toHaveBeenCalled();
    controller.retry(pending()[0].localId, { token: 'token' });
    expect(await controller.waitForIdle()).toEqual({ failedCount: 0 });
    expect(mock.native.release).toHaveBeenCalledExactlyOnceWith('cloud');
    controller.dispose();
  });

  it('cancels the native download on removal and cleans a late file without uploading it', async () => {
    mock.native.pick.mockResolvedValue([selection('cloud')]);
    let finish!: (value: ReturnType<typeof file>) => void;
    mock.native.load.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { controller, pending, upload } = makeController();
    controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: 'token' });
    await flush();
    controller.remove(pending()[0].localId);
    await flush();
    expect(mock.native.cancel).toHaveBeenCalledWith('cloud');
    expect(mock.native.release).toHaveBeenCalledExactlyOnceWith('cloud');
    finish(file('cloud'));
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(mock.deleteAsync).toHaveBeenCalledWith(file('cloud').uri, { idempotent: true });
    expect(mock.deleteAsync).not.toHaveBeenCalledWith(selection('cloud').previewUri, expect.anything());
    controller.dispose();
  });

  it('keeps the native selection when staging fails after upload, so retry can read the original again', async () => {
    mock.native.pick.mockResolvedValue([selection('cloud')]);
    const { controller, uploaded, pending } = makeController();
    uploaded.mockRejectedValueOnce(new Error('disk full'));
    controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: 'token' });
    expect(await controller.waitForIdle()).toEqual({ failedCount: 1 });
    expect(mock.native.release).not.toHaveBeenCalled();
    controller.retry(pending()[0].localId, { token: 'token' });
    expect(await controller.waitForIdle()).toEqual({ failedCount: 0 });
    expect(mock.native.load).toHaveBeenCalledTimes(2);
    expect(mock.native.release).toHaveBeenCalledExactlyOnceWith('cloud');
    controller.dispose();
  });

  it('cancels a timed-out native read without losing the selection needed by retry', async () => {
    vi.useFakeTimers();
    const { controller, pending } = makeController();
    try {
      mock.native.pick.mockResolvedValue([selection('cloud')]);
      let rejectLoad!: (error: Error) => void;
      mock.native.load.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLoad = reject; }));
      mock.native.cancel.mockImplementation(async () => { rejectLoad(new Error('cancelled')); });
      controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: 'token' });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(await controller.waitForIdle()).toEqual({ failedCount: 1 });
      expect(mock.native.cancel).toHaveBeenCalledWith('cloud');
      expect(mock.native.release).not.toHaveBeenCalled();
      controller.retry(pending()[0].localId, { token: 'token' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await controller.waitForIdle()).toEqual({ failedCount: 0 });
      expect(mock.native.release).toHaveBeenCalledExactlyOnceWith('cloud');
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('hands downloaded bytes to the durable outbox before releasing the native selection', async () => {
    mock.native.pick.mockResolvedValue([selection('cloud')]);
    const { controller } = makeController();
    controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: new Promise(() => {}) });
    const handoff = controller.beginHandoff();
    const prepared = await handoff.prepare();
    expect(prepared[0].source.uri).toBe(file('cloud').uri);
    expect(mock.native.release).not.toHaveBeenCalled();
    handoff.release(true);
    await flush();
    expect(mock.native.release).toHaveBeenCalledExactlyOnceWith('cloud');
    controller.dispose();
  });

  it('preserves selected slots without a local thumbnail and never uploads the placeholder', async () => {
    mock.native.pick.mockResolvedValue([{ ...selection('limited'), previewUri: '' }]);
    const { controller, pending, upload } = makeController();
    controller.enqueue((await pickDeferredLibraryPhotos(1))!, { token: 'token' });
    expect(pending()).toHaveLength(1);
    await controller.waitForIdle();
    expect(upload).toHaveBeenCalledWith(expect.anything(), file('limited').uri, expect.anything());
    controller.dispose();
  });

  it('returns null only when the native module is absent; cancellation stays an empty selection', async () => {
    mock.available = false;
    expect(await pickDeferredLibraryPhotos(1)).toBeNull();
    mock.available = true;
    mock.native.pickMedia = undefined;
    expect(await pickDeferredLibraryPhotos(1)).toBeNull();
    mock.native.pickMedia = mock.native.pick;
    mock.native.pick.mockResolvedValue([]);
    expect(await pickDeferredLibraryPhotos(1)).toEqual([]);
    expect(mock.native.load).not.toHaveBeenCalled();
  });
});
