import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';
import { createMediaDownloadContext } from '../mediaDownloadApproval.js';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../maker-ipc/interactionRouter.js', () => ({ requestHostInteraction: mocks.request }));

function hostSession() {
  let status = 'active';
  let onStatus = () => {};
  const unsubscribe = vi.fn();
  const session = {
    id: 'task-1', instanceId: 'instance-1',
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
