/** @vitest-environment jsdom */

import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), saveDraft: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/composerDraftStore', () => ({ getDraft: mocks.getDraft, saveDraft: mocks.saveDraft }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { GHOST_MEDIA_HANDOVER_MIME } from '../../../shared/ghost';
import { attachGhostMediaToSession, getGhostMediaHandoverFromDataTransfer } from '../ghostMediaHandover';

const uri = 'cindy-ghost://helper/preview/' + 'a'.repeat(64) + '.png';
const translate = ((key: string) => key) as TFunction;

function transfer(entries: Record<string, string>): DataTransfer {
  return { types: Object.keys(entries), getData: (type: string) => entries[type] ?? '' } as unknown as DataTransfer;
}

describe('Ghost media handover', () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('uses the opaque source token, not a self-reported instance', async () => {
    const source = getGhostMediaHandoverFromDataTransfer(transfer({
      'text/uri-list': uri,
      [GHOST_MEDIA_HANDOVER_MIME]: JSON.stringify({ uri, sourceToken: 'opaque-source', instanceId: 'helper' }),
    }));
    expect(source).toEqual({ uri, sourceToken: 'opaque-source' });
    const resolvePanelMedia = vi.fn().mockResolvedValue({ kind: 'video', absPath: '/blobs/video.mp4', name: 'video.mp4', ext: '.mp4', size: 42, mimeType: 'video/mp4' });
    const cacheMediaForSession = vi.fn();
    vi.stubGlobal('electronAPI', { ghosts: { resolvePanelMedia }, cacheMediaForSession });
    await attachGhostMediaToSession(source!, 'session', translate);
    expect(resolvePanelMedia).toHaveBeenCalledExactlyOnceWith(uri, 'attach', undefined, 'opaque-source');
    expect(cacheMediaForSession).not.toHaveBeenCalled();
    expect(mocks.saveDraft).toHaveBeenCalledWith('session', expect.objectContaining({
      attachments: [expect.objectContaining({ category: 'file', path: '/blobs/video.mp4' })],
    }), { preserveRemoteOptimisticRecovery: true });
  });

  it('retains the old root API and the image cache attachment path', async () => {
    const source = getGhostMediaHandoverFromDataTransfer(transfer({ 'text/uri-list': '# comment' + String.fromCharCode(10) + uri }));
    expect(source).toEqual({ uri, sourceToken: '' });
    const resolvePanelMedia = vi.fn().mockResolvedValue({ url: 'cindy-media://blobs/image.png' });
    const cacheMediaForSession = vi.fn().mockResolvedValue({ name: 'image.png', ext: '.png', size: 42, mimeType: 'image/png', url: 'cindy-media://cache/image.png' });
    vi.stubGlobal('electronAPI', { ghosts: { resolvePanelMedia }, cacheMediaForSession });
    await attachGhostMediaToSession(uri, 'session', translate);
    expect(resolvePanelMedia).toHaveBeenCalledExactlyOnceWith(uri);
    expect(cacheMediaForSession).toHaveBeenCalledExactlyOnceWith({ url: 'cindy-media://blobs/image.png', sessionId: 'session' });
    expect(mocks.saveDraft).toHaveBeenCalledWith('session', expect.objectContaining({
      attachments: [expect.objectContaining({ category: 'image', url: 'cindy-media://cache/image.png' })],
    }), { preserveRemoteOptimisticRecovery: true });
  });

  it.each(['broken-json', '{}', JSON.stringify({ sourceToken: 42 }), JSON.stringify({ sourceToken: '' })])('does not downgrade malformed Cindy MIME %s to a legacy URI', async (payload) => {
    const source = getGhostMediaHandoverFromDataTransfer(transfer({ 'text/uri-list': uri, [GHOST_MEDIA_HANDOVER_MIME]: payload }));
    expect(source?.sourceToken).toBe('');
    const resolvePanelMedia = vi.fn().mockRejectedValue(new Error('NOT_FOUND'));
    vi.stubGlobal('electronAPI', { ghosts: { resolvePanelMedia } });
    await attachGhostMediaToSession(source!, 'session', translate);
    expect(resolvePanelMedia).toHaveBeenCalledExactlyOnceWith(uri, 'attach', undefined, '');
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it('ignores unrelated drops and retains plain text fallback', () => {
    expect(getGhostMediaHandoverFromDataTransfer(transfer({ 'text/plain': 'hello' }))).toBeNull();
    expect(getGhostMediaHandoverFromDataTransfer(transfer({ 'text/plain': uri }))).toEqual({ uri, sourceToken: '' });
  });

  it('does not treat a deleted source MIME as a legacy root attachment request', async () => {
    const source = getGhostMediaHandoverFromDataTransfer(transfer({ 'text/uri-list': uri }));
    const resolvePanelMedia = vi.fn().mockRejectedValue(new Error('NOT_FOUND'));
    vi.stubGlobal('electronAPI', { ghosts: { resolvePanelMedia } });
    await attachGhostMediaToSession(source!, 'session', translate);
    expect(resolvePanelMedia).toHaveBeenCalledExactlyOnceWith(uri, 'attach', undefined, '');
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });
});
