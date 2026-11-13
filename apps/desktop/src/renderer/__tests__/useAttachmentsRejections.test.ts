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
import { useLayoutEffect } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ghostHostUiApprovalTokens, type InstalledGhost } from '../../shared/ghost';

const toastWarning = vi.hoisted(() => vi.fn());
const stageChatAttachment = vi.hoisted(() => vi.fn());
const cleanupStaged = vi.hoisted(() => vi.fn(async () => {}));
const plugins = vi.hoisted(() => ({ ghosts: [] as InstalledGhost[], call: vi.fn() }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => plugins.ghosts, readInstalledGhostsSnapshot: () => plugins.ghosts }));

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

function enableAttachmentProvider(extensions = ['.pdf']) {
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'parse', name: 'Parse', kind: 'chip',
      version: '1', entry: 'main.js', tools: [{ name: 'parse', description: 'Parse' }], mcpApps: {
        ui: { resources: [], tools: { parse: { visibility: ['app'] } } }, host: { contributions: [
          { id: 'parse', title: 'Parse attachment', position: 'composer.attachment', tool: 'parse', accept: { extensions } },
        ] },
      } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); plugins.ghosts = [ghost];
}

beforeEach(() => {
  dataOwnerTesting.reset();
  setComposerDraftOwner(null);
  toastWarning.mockClear();
  stageChatAttachment.mockReset();
  plugins.ghosts = []; plugins.call.mockReset();
  cleanupStaged.mockClear();
  stageChatAttachment.mockResolvedValue({ success: true, path: '/cache/setup.exe.bin' });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getFilePath: (f: { name: string }) => `/tmp/${f.name}`,
    stageChatAttachment,
    cleanupStagedChatAttachments: cleanupStaged,
    maker: { mcpApps: plugins.call },
  };
});

afterEach(() => {
  dataOwnerTesting.reset();
  setComposerDraftOwner(null);
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useAttachments inline rejections', () => {
  // B, unit: the real add/drop hook must keep the user's file while processing,
  // append text through the same draft and discard late output after removal.
  // Existing read/cache failures do not exercise plugin processing.
  it('keeps the original attachment during processing and applies the result to its own draft', async () => {
    enableAttachmentProvider();
    const pending = deferred<unknown>(); plugins.call.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useAttachments(undefined, 'plugin-attachment'));
    await act(async () => { await result.current.addFiles(fileListOf([{ name: 'input.pdf', size: 5 }])); });
    expect(result.current.attachments.map(file => file.name)).toEqual(['input.pdf']);
    expect(plugins.call).toHaveBeenCalledWith(null, expect.objectContaining({ op: 'plugin-action',
      input: { attachment: { name: 'input.pdf', uri: '/tmp/input.pdf', size: 5, mimeType: 'application/pdf' } } }));
    await act(async () => pending.resolve({ handled: true, text: 'Extracted text' }));
    expect(JSON.stringify(getDraft('plugin-attachment')?.text)).toContain('Extracted text');
    expect(result.current.attachments).toEqual([]);
    act(() => discardDraft('plugin-attachment'));
  });
  // Unit, #9987: addFiles must adopt a valid result across an unrelated roster
  // broadcast. Removal/revocation coverage does not rebuild the provider entry;
  // the minimal failure is a cloned roster while its tool call is pending.
  it('applies the attachment result after an unrelated plugin refresh rebuilds the roster', async () => {
    enableAttachmentProvider();
    const key = 'plugin-unrelated-refresh';
    const pending = deferred<unknown>();
    plugins.call.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useAttachments(undefined, key));
    await act(async () => { await result.current.addFiles(fileListOf([{ name: 'input.pdf', size: 5 }])); });
    expect(plugins.call).toHaveBeenCalledTimes(1);
    plugins.ghosts = [...structuredClone(plugins.ghosts), {
      enabled: true, dir: '/ordinary', approval: { state: 'approved', revision: 'ordinary' },
      manifest: { schemaVersion: 3, id: 'ordinary', name: 'Ordinary', kind: 'chip', version: '1', entry: 'main.js' },
    }];
    await act(async () => pending.resolve({ handled: true, text: 'Extracted after refresh', files: [
      { name: 'output.txt', path: '/cache/output.txt.bin', size: 1, mimeType: 'text/plain' },
    ] }));
    expect(JSON.stringify(getDraft(key)?.text)).toContain('Extracted after refresh');
    expect(result.current.attachments.map(file => file.name)).toEqual(['output.txt']);
    expect(getDraft(key)?.attachments).toEqual(result.current.attachments);
    expect(cleanupStaged).not.toHaveBeenCalledWith(['/cache/output.txt.bin']);
    act(() => discardDraft(key));
  });
  it.each(['remove', 'revoke', 'disable', 'update'] as const)('discards late output and releases staged files after %s', async kind => {
    enableAttachmentProvider();
    const pending = deferred<unknown>();
    plugins.call.mockImplementation((_session, input) => input.op === 'plugin-action' ? pending.promise : Promise.resolve({}));
    const key = `plugin-late-${kind}`;
    const { result } = renderHook(() => useAttachments(undefined, key));
    await act(async () => { await result.current.addFiles(fileListOf([{ name: 'input.pdf', size: 5 }])); });
    if (kind === 'remove') act(() => result.current.removeFile(result.current.attachments[0].id));
    else {
      plugins.ghosts = structuredClone(plugins.ghosts);
      if (kind === 'revoke') plugins.ghosts[0].approvedHostUi = [];
      else if (kind === 'disable') plugins.ghosts[0].enabled = false;
      else plugins.ghosts[0].approval = { state: 'approved', revision: 'two' };
    }
    await act(async () => pending.resolve({ handled: true, text: 'Late text', files: [
      { name: 'output.txt', path: '/cache/output.txt.bin', size: 1, mimeType: 'text/plain' },
    ] }));
    expect(JSON.stringify(getDraft(key)?.text)).not.toContain('Late text');
    expect(result.current.attachments.map(file => file.name)).toEqual(kind === 'remove' ? [] : ['input.pdf']);
    expect(cleanupStaged).toHaveBeenCalledWith(['/cache/output.txt.bin']);
    act(() => discardDraft(key));
  });
  // Unit, #9987: removal/revocation did not cover editing the same attachment id.
  // Saving image annotations during an in-flight provider call must win, and
  // returned staged files must be released without deleting the annotated image.
  it('preserves saved image annotations when the attachment provider finishes late', async () => {
    enableAttachmentProvider(['.png']);
    const key = 'plugin-late-annotation';
    const pending = deferred<unknown>();
    plugins.call.mockImplementation((_session, input) => input.op === 'plugin-action' ? pending.promise : Promise.resolve({}));
    const cleanupImages = vi.fn(async () => {});
    Object.assign(window.electronAPI, {
      cacheImageFromPath: vi.fn(async () => ({ url: 'cindy-media://blobs/photo.png' })),
      cleanupCachedImages: cleanupImages,
    });
    const { result } = renderHook(() => useAttachments(key));
    await act(async () => { await result.current.addFiles(fileListOf([{ name: 'photo.png', size: 5 }])); });
    expect(plugins.call).toHaveBeenCalledWith(key, expect.objectContaining({ op: 'plugin-action' }));
    const id = result.current.attachments[0].id;
    act(() => result.current.updateFile(id, { annotationStrokes: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }] }));
    const annotated = result.current.attachments[0];
    await act(async () => pending.resolve({ handled: true, text: 'Outdated extraction', files: [
      { name: 'output.txt', path: '/cache/output.txt.bin', size: 1, mimeType: 'text/plain' },
    ] }));
    expect(result.current.attachments).toEqual([annotated]);
    expect(getDraft(key)?.attachments).toEqual([annotated]);
    expect(JSON.stringify(getDraft(key)?.text)).not.toContain('Outdated extraction');
    expect(cleanupStaged).toHaveBeenCalledWith(['/cache/output.txt.bin']);
    expect(cleanupImages).not.toHaveBeenCalled();
    act(() => discardDraft(key));
  });
  it('does not restore sent files from a pending draft mirror', async () => {
    const key = 'draft-mirror-send';
    clearDraft(key);
    Object.assign(window.electronAPI, {
      cacheImageFromPath: vi.fn(async () => ({ url: 'cindy-media://blobs/photo.png' })),
    });
    let sent = false;
    const { result, unmount } = renderHook(() => {
      const attachments = useAttachments(key, key);
      // PR #8937: send can clear the tray before the selected file's draft effect runs.
      useLayoutEffect(() => {
        if (!sent && attachments.attachments.length > 0) {
          sent = true;
          attachments.clearFiles();
        }
      }, [attachments.attachments, attachments.clearFiles]);
      return attachments;
    });
    await act(async () => {
      await result.current.addFiles(fileListOf([{ name: 'photo.png', size: 7 }]));
    });
    expect(sent).toBe(true);
    expect(result.current.attachments).toHaveLength(0);
    expect(getDraft(key)?.attachments ?? []).toHaveLength(0);
    unmount();
    expect(getDraft(key)?.attachments ?? []).toHaveLength(0);
    clearDraft(key);
  });

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
