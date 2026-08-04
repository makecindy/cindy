// @vitest-environment jsdom
/**
 * useAttachmentsRejections.test.ts
 * ---------------------------------------------------------------------------
 * Regression for the inline attachment-rejection feedback. A non-attachable
 * file (here: a 0-byte empty file) must surface as an inline `rejections`
 * entry (rendered in the composer) rather than a transient top-center toast
 * that users missed.
 *
 * 对标 Codex Desktop 去掉大小 / 数量 / 类型校验后,rejection 的触发源收敛为
 * "文件本身不可用"(fileEmpty / readFailed);这里用空文件触发。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastWarning = vi.hoisted(() => vi.fn());
const stageChatAttachment = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  // Echo the key + interpolate name/reason so the assertions stay readable.
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() },
}));

import { useAttachments } from '@/hooks/useAttachments';
import {
  clearDraft,
  discardDraft,
  getDraft,
  setComposerDraftOwner,
} from '@/lib/composerDraftStore';
import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

/** Build a minimal FileList-like object addFiles can iterate. */
function fileListOf(files: Array<{ name: string; size: number }>): FileList {
  const arr = files.map((f) => ({ name: f.name, size: f.size })) as unknown as File[];
  return Object.assign(arr, { item: (i: number) => arr[i] }) as unknown as FileList;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
}

beforeEach(() => {
  dataOwnerTesting.reset();
  setComposerDraftOwner(null);
  toastWarning.mockClear();
  stageChatAttachment.mockReset();
  stageChatAttachment.mockResolvedValue({ success: true, path: '/cache/setup.exe.bin' });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getFilePath: (f: { name: string }) => `/tmp/${f.name}`,
    stageChatAttachment,
  };
});

afterEach(() => {
  dataOwnerTesting.reset();
  setComposerDraftOwner(null);
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useAttachments inline rejections', () => {
  it('routes an empty (0-byte) file to rejections, not a toast', async () => {
    const { result } = renderHook(() => useAttachments());

    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'empty.png', size: 0 }]));
    });

    expect(result.current.rejections).toHaveLength(1);
    expect(result.current.rejections[0].message).toContain('empty.png');
    expect(result.current.attachments).toHaveLength(0);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('dismissRejection removes a single row; clearRejections empties all', async () => {
    const { result } = renderHook(() => useAttachments());

    await act(async () => {
      await result.current.addFiles(
        fileListOf([
          { name: 'a.png', size: 0 },
          { name: 'b.png', size: 0 },
        ]),
      );
    });
    expect(result.current.rejections).toHaveLength(2);

    const firstId = result.current.rejections[0].id;
    act(() => result.current.dismissRejection(firstId));
    expect(result.current.rejections).toHaveLength(1);

    act(() => result.current.clearRejections());
    expect(result.current.rejections).toHaveLength(0);
  });

  it('clears rejections on in-place session switch (same hook instance)', async () => {
    const { result, rerender } = renderHook(({ sid }: { sid: string }) => useAttachments(sid), {
      initialProps: { sid: 'session-A' },
    });

    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'a.png', size: 0 }]));
    });
    expect(result.current.rejections).toHaveLength(1);

    // Switching to another session must not leave A's pill above B's composer.
    act(() => rerender({ sid: 'session-B' }));
    expect(result.current.rejections).toHaveLength(0);
  });

  it('stages a dangerous attachment under an inert path before adding it', async () => {
    const { result } = renderHook(() => useAttachments());

    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'setup.exe', size: 64 }]));
    });

    expect(stageChatAttachment).toHaveBeenCalledWith({
      sourcePath: '/tmp/setup.exe',
      suggestedName: 'setup.exe',
    });
    expect(result.current.rejections).toHaveLength(0);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toMatchObject({
      name: 'setup.exe',
      path: '/cache/setup.exe.bin',
      ext: '.exe',
      category: 'file',
    });
  });

  it('fails closed when dangerous attachment staging fails', async () => {
    stageChatAttachment.mockResolvedValue({ success: false, code: 'copy_failed' });
    const { result } = renderHook(() => useAttachments());

    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'setup.exe', size: 64 }]));
    });

    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.rejections).toHaveLength(1);
    expect(result.current.rejections[0].message).toContain('setup.exe');
    expect(result.current.rejections[0].message).toContain('copy_failed');
  });

  it('restores sent attachments without dropping files added while send was in flight', async () => {
    const { result } = renderHook(() => useAttachments());

    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'sent.pdf', size: 128 }]));
    });
    const sentAttachments = [...result.current.attachments];
    expect(sentAttachments).toHaveLength(1);

    act(() => result.current.clearFiles());
    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'new-during-rtt.pdf', size: 256 }]));
      result.current.restoreFiles(sentAttachments);
    });

    expect(result.current.attachments.map((attachment) => attachment.name)).toEqual([
      'sent.pdf',
      'new-during-rtt.pdf',
    ]);
  });

  it('does not mirror an old owner attachment draft into a new owner with the same key', async () => {
    const key = 'shared-owner-switch-draft';
    setDataOwnerGeneration('owner-a');
    setComposerDraftOwner('owner-a');
    const { result, rerender, unmount } = renderHook(() => useAttachments(undefined, key));

    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'owner-a.pdf', size: 128 }]));
    });
    expect(result.current.attachments.map((attachment) => attachment.name)).toEqual([
      'owner-a.pdf',
    ]);

    act(() => {
      setDataOwnerGeneration('owner-b');
      setComposerDraftOwner('owner-b');
      rerender();
    });

    expect(result.current.attachments).toEqual([]);
    expect(getDraft(key)?.attachments ?? []).toEqual([]);
    unmount();

    setDataOwnerGeneration('owner-a');
    setComposerDraftOwner('owner-a');
    expect(getDraft(key)?.attachments.map((attachment) => attachment.name)).toEqual([
      'owner-a.pdf',
    ]);
    clearDraft(key);
    setDataOwnerGeneration('owner-b');
    setComposerDraftOwner('owner-b');
    clearDraft(key);
  });

  it('writes a delayed file peek back to its captured session instead of the newly opened one', async () => {
    const peek = deferred<{ success: true; actualBytes: number; data: string }>();
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      getFilePath: (file: { name: string }) => `/tmp/${file.name}`,
      peekFileHeader: vi.fn(() => peek.promise),
      cleanupCachedImages: vi.fn(async () => undefined),
    };
    const { result, rerender, unmount } = renderHook(
      ({ sid }: { sid: string }) => useAttachments(sid),
      { initialProps: { sid: 'attachment-session-A' } },
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.addFiles(fileListOf([{ name: 'README', size: 5 }]));
    });
    act(() => rerender({ sid: 'attachment-session-B' }));
    await act(async () => {
      peek.resolve({ success: true, actualBytes: 5, data: 'aGVsbG8=' });
      await pending;
    });

    expect(result.current.attachments).toEqual([]);
    expect(getDraft('attachment-session-A')?.attachments).toEqual([
      expect.objectContaining({ name: 'README' }),
    ]);
    expect(getDraft('attachment-session-B')?.attachments ?? []).toEqual([]);

    unmount();
    clearDraft('attachment-session-A');
    clearDraft('attachment-session-B');
  });

  it('keeps a delayed clipboard cache bound to the session captured before navigation', async () => {
    const arrayBuffer = deferred<ArrayBuffer>();
    const cacheImageFromBuffer = vi.fn(async () => ({
      url: 'xdt-image://attachment-session-A/clipboard.png',
    }));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      getFilePath: (file: { name: string }) => `/tmp/${file.name}`,
      cacheImageFromBuffer,
      cleanupCachedImages: vi.fn(async () => undefined),
    };
    const clipboardBlob = {
      type: 'image/png',
      size: 4,
      arrayBuffer: () => arrayBuffer.promise,
    } as Blob;
    const { result, rerender, unmount } = renderHook(
      ({ sid }: { sid: string }) => useAttachments(sid),
      { initialProps: { sid: 'attachment-session-A' } },
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.addClipboardImage(clipboardBlob);
    });
    act(() => rerender({ sid: 'attachment-session-B' }));
    await act(async () => {
      arrayBuffer.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
      await pending;
    });

    expect(cacheImageFromBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'attachment-session-A' }),
    );
    expect(result.current.attachments).toEqual([]);
    expect(getDraft('attachment-session-A')?.attachments).toEqual([
      expect.objectContaining({ url: 'xdt-image://attachment-session-A/clipboard.png' }),
    ]);
    expect(getDraft('attachment-session-B')?.attachments ?? []).toEqual([]);
    expect(toastWarning).not.toHaveBeenCalled();

    unmount();
    clearDraft('attachment-session-A');
    clearDraft('attachment-session-B');
  });

  it('does not recreate an attachment draft when the session draft is discarded before unmount', async () => {
    const sessionId = 'discarded-attachment-session';
    const { result, unmount } = renderHook(() => useAttachments(sessionId));

    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'discard-me.pdf', size: 128 }]));
    });
    expect(getDraft(sessionId)?.attachments).toEqual([
      expect.objectContaining({ name: 'discard-me.pdf' }),
    ]);

    act(() => discardDraft(sessionId));
    expect(result.current.attachments).toEqual([]);
    expect(getDraft(sessionId)).toBeUndefined();

    unmount();
    expect(getDraft(sessionId)).toBeUndefined();
  });

  it('recycles a delayed clipboard cache instead of restoring a discarded session draft', async () => {
    const sessionId = 'discarded-delayed-attachment-session';
    const cached = deferred<{ url: string }>();
    const cleanupCachedImages = vi.fn(async () => undefined);
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      getFilePath: (file: { name: string }) => `/tmp/${file.name}`,
      cacheImageFromBuffer: vi.fn(() => cached.promise),
      cleanupCachedImages,
    };
    const clipboardBlob = {
      type: 'image/png',
      size: 1,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as Blob;
    const { result, unmount } = renderHook(() => useAttachments(sessionId));

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.addClipboardImage(clipboardBlob);
      await Promise.resolve();
    });
    act(() => discardDraft(sessionId));
    await act(async () => {
      cached.resolve({ url: `xdt-image://${sessionId}/late.png` });
      await pending;
    });

    expect(result.current.attachments).toEqual([]);
    expect(getDraft(sessionId)).toBeUndefined();
    expect(cleanupCachedImages).toHaveBeenCalledWith([`xdt-image://${sessionId}/late.png`]);

    unmount();
    expect(getDraft(sessionId)).toBeUndefined();
  });

  it('drops and cleans a cached image when the data owner changes before completion', async () => {
    setDataOwnerGeneration('owner-a');
    setComposerDraftOwner('owner-a');
    const cached = deferred<{ url: string }>();
    const cleanupCachedImages = vi.fn(async () => undefined);
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      getFilePath: (file: { name: string }) => `/tmp/${file.name}`,
      cacheImageFromBuffer: vi.fn(() => cached.promise),
      cleanupCachedImages,
    };
    const clipboardBlob = {
      type: 'image/png',
      size: 1,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as Blob;
    const { result, rerender, unmount } = renderHook(() =>
      useAttachments('owner-boundary-attachment-session'),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.addClipboardImage(clipboardBlob);
      await Promise.resolve();
    });
    act(() => {
      setDataOwnerGeneration('owner-b');
      setComposerDraftOwner('owner-b');
      rerender();
    });
    await act(async () => {
      cached.resolve({ url: 'xdt-image://owner-a/late.png' });
      await pending;
    });

    expect(result.current.attachments).toEqual([]);
    expect(cleanupCachedImages).toHaveBeenCalledWith(['xdt-image://owner-a/late.png']);
    expect(result.current.rejections).toEqual([]);

    unmount();
    clearDraft('owner-boundary-attachment-session');
    setDataOwnerGeneration('owner-a');
    setComposerDraftOwner('owner-a');
    clearDraft('owner-boundary-attachment-session');
  });
});
