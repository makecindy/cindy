import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';
import { createMediaDownloadContext } from '../mediaDownloadApproval.js';
import type { MediaDownloadReason } from '../mediaDownload.js';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../maker-ipc/interactionRouter.js', () => ({ requestHostInteraction: mocks.request }));

function hostSession(permissionMode?: string) {
  let status = 'active';
  let onStatus = () => {};
  const unsubscribe = vi.fn();
  const session = {
    id: 'task-1', instanceId: 'instance-1',
    stablePermissionModeState: { mode: permissionMode },
    runHostInteraction: (_request: unknown, resolve: () => Promise<unknown>) => resolve(),
    getTurnGeneration: () => 1,
    getStatus: () => status,
    isTurnRunning: () => status === 'active',
    onStatusChange: (listener: () => void) => { onStatus = listener; return unsubscribe; },
  } as unknown as Session;
  return { session, unsubscribe, stop: () => { status = 'aborting'; onStatus(); } };
}

describe('Host media permission', () => {
  afterEach(() => vi.useRealTimers());

  it('does not expire the download context while the upstream generation is running', async () => {
    vi.useFakeTimers();
    const host = hostSession();
    const ctx = createMediaDownloadContext(host.session, () => true);
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(ctx.signal?.aborted).toBe(false);
      expect(() => ctx.assertActive()).not.toThrow();
      host.stop();
      expect(ctx.signal?.aborted).toBe(true);
    } finally { ctx.dispose?.(); }
  });

  it('uses an ordinary single-use permission request with a reason and sanitized source', async () => {
    const host = hostSession();
    const ctx = createMediaDownloadContext(host.session, () => true);
    mocks.request.mockResolvedValue({ kind: 'permission', behavior: 'allow', updatedInput: { approved: true } });
    try {
      await expect(ctx.confirm({ source: 'https://cdn.example.com', reasons: ['source'] })).resolves.toBe(true);
      const [session, request, signal] = mocks.request.mock.calls.at(-1)!;
      expect(session).toBe(host.session);
      expect(request).toMatchObject({ kind: 'permission', toolName: 'cindy.media.download', input: { source: 'https://cdn.example.com' } });
      expect(request.description).toContain('newChat.mediaDownload.source');
      expect(request.suggestions).toBeUndefined();
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally { ctx.dispose?.(); }
    expect(host.unsubscribe).toHaveBeenCalledOnce();
  });

  it('passes the displayed private target to the ordinary permission card', async () => {
    const host = hostSession();
    const ctx = createMediaDownloadContext(host.session, () => true);
    const source = 'https://internal.example.com/media/view?operation=read&signature=%5BREDACTED%5D';
    mocks.request.mockResolvedValue({ kind: 'permission', behavior: 'allow' });
    try {
      await expect(ctx.confirm({ source, reasons: ['network'] })).resolves.toBe(true);
      expect(mocks.request.mock.calls.at(-1)![1]).toMatchObject({
        kind: 'permission', toolName: 'cindy.media.download', input: { source },
      });
    } finally { ctx.dispose?.(); }
  });

  it('rejects a late approval after the task stops', async () => {
    const host = hostSession();
    const ctx = createMediaDownloadContext(host.session, () => true);
    mocks.request.mockImplementation(async () => { host.stop(); return { kind: 'permission', behavior: 'allow' }; });
    try {
      await expect(ctx.confirm({ source: 'https://cdn.example.com', reasons: ['network'] })).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_DEFERRED' });
      expect(ctx.signal?.aborted).toBe(true);
    } finally { ctx.dispose?.(); }
  });

  it('skips the download confirmation under full access', async () => {
    mocks.request.mockClear();
    const host = hostSession('bypassPermissions');
    const ctx = createMediaDownloadContext(host.session, () => true);
    try {
      await expect(ctx.confirm({ source: 'https://cdn.example.com', reasons: ['source'] })).resolves.toBe(true);
      expect(mocks.request).not.toHaveBeenCalled();
    } finally { ctx.dispose?.(); }
  });

  // confirm() is the production approval entry. Full access skips only an ordinary
  // source; http / credentials / network (and a non-default port) must still raise the
  // card. The source-only case above does not catch an early return that approves every
  // reason. Smallest failing input: bypassPermissions plus one of those reasons.
  // Rule: docs/dev-rules/media-storage-and-protocols.md 「已授权生成任务的结果下载」. tier: unit.
  it.each<MediaDownloadReason[][]>([
    [['http']],
    [['credentials']],
    [['network']],
    [['port']],
    [['source', 'http']],
  ])('still asks under full access when reasons are %j', async (reasons) => {
    mocks.request.mockClear();
    const host = hostSession('bypassPermissions');
    const ctx = createMediaDownloadContext(host.session, () => true);
    mocks.request.mockResolvedValue({ kind: 'permission', behavior: 'allow' });
    try {
      await expect(ctx.confirm({ source: 'https://cdn.example.com', reasons })).resolves.toBe(true);
      expect(mocks.request).toHaveBeenCalledOnce();
    } finally { ctx.dispose?.(); }
  });

  it('still asks for confirmation when the session is not in full access', async () => {
    mocks.request.mockClear();
    const host = hostSession('auto');
    const ctx = createMediaDownloadContext(host.session, () => true);
    mocks.request.mockResolvedValue({ kind: 'permission', behavior: 'allow' });
    try {
      await expect(ctx.confirm({ source: 'https://cdn.example.com', reasons: ['source'] })).resolves.toBe(true);
      expect(mocks.request).toHaveBeenCalledOnce();
    } finally { ctx.dispose?.(); }
  });

  it('rejects approval when the live task instance changes', async () => {
    const host = hostSession();
    let current = true;
    const ctx = createMediaDownloadContext(host.session, () => current);
    mocks.request.mockImplementation(async () => { current = false; return { kind: 'permission', behavior: 'allow' }; });
    try {
      await expect(ctx.confirm({ source: 'https://cdn.example.com', reasons: ['source'] })).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_DEFERRED' });
    } finally { ctx.dispose?.(); }
  });
});
