// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileLocalAttachmentUploadCandidate } from '@/session/mobileLocalAttachmentUpload';
import type { RemoteSerializedAttachment } from '@/session/types';
import {
  useComposerImageAnnotations,
  type UseComposerImageAnnotationsOptions,
  type UseComposerImageAnnotationsResult,
} from '@/session/useComposerImageAnnotations';

const runtime = vi.hoisted(() => ({
  platform: 'ios',
  deleted: [] as string[],
  written: [] as string[],
  alerts: [] as unknown[][],
  manipulations: [] as Array<{ uri: string; resize?: unknown; save?: Record<string, unknown> }>,
  manipulatorResult: null as null | { width: number; height: number },
  manipulatorError: null as Error | null,
  manipulatorSeq: 0,
  /** uri 前缀 → getInfoAsync 字节数(未命中默认 1234)。 */
  sizes: {} as Record<string, number>,
  burnIn: null as unknown as ReturnType<typeof vi.fn>,
  acquireWarm: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('react-native', () => ({
  Alert: { alert: (...args: unknown[]) => runtime.alerts.push(args) },
  Platform: { get OS() { return runtime.platform; } },
}));
vi.mock('react-i18next', async (importOriginal) => {
  const t = (key: string) => key;
  return { ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t }) };
});
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  makeDirectoryAsync: async () => undefined,
  getInfoAsync: async (uri: string) => ({
    exists: true,
    size: Object.entries(runtime.sizes).find(([prefix]) => uri.startsWith(prefix))?.[1] ?? 1234,
  }),
  // 头部嗅探读不出魔数 → 以调用方给的 mime 为准。
  readAsStringAsync: async (_uri: string, options?: { length?: number }) => (options?.length ? '' : 'QUJD'),
  writeAsStringAsync: async (uri: string) => { runtime.written.push(uri); },
  copyAsync: async () => undefined,
  downloadAsync: async () => ({ status: 200 }),
  deleteAsync: async (uri: string) => { runtime.deleted.push(uri); },
}));
vi.mock('@/session/AnnotationBurnInWebView', () => ({
  useAnnotationBurnIn: () => ({ burnIn: runtime.burnIn, acquireWarm: runtime.acquireWarm, host: null }),
}));
vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: (uri: string) => {
      const record: { uri: string; resize?: unknown; save?: Record<string, unknown> } = { uri };
      runtime.manipulations.push(record);
      const context = {
        resize: (size: unknown) => { record.resize = size; return context; },
        renderAsync: async () => {
          if (runtime.manipulatorError) throw runtime.manipulatorError;
          return {
            release: () => undefined,
            saveAsync: async (options: Record<string, unknown>) => {
              record.save = options;
              runtime.manipulatorSeq += 1;
              const size = runtime.manipulatorResult ?? { width: 800, height: 600 };
              return { uri: `file:///cache/ImageManipulator/out-${runtime.manipulatorSeq}`, ...size };
            },
          };
        },
        release: () => undefined,
      };
      return context;
    },
  },
}));

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.platform = 'ios';
  runtime.deleted = [];
  runtime.written = [];
  runtime.alerts = [];
  runtime.manipulations = [];
  runtime.manipulatorResult = null;
  runtime.manipulatorError = null;
  runtime.manipulatorSeq = 0;
  runtime.sizes = {};
  runtime.burnIn = vi.fn(async (input: { mimeType: string }) => ({
    base64: 'b3V0',
    mimeType: input.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    width: 800,
    height: 600,
  }));
  runtime.acquireWarm = vi.fn(() => () => undefined);
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

function mountHook(overrides: Partial<UseComposerImageAnnotationsOptions> = {}) {
  const options: UseComposerImageAnnotationsOptions = {
    getAccessToken: vi.fn(async () => 'token'),
    enqueueUploads: vi.fn(),
    removeAttachment: vi.fn(),
    getRemainingAttachmentSlots: vi.fn(() => 5),
    getAttachment: vi.fn(() => undefined),
    ...overrides,
  };
  let latest: UseComposerImageAnnotationsResult | null = null;
  function Harness() {
    latest = useComposerImageAnnotations(options);
    return null;
  }
  act(() => root.render(<Harness />));
  const enqueued = () => (options.enqueueUploads as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => (call[0] as MobileLocalAttachmentUploadCandidate[])[0]);
  return { options, api: () => latest!, enqueued };
}

const image = (key: string) => ({ key, url: key, title: key, payload: { kind: 'media', media: { kind: 'image', url: key, previewable: true } } }) as never;
const attachment = (id: string, extra: Partial<RemoteSerializedAttachment> = {}) =>
  ({ id, name: `${id}.png`, category: 'image', ...extra }) as RemoteSerializedAttachment;
const STROKES = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }] }];

async function chatSubmit(
  api: UseComposerImageAnnotationsResult,
  uri: string,
  strokes = STROKES,
  context: Record<string, unknown> = { mimeType: 'image/jpeg' },
) {
  await act(async () => { await api.chatAnnotation.onSubmit(image('chat'), uri, strokes, context); });
}
async function traySubmit(
  api: UseComposerImageAnnotationsResult,
  key: string,
  uri: string,
  strokes = STROKES,
  context: Record<string, unknown> = { mimeType: 'image/png' },
) {
  await act(async () => { await api.trayAnnotation.onSubmit(image(key), uri, strokes, context); });
}

describe('generated file lifecycle', () => {
  it('keeps the files of a failed upload for retry and deletes them only when the card is abandoned', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { api, enqueued } = mountHook();
    await chatSubmit(api(), 'file:///photos/a.jpg');
    const candidate = enqueued()[0];
    expect(candidate.uri).toMatch(/^file:\/\/\/cache\/annotation-burned\/annotated-/);
    expect(candidate.annotation?.sourceUri).toMatch(/^file:\/\/\/cache\/annotation-src\/src-/);
    // 上传失败后卡片停留很久:文件不能被计时器回收(重试会重新读 candidate.uri)。
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(runtime.deleted).toEqual([]);
    candidate.onAbandoned?.();
    await act(async () => undefined);
    expect(runtime.deleted.sort()).toEqual([candidate.uri, candidate.annotation!.sourceUri].sort());
    candidate.onAbandoned?.(); // 幂等
    expect(runtime.deleted).toHaveLength(2);
  });

  it('moves files under the attachment on success; later abandonment is a no-op and removal deletes them', async () => {
    const { api, enqueued } = mountHook();
    await chatSubmit(api(), 'file:///photos/a.jpg');
    const candidate = enqueued()[0];
    const decorated = api().decorateUploadedAttachment(attachment('att-1'), candidate);
    expect(decorated.annotated).toBe(true);
    // 与桌面同一归纳算法:给模型的标注区域随附件发给被控端。
    expect(decorated.annotationRegions).toEqual([{ x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }]);
    candidate.onAbandoned?.();
    expect(runtime.deleted).toEqual([]);
    act(() => api().forgetAttachment('att-1'));
    await act(async () => undefined);
    expect(runtime.deleted.sort()).toEqual([candidate.uri, candidate.annotation!.sourceUri].sort());
  });

  it('forgetAllAttachments leaves still-pending uploads to their own lifecycle', async () => {
    const { api, enqueued } = mountHook();
    await chatSubmit(api(), 'file:///photos/a.jpg');
    act(() => api().forgetAllAttachments());
    expect(runtime.deleted).toEqual([]);
    enqueued()[0].onAbandoned?.();
    expect(runtime.deleted).toHaveLength(2);
  });

  it('cleans up the private copies when the submission fails before reaching the upload queue', async () => {
    runtime.burnIn.mockRejectedValueOnce(new Error('annotation burn-in timed out'));
    const { api, options } = mountHook();
    await expect(Promise.resolve(
      api().chatAnnotation.onSubmit(image('chat'), 'file:///photos/a.jpg', STROKES, { mimeType: 'image/jpeg' }),
    )).rejects.toThrow(/timed out/);
    expect(options.enqueueUploads).not.toHaveBeenCalled();
    expect(runtime.alerts).toHaveLength(1);
    expect(runtime.deleted).toHaveLength(1);
    expect(runtime.deleted[0]).toMatch(/annotation-src\/src-/);
  });
});

describe('re-edit replacement', () => {
  async function seedAnnotated(hook: ReturnType<typeof mountHook>, id: string) {
    await chatSubmit(hook.api(), 'file:///photos/a.jpg');
    const candidate = hook.enqueued().at(-1)!;
    hook.api().decorateUploadedAttachment(attachment(id), candidate);
    return candidate;
  }

  it('blocks a second edit while the replacement is pending, then replaces in order', async () => {
    const attachments = new Map<string, RemoteSerializedAttachment>();
    const hook = mountHook({ getAttachment: (id) => attachments.get(id) });
    const original = await seedAnnotated(hook, 'A');
    attachments.set('A', attachment('A', { annotated: true }));
    expect(hook.api().trayAnnotation.annotationBlockedReason?.(image('A'))).toBeUndefined();
    await traySubmit(hook.api(), 'A', hook.api().trayImageSourceUri('A', 'preview'));
    const replacement = hook.enqueued().at(-1)!;
    expect(replacement.replacesAttachmentId).toBe('A');
    // 替换未落定:画笔置灰并给出原因,且直接提交也被拒绝(不会产生第二份替换)。
    expect(hook.api().trayAnnotation.annotationBlockedReason?.(image('A')))
      .toBe('composer.attachments.replacementPending');
    await expect(Promise.resolve(
      hook.api().trayAnnotation.onSubmit(image('A'), 'x', STROKES, {}),
    )).rejects.toThrow('composer.attachments.replacementPending');
    expect(hook.enqueued()).toHaveLength(2);
    // 替换上传成功:此刻才移除旧附件;共享的源副本保留,旧烧录图删除。
    const decorated = hook.api().decorateUploadedAttachment(attachment('B'), replacement);
    expect(decorated.annotated).toBe(true);
    expect(hook.options.removeAttachment).toHaveBeenCalledWith('A');
    expect(runtime.deleted).toEqual([original.uri]);
    expect(replacement.annotation?.sourceUri).toBe(original.annotation?.sourceUri);
    expect(hook.api().trayImageSourceUri('B', 'preview')).toBe(original.annotation?.sourceUri);
  });

  it('re-enables editing when a pending replacement is abandoned without touching the original files', async () => {
    const attachments = new Map<string, RemoteSerializedAttachment>();
    const hook = mountHook({ getAttachment: (id) => attachments.get(id) });
    const original = await seedAnnotated(hook, 'A');
    attachments.set('A', attachment('A', { annotated: true }));
    await traySubmit(hook.api(), 'A', hook.api().trayImageSourceUri('A', 'preview'));
    const replacement = hook.enqueued().at(-1)!;
    replacement.onAbandoned?.();
    expect(hook.api().trayAnnotation.annotationBlockedReason?.(image('A'))).toBeUndefined();
    // 只删替换自己的烧录图;与 A 共享的源副本仍被 A 引用。
    expect(runtime.deleted).toEqual([replacement.uri]);
    expect(runtime.deleted).not.toContain(original.annotation?.sourceUri);
  });

  it('does not let a replacement bypass the attachment limit once its target is gone', async () => {
    const hook = mountHook({ getRemainingAttachmentSlots: () => 0, getAttachment: () => undefined });
    await expect(Promise.resolve(
      hook.api().trayAnnotation.onSubmit(image('ghost'), 'file:///photos/a.png', STROKES, { mimeType: 'image/png' }),
    )).rejects.toThrow('composer.upload.maxAttachments');
    expect(hook.options.enqueueUploads).not.toHaveBeenCalled();
    // 目标仍在:替换不占新槽位。
    const present = mountHook({ getRemainingAttachmentSlots: () => 0, getAttachment: (id) => attachment(id) });
    await traySubmit(present.api(), 'A', 'file:///photos/a.png');
    expect(present.enqueued()[0].replacesAttachmentId).toBe('A');
  });

  it('keeps the annotated flag when re-saving an already-burned image whose edit data was lost', async () => {
    const hook = mountHook({ getAttachment: (id) => attachment(id, { annotated: true }) });
    await traySubmit(hook.api(), 'R', 'file:///staged/r.png', []);
    const candidate = hook.enqueued()[0];
    expect(runtime.burnIn).not.toHaveBeenCalled();
    expect(candidate.annotation).toMatchObject({ strokes: [], baseAnnotated: true });
    const resaved = hook.api().decorateUploadedAttachment(attachment('R2'), candidate);
    expect(resaved.annotated).toBe(true);
    // 旧红线位置不可知:不带区域,退回固定说明。
    expect(resaved.annotationRegions).toBeUndefined();
    // 之后再次保存(已有内存真相但底图仍是烧录图):标仍保留。
    await traySubmit(hook.api(), 'R2', hook.api().trayImageSourceUri('R2', 'preview'), []);
    const again = hook.enqueued()[1];
    expect(again.annotation).toMatchObject({ strokes: [], baseAnnotated: true });
    expect(hook.api().decorateUploadedAttachment(attachment('R3'), again).annotated).toBe(true);
    // 普通底图撤光笔迹 = 恢复原图,不打标。
    const plain = mountHook({ getAttachment: (id) => attachment(id) });
    await traySubmit(plain.api(), 'P', 'file:///staged/p.png', []);
    expect(plain.enqueued()[0].annotation).toBeUndefined();
  });
});

describe('burn source preparation', () => {
  it('transcodes HEIC to high-quality JPEG with the native manipulator on Android, and falls back when it fails', async () => {
    runtime.platform = 'android';
    const hook = mountHook();
    await chatSubmit(hook.api(), 'file:///photos/x.heic', [], { mimeType: 'image/heic' });
    expect(runtime.manipulations).toHaveLength(1);
    expect(runtime.manipulations[0].resize).toBeUndefined();
    expect(runtime.manipulations[0].save).toEqual({ format: 'jpeg', compress: 0.92 });
    expect(runtime.burnIn).toHaveBeenLastCalledWith(expect.objectContaining({ mimeType: 'image/jpeg', strokes: [] }));
    expect(runtime.burnIn.mock.calls[0][0]).not.toHaveProperty('strokeSpace');
    expect(runtime.deleted).toContain('file:///cache/ImageManipulator/out-1'); // 中间产物烧完即删
    expect(hook.enqueued()[0].mimeType).toBe('image/jpeg');
    expect(hook.enqueued()[0].annotation).toBeUndefined();
    expect(hook.enqueued()[0].name).toMatch(/^image-\d+\.jpg$/);

    runtime.manipulatorError = new Error('unsupported');
    await chatSubmit(hook.api(), 'file:///photos/y.heic', [], { mimeType: 'image/heic' });
    expect(runtime.burnIn).toHaveBeenLastCalledWith(expect.objectContaining({ mimeType: 'image/heic' }));
  });

  it('falls back to the original path when the transcoded file exceeds the source size limit', async () => {
    runtime.platform = 'android';
    runtime.sizes['file:///cache/ImageManipulator/'] = 31 * 1024 * 1024;
    const hook = mountHook();
    await chatSubmit(hook.api(), 'file:///photos/x.heic', STROKES, { mimeType: 'image/heic' });
    expect(runtime.manipulations).toHaveLength(1);
    expect(runtime.deleted).toContain('file:///cache/ImageManipulator/out-1');
    expect(runtime.burnIn).toHaveBeenLastCalledWith(expect.objectContaining({ mimeType: 'image/heic' }));
  });

  it('keeps the existing WebView path for HEIC on iOS', async () => {
    const hook = mountHook();
    await chatSubmit(hook.api(), 'file:///photos/x.heic', [], { mimeType: 'image/heic', naturalWidth: 800, naturalHeight: 600 });
    expect(runtime.manipulations).toHaveLength(0);
    expect(runtime.burnIn).toHaveBeenLastCalledWith(expect.objectContaining({ mimeType: 'image/heic' }));
  });

  it('pre-downscales large photos and burns strokes in the original stroke space', async () => {
    runtime.manipulatorResult = { width: 2048, height: 1536 };
    runtime.burnIn.mockResolvedValueOnce({ base64: 'b3V0', mimeType: 'image/jpeg', width: 2048, height: 1536 });
    const hook = mountHook();
    await chatSubmit(hook.api(), 'file:///photos/big.jpg', STROKES, { mimeType: 'image/jpeg', naturalWidth: 4032, naturalHeight: 3024 });
    expect(runtime.manipulations[0]).toMatchObject({ resize: { width: 2048 }, save: { format: 'jpeg', compress: 1 } });
    expect(runtime.burnIn).toHaveBeenLastCalledWith(expect.objectContaining({
      mimeType: 'image/jpeg',
      strokeSpace: { width: 4032, height: 3024 },
    }));
    expect(runtime.burnIn.mock.calls[0][0]).not.toHaveProperty('finalize');
    const candidate = hook.enqueued()[0];
    // 烧录产物照旧交给上传前处理(尺寸 / 字节数带上,不跳过 preprocess)。
    expect(candidate).toMatchObject({ mimeType: 'image/jpeg', width: 2048, height: 1536, size: 1234 });
    expect(candidate.skipPreprocess).toBeUndefined();
    // 再编辑真相仍指向未缩的原图副本。
    expect(candidate.annotation?.sourceUri).toMatch(/annotation-src\/src-/);
  });

  it('falls back to the original bytes when the manipulator result does not match the viewer size', async () => {
    runtime.manipulatorResult = { width: 1536, height: 2048 };
    runtime.burnIn.mockResolvedValueOnce({ base64: 'b3V0', mimeType: 'image/jpeg', width: 4032, height: 3024 });
    const hook = mountHook();
    await chatSubmit(hook.api(), 'file:///photos/big.jpg', STROKES, { mimeType: 'image/jpeg', naturalWidth: 4032, naturalHeight: 3024 });
    const request = runtime.burnIn.mock.calls[0][0];
    expect(request).not.toHaveProperty('strokeSpace');
    expect(runtime.deleted).toContain('file:///cache/ImageManipulator/out-1');
    expect(hook.enqueued()[0].skipPreprocess).toBeUndefined();
    expect(hook.enqueued()[0]).toMatchObject({ width: 4032, height: 3024 });
  });

  it('does not pass the viewer size on direct (stroke-free) forwarding, keeping the original resolution policy', async () => {
    const hook = mountHook();
    await chatSubmit(hook.api(), 'file:///photos/shot.png', [], { mimeType: 'image/png', naturalWidth: 3000, naturalHeight: 2000 });
    expect(runtime.burnIn).not.toHaveBeenCalled();
    expect(runtime.manipulations).toHaveLength(0);
    const candidate = hook.enqueued()[0];
    expect(candidate).toMatchObject({ mimeType: 'image/png', size: 1234 });
    expect(candidate.width).toBeUndefined();
    expect(candidate.height).toBeUndefined();
    expect(candidate.skipPreprocess).toBeUndefined();
  });

  it('exposes burn-in prewarm on both lightbox configs', () => {
    const hook = mountHook();
    expect(hook.api().chatAnnotation.prewarm).toBe(runtime.acquireWarm);
    expect(hook.api().trayAnnotation.prewarm).toBe(runtime.acquireWarm);
  });
});
