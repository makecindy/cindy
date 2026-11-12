/**
 * rewindDraftAttachments.test.ts
 * ---------------------------------------------------------------------------
 * Regression for issue #55: after rewinding a user message, the composer must
 * restore the message's pasted images and file attachments, not just text.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupRemovedCachedImage } from '@/hooks/useAttachments';
import {
  buildRewindDraftAttachments,
  dropMissingAnnotationSources,
  hasRestorableAnnotationSources,
  startRewindSourceProbe,
} from '@/lib/rewindDraftAttachments';

describe('buildRewindDraftAttachments', () => {
  it('restores cached image refs and persisted file refs into composer attachments', () => {
    const attachments = buildRewindDraftAttachments({
      images: [
        {
          url: 'xdt-image://session-a/cache-001.png',
          mimeType: 'image/png',
          originalName: 'pasted.png',
        },
      ],
      files: [
        { name: 'notes.txt', path: '/Users/sam/Desktop/notes.txt' },
        { name: 'spec.pdf', path: 'C:\\Users\\sam\\Documents\\spec.pdf' },
      ],
    });

    expect(attachments).toHaveLength(3);
    expect(attachments[0]).toMatchObject({
      name: 'pasted.png',
      path: 'xdt-image://session-a/cache-001.png',
      ext: '.png',
      size: 0,
      category: 'image',
      mimeType: 'image/png',
      url: 'xdt-image://session-a/cache-001.png',
      originalName: 'pasted.png',
    });
    expect(attachments[1]).toMatchObject({
      name: 'notes.txt',
      path: '/Users/sam/Desktop/notes.txt',
      ext: '.txt',
      category: 'text',
      mimeType: 'text/plain',
    });
    expect(attachments[2]).toMatchObject({
      name: 'spec.pdf',
      path: 'C:\\Users\\sam\\Documents\\spec.pdf',
      ext: '.pdf',
      category: 'pdf',
      mimeType: 'application/pdf',
    });
  });

  it('keeps in-memory base64 image fallbacks usable for the current renderer lifetime', () => {
    const attachments = buildRewindDraftAttachments({
      images: [
        {
          base64: 'abc123',
          mimeType: 'image/jpeg',
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: 'image-1.jpg',
      path: 'clipboard://rewind-1',
      ext: '.jpg',
      category: 'image',
      mimeType: 'image/jpeg',
      base64: 'abc123',
      originalName: 'image-1.jpg',
    });
  });

  it('restores an annotated history image as editable source + strokes (shared source)', () => {
    const strokes = [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }];
    const attachments = buildRewindDraftAttachments({
      images: [
        {
          url: 'cindy-media://blobs/burned.png',
          mimeType: 'image/png',
          originalName: 'shot-annotated.png',
          annotationSourceUrl: 'cindy-media://blobs/source.jpg',
          annotationStrokes: strokes,
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: 'shot-annotated.png',
      path: 'cindy-media://blobs/source.jpg',
      url: 'cindy-media://blobs/source.jpg',
      ext: '.jpg',
      mimeType: 'image/jpeg',
      category: 'image',
      cacheUrlShared: true,
      annotationStrokes: strokes,
    });
    expect(attachments[0].annotated).toBeUndefined();
    expect(attachments[0].annotationSourceUrl).toBeUndefined();
    // 深拷贝:草稿里的笔迹不与历史消息共享可变对象。
    expect(attachments[0].annotationStrokes?.[0]).not.toBe(strokes[0]);
    expect(attachments[0].annotationStrokes?.[0].points[0]).not.toBe(strokes[0].points[0]);
  });

  it('restores unknown historical file refs as generic composer attachments', () => {
    const attachments = buildRewindDraftAttachments({
      files: [
        { name: 'unknown.binarything', path: '/tmp/unknown.binarything' },
        { name: 'Dockerfile', path: '/tmp/Dockerfile' },
      ],
    });

    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      name: 'unknown.binarything',
      path: '/tmp/unknown.binarything',
      ext: '.binarything',
      category: 'file',
      mimeType: 'application/octet-stream',
    });
    expect(attachments[1]).toMatchObject({
      name: 'Dockerfile',
      path: '/tmp/Dockerfile',
      ext: '',
      category: 'text',
      mimeType: 'text/plain',
    });
  });
});

describe('rewind draft attachment wiring', () => {
  const userMessageSrc = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx'),
    'utf8',
  );
  const useAttachmentsSrc = readFileSync(
    resolve(__dirname, '..', 'hooks', 'useAttachments.ts'),
    'utf8',
  );
  // archive / delete 执行序列已从 CCAgentSidebarUpper 抽到共享 hook
  // useSessionLifecycleActions（sidebar 与 SessionContentHeader 共用），
  // "删除清理 image cache / 归档保留"的源码断言跟随逻辑落点指向 hook 文件。
  const lifecycleSrc = readFileSync(
    resolve(__dirname, '..', 'features', 'cc-agent', 'hooks', 'useSessionLifecycleActions.ts'),
    'utf8',
  );

  it('rewind prefill writes text plus attachments to the composer draft', () => {
    expect(userMessageSrc).toMatch(
      /buildRewindDraftAttachments\(\{\s*images:\s*draftImages,\s*files\s*\}\)/,
    );
    // 原图探测在确认框打开时发起,提交时同步取结果写草稿——不存在迟到的二次写入。
    expect(userMessageSrc).toMatch(/startRewindSourceProbe\(images\)[\s\S]{0,80}setRewindOpen\(true\)/);
    expect(userMessageSrc).toMatch(/probe\.imagesForDraft\(\)/);
    expect(userMessageSrc).not.toMatch(/dropMissingAnnotationSources\([^)]*\)\.then/);
    expect(userMessageSrc).toMatch(
      /saveComposerDraft\(sessionId,\s*\{\s*text:\s*draftText,\s*attachments:\s*draftAttachments/s,
    );
  });

  it('useAttachments listens for same-session external draft writes', () => {
    expect(useAttachmentsSrc).toMatch(/subscribeDraft\s+as\s+subscribeComposerDraft/);
    expect(useAttachmentsSrc).toMatch(/subscribeComposerDraft\(storageKey,\s*\(\)\s*=>/);
    expect(useAttachmentsSrc).toMatch(/setAttachments\(next\)/);
  });

  it('removing an unsent cached image deletes its cache file without touching sent-message clearFiles', () => {
    const clearStart = useAttachmentsSrc.indexOf('const clearFiles = useCallback');
    expect(clearStart).toBeGreaterThan(-1);
    const clearBlock = useAttachmentsSrc.slice(
      clearStart,
      useAttachmentsSrc.indexOf('return {', clearStart),
    );

    expect(clearBlock).not.toMatch(/cleanupCachedImages/);
  });

  it('deleting a session cleans that session image cache, while archive keeps history images', () => {
    expect(lifecycleSrc).toMatch(/if \(action === 'delete'\) \{/);
    expect(lifecycleSrc).toMatch(/cleanupSessionImages\(sessionId\)/);
    expect(lifecycleSrc).not.toMatch(/action === 'archive'[\s\S]{0,120}cleanupSessionImages/);
  });
});

describe('cleanupRemovedCachedImage', () => {
  const originalWindow = globalThis.window;
  let cleanupCachedImages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanupCachedImages = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electronAPI: {
          cleanupCachedImages,
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('uses the preload cleanupCachedImages API for removed cached image attachments', () => {
    cleanupRemovedCachedImage({ url: 'xdt-image://session-a/removed.png' });

    expect(cleanupCachedImages).toHaveBeenCalledWith(['xdt-image://session-a/removed.png']);
  });

  it('ignores non-cached image fallbacks', () => {
    cleanupRemovedCachedImage(undefined);
    cleanupRemovedCachedImage({ url: undefined });

    expect(cleanupCachedImages).not.toHaveBeenCalled();
  });

  it('does not throw if the cleanup bridge throws synchronously', () => {
    cleanupCachedImages.mockImplementationOnce(() => {
      throw new Error('bridge missing');
    });

    expect(() =>
      cleanupRemovedCachedImage({ url: 'xdt-image://session-a/removed.png' }),
    ).not.toThrow();
  });
});

describe('dropMissingAnnotationSources', () => {
  const annotated = {
    url: 'cindy-media://blobs/burned.png',
    mimeType: 'image/png',
    originalName: 'shot-annotated.png',
    annotationSourceUrl: 'cindy-media://blobs/gone.png',
    annotationStrokes: [{ points: [{ x: 0.5, y: 0.5 }] }],
  };
  const plain = { url: 'cindy-media://blobs/plain.png', mimeType: 'image/png', originalName: 'p.png' };

  it('detects which image lists need a source probe', () => {
    expect(hasRestorableAnnotationSources([plain])).toBe(false);
    expect(hasRestorableAnnotationSources([{ base64: 'x', mimeType: 'image/png' }])).toBe(false);
    expect(hasRestorableAnnotationSources([plain, annotated])).toBe(true);
  });

  it('falls back to the burned image (no strokes) when the unburned source is gone', async () => {
    const probe = vi.fn(async () => false);
    const images = await dropMissingAnnotationSources([plain, annotated], probe);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('cindy-media://blobs/gone.png');
    expect(images[0]).toBe(plain);
    expect(images[1]).toEqual({
      url: 'cindy-media://blobs/burned.png',
      mimeType: 'image/png',
      originalName: 'shot-annotated.png',
      // 烧录图本身带红线:保留标注身份。
      baseAnnotated: true,
    });
    const [attachment] = buildRewindDraftAttachments({ images: [images[1]] });
    expect(attachment).toMatchObject({
      url: 'cindy-media://blobs/burned.png',
      path: 'cindy-media://blobs/burned.png',
      baseAnnotated: true,
    });
    expect(attachment.annotationStrokes).toBeUndefined();
    expect(attachment.cacheUrlShared).toBeUndefined();
  });

  it('keeps the editable restore when the source still exists or the probe cannot decide', async () => {
    await expect(dropMissingAnnotationSources([annotated], async () => true)).resolves.toEqual([
      annotated,
    ]);
    await expect(
      dropMissingAnnotationSources([annotated], async () => {
        throw new Error('probe crashed');
      }),
    ).resolves.toEqual([annotated]);
  });
});

describe('startRewindSourceProbe (rewind draft timing)', () => {
  const annotated = {
    url: 'cindy-media://blobs/burned.png',
    mimeType: 'image/png',
    originalName: 'shot-annotated.png',
    annotationSourceUrl: 'cindy-media://blobs/gone.png',
    annotationStrokes: [{ points: [{ x: 0.5, y: 0.5 }] }],
  };

  it('never waits: before the probe settles the draft uses the editable images (old behavior)', async () => {
    let settle: (exists: boolean) => void = () => {};
    const probe = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const handle = startRewindSourceProbe([annotated], probe);

    // 提交时探测尚未完成:同步返回原列表,草稿照旧一次写完。
    expect(handle.imagesForDraft()).toEqual([annotated]);

    settle(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 探测完成后(例如确认框还开着时)再提交:丢失的原图退回烧录图。
    expect(handle.imagesForDraft()).toEqual([
      {
        url: 'cindy-media://blobs/burned.png',
        mimeType: 'image/png',
        originalName: 'shot-annotated.png',
        baseAnnotated: true,
      },
    ]);
  });

  it('does not probe at all when no image carries restorable annotations', () => {
    const probe = vi.fn(async () => false);
    const plain = [{ url: 'cindy-media://blobs/p.png', mimeType: 'image/png', originalName: 'p.png' }];
    const handle = startRewindSourceProbe(plain, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(handle.imagesForDraft()).toBe(plain);
  });
});
