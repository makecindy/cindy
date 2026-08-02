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

/** Build a minimal FileList-like object addFiles can iterate. */
function fileListOf(files: Array<{ name: string; size: number }>): FileList {
  const arr = files.map((f) => ({ name: f.name, size: f.size })) as unknown as File[];
  return Object.assign(arr, { item: (i: number) => arr[i] }) as unknown as FileList;
}

beforeEach(() => {
  toastWarning.mockClear();
  stageChatAttachment.mockReset();
  stageChatAttachment.mockResolvedValue({ success: true, path: '/cache/setup.exe.bin' });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getFilePath: (f: { name: string }) => `/tmp/${f.name}`,
    stageChatAttachment,
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useAttachments inline rejections', () => {
  it('routes an empty (0-byte) file to rejections, not a toast', async () => {
    const { result } = renderHook(() => useAttachments());

    await act(async () => {
      await result.current.addFiles(
        fileListOf([{ name: 'empty.png', size: 0 }]),
      );
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
});
