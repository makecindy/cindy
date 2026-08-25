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
import { buildRewindDraftAttachments } from '@/lib/rewindDraftAttachments';

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
    expect(userMessageSrc).toMatch(/buildRewindDraftAttachments\(\{\s*images,\s*files\s*\}\)/);
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
