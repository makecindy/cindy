import { describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { PluginWallpaperSlot } from '../wallpaperSlot.js';

// Unit: new autonomous wallpaper capability (plugin-security §3/§5).
// Existing file-picker tests cannot exercise plugin consent or revoke/owner races.
// Minimal failure: wallpaper:true retained by an old Host without a receipt grant.
function harness() {
  let ghost = {
    enabled: true,
    manifest: { id: 'daily-wallpaper', wallpaper: true },
    approval: { state: 'approved', revision: 'revision-1' },
    wallpaperCapabilityApproved: true,
  } as InstalledGhost;
  let scope = 'owner-a';
  const setImage = vi.fn(async (_bytes: Buffer, assertCurrent: () => void) => { assertCurrent(); });
  const readImage = vi.fn(async () => Buffer.from('image bytes') as Buffer | null);
  const slot = new PluginWallpaperSlot({ getGhost: () => ghost, scope: () => scope, readImage, setImage });
  return { slot, setImage, readImage, ghost: () => ghost,
    patch: (patch: Partial<InstalledGhost>) => { ghost = { ...ghost, ...patch }; },
    switchOwner: () => { scope = 'owner-b'; } };
}
const request = { mediaUrl: 'cindy-media://blobs/' + 'a'.repeat(64) + '.webp' };

describe('plugin wallpaper admission', () => {
  it('requires an enabled approved installation, declaration and explicit wallpaper consent', async () => {
    for (const patch of [
      { enabled: false }, { approval: { state: 'invalid' } },
      { manifest: { wallpaper: undefined } }, { wallpaperCapabilityApproved: undefined },
    ]) {
      const h = harness(); h.patch(patch as Partial<InstalledGhost>);
      expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED' });
      expect(h.setImage).not.toHaveBeenCalled();
    }
  });

  it('accepts granted image references and rejects external URLs, paths and other media scopes', async () => {
    const h = harness();
    expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: true });
    expect(h.setImage.mock.calls[0][0]).toEqual(Buffer.from('image bytes'));
    expect(h.readImage).toHaveBeenCalledWith('daily-wallpaper', request.mediaUrl, expect.any(Function));
    for (const raw of [null, [], { url: 'https://example.com/image.png' },
      { mediaUrl: 'https://example.com/image.png' }, { mediaUrl: '/private/image.png' },
      { mediaUrl: request.mediaUrl.replace('blobs/', 'client-wallpaper/') },
      { mediaUrl: request.mediaUrl.replace('.webp', '.mp4') }, { mediaUrl: request.mediaUrl + '?x=1' }]) {
      expect(await h.slot.handle('daily-wallpaper', raw)).toEqual({ ok: false, errorCode: 'INVALID_PARAMS' });
    }
    h.readImage.mockResolvedValueOnce(null);
    expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED' });
    h.readImage.mockResolvedValueOnce(Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(h.setImage).toHaveBeenCalledTimes(1);
  });

  it.each(['disable', 'replace', 'owner', 'revoke'])(
    'rechecks %s changes during decoding before publishing', async (change) => {
      const h = harness();
      h.setImage.mockImplementationOnce(async (_bytes, assertCurrent) => {
        if (change === 'disable') h.patch({ enabled: false });
        if (change === 'replace') h.patch({ approval: { state: 'approved', revision: 'revision-2' } });
        if (change === 'owner') h.switchOwner();
        if (change === 'revoke') h.patch({ wallpaperCapabilityApproved: undefined });
        assertCurrent();
      });
      expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED' });
    },
  );

  it('rejects overlapping writes and releases admission after a sanitized failure', async () => {
    const h = harness();
    let finish!: () => void;
    h.setImage.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = h.slot.handle('daily-wallpaper', request);
    expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: false, errorCode: 'BUSY' });
    finish(); await pending;
    h.setImage.mockRejectedValueOnce(new Error('/private/path: disk error'));
    expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: false, errorCode: 'INTERNAL' });
    expect(await h.slot.handle('daily-wallpaper', request)).toEqual({ ok: true });
  });
});
