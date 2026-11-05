import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PluginAppearanceService } from '../pluginAppearanceService.js';
import * as appearanceResources from '../pluginAppearanceResources.js';
import { DEFAULT_APPEARANCE_SETTINGS, normalizeAppearanceSettings, type AppearanceSettings } from '../../../shared/appearanceSettings.js';

/* C11: real service calls must enforce declarations, locked rechecks and honest
 * application receipts. Existing settings tests do not call from a plugin.
 * Minimal input: one field or a source change at publication. Tier: unit. */
function fixture(fields = ['uiFont', 'reading', 'theme']) {
  let settings = normalizeAppearanceSettings({ uiFamily: 'Inter' });
  let instance: { id: string; token: string; key: string; dir: string; ui: unknown } | null =
    { id: 'example', token: 'runtime', key: 'a'.repeat(64), dir: '/unused', ui: { version: 1, appearance: { fields } } };
  let beforeUpdate = () => {};
  let iconBytes: Buffer | null = null;
  let ready = true;
  const nativeIcons: Array<Buffer | null> = [];
  const saveWallpaper = vi.fn<ConstructorParameters<typeof PluginAppearanceService>[0]['saveWallpaper']>(async () => ({ url: '' }));
  const rendererApply = vi.fn(() => apply());
  let apply: () => Promise<{ status: 'applied' | 'saved' | 'failed'; reason?: string }> = async () => ({ status: 'saved', reason: 'NO_VIEWING_WINDOW' });
  const createService = () => new PluginAppearanceService({ ready: () => ready, current: id => instance?.id === id ? instance : null,
    files: { describe: async () => iconBytes ? { size: iconBytes.length, mimeType: 'image/png' } : null,
      read: async () => iconBytes ? new Response(new Uint8Array(iconBytes)) : new Response(null, { status: 404 }) },
    read: () => settings, update: async updater => { beforeUpdate(); settings = normalizeAppearanceSettings({ ...settings, ...updater(settings) }); return settings; },
    saveWallpaper, revokeWallpaper: async () => false,
    publish: () => {}, apply: rendererApply, applyAppIcon: bytes => { nativeIcons.push(bytes); },
  });
  const service = createService();
  return { service, get: () => settings, replace: (next: Partial<AppearanceSettings>) => { settings = normalizeAppearanceSettings({ ...settings, ...next }); },
    beforeUpdate: (fn: () => void) => { beforeUpdate = fn; }, setApply: (fn: typeof apply) => { apply = fn; }, revoke: () => { instance = null; },
    icon: (bytes: Buffer) => { iconBytes = bytes; }, nativeIcons, rendererApply, restart: createService,
    ready: (value: boolean) => { ready = value; }, saveWallpaper,
    replaceInstance: (id: string, key: string) => { instance = { id, key, token: 'replacement', dir: '/unused', ui: { version: 1, appearance: { fields } } }; } };
}
describe('plugin appearance calls', () => {
  // PR #8909: a user's wallpaper choice while a plugin is acquiring the
  // existing wallpaper lock must survive an older compare-and-set request.
  it('checks the expected revision before publishing a prepared wallpaper', async () => {
    const h = fixture(['wallpaper']);
    const url = (hash: string) => `cindy-media://client-wallpaper/${hash.repeat(64)}.webp`;
    h.replace({ wallpaperId: 'custom', customWallpaperUrl: url('a') });
    const expected = h.service.read('example').revision;
    vi.spyOn(appearanceResources, 'loadPluginAppearanceResource').mockResolvedValueOnce({
      kind: 'image', bytes: Buffer.from('prepared'), mimeType: 'image/webp', hash: 'd'.repeat(64),
    });
    let entered!: () => void, unlock!: () => void;
    const enteredLock = new Promise<void>(resolve => { entered = resolve; });
    const lock = new Promise<void>(resolve => { unlock = resolve; });
    h.saveWallpaper.mockImplementation(async (_bytes, options) => {
      entered(); await lock;
      options.assertCurrent();
      h.replace({ customWallpaperUrl: url('c') });
      return { url: url('c') };
    });
    const pending = h.service.handle('example', { kind: 'set', ifRevision: expected,
      patch: { wallpaper: { resource: 'library:background.webp' } } });
    await enteredLock;
    h.replace({ customWallpaperUrl: url('b') }); unlock();
    const result = await pending;
    vi.mocked(appearanceResources.loadPluginAppearanceResource).mockRestore();
    expect(result).toMatchObject({ ok: false, error: { code: 'APPEARANCE_CHANGED' } });
    expect(h.get().customWallpaperUrl).toBe(url('b'));
  });
  it('applies and resets a runtime app icon without waiting for a viewing page', async () => {
    const h = fixture(['appIcon']);
    h.icon(await sharp({ create: { width: 16, height: 16, channels: 4, background: '#123456' } }).png().toBuffer());
    expect(await h.service.handle('example', { kind: 'set', patch: { appIcon: { resource: 'library:icon.png' } } }))
      .toMatchObject({ ok: true, data: { values: { appIcon: { resource: 'library:icon.png' } }, application: { status: 'applied' } } });
    expect(h.nativeIcons[0]).toBeInstanceOf(Buffer);
    expect(h.rendererApply).not.toHaveBeenCalled();
    expect(h.get().appIconResource).toMatchObject({ reference: 'library:icon.png', source: { instanceId: 'example' } });
    expect(await h.service.handle('example', { kind: 'reset', fields: ['appIcon'] })).toMatchObject({ ok: true, data: { application: { status: 'applied' } } });
    expect(h.nativeIcons.at(-1)).toBeNull(); expect(h.get().appIconResource).toBeUndefined();
    expect(h.get().uiFamily).toBe('Inter');
  });
  it('preserves the current app icon when a resource is invalid or undeclared', async () => {
    const undeclared = fixture(['uiFont']);
    expect(await undeclared.service.handle('example', { kind: 'set', patch: { appIcon: { resource: 'library:icon.png' } } }))
      .toMatchObject({ ok: false, error: { code: 'FIELD_NOT_DECLARED' } });
    const h = fixture(['appIcon']); h.icon(Buffer.from('not an image'));
    expect(await h.service.handle('example', { kind: 'set', patch: { appIcon: { resource: 'library:icon.png' } } }))
      .toMatchObject({ ok: false, error: { code: 'RESOURCE_TYPE' } });
    expect(h.get().appIconResource).toBeUndefined(); expect(h.nativeIcons).toEqual([]);
  });
  it('restores an approved app icon after restart and releases it on revocation', async () => {
    const h = fixture(['appIcon']);
    h.icon(await sharp({ create: { width: 16, height: 16, channels: 4, background: '#abcdef' } }).png().toBuffer());
    await h.service.handle('example', { kind: 'set', patch: { appIcon: { resource: 'library:icon.png' } } });
    h.nativeIcons.length = 0;
    await h.restart().restoreAppIcon(); expect(h.nativeIcons[0]).toBeInstanceOf(Buffer);
    h.ready(false); await h.service.reconcile();
    expect(h.nativeIcons.at(-1)).toBeNull(); expect(h.get().appIconResource).toBeDefined();
    h.ready(true); h.revoke(); await h.service.reconcile();
    expect(h.get().appIconResource).toBeUndefined(); expect(h.nativeIcons.at(-1)).toBeNull();
  });
  it('does not erase a replacement plugin app icon during stale-source cleanup', async () => {
    const h = fixture(['appIcon']);
    h.icon(await sharp({ create: { width: 16, height: 16, channels: 4, background: '#abcdef' } }).png().toBuffer());
    await h.service.handle('example', { kind: 'set', patch: { appIcon: { resource: 'library:icon.png' } } });
    const resource = h.get().appIconResource!;
    h.revoke();
    h.beforeUpdate(() => {
      h.replaceInstance('replacement', 'b'.repeat(64));
      h.replace({ appIconResource: { ...resource, source: { instanceId: 'replacement', key: 'b'.repeat(64) } } });
    });
    await h.service.reconcile();
    expect(h.get().appIconResource?.source.instanceId).toBe('replacement');
    expect(h.nativeIcons.at(-1)).toBeInstanceOf(Buffer);
  });
  it('does not apply a page write after the page binding has expired', async () => {
    const h = fixture(); let current = true;
    h.beforeUpdate(() => { current = false; });
    const assertPage = () => { if (!current) throw new Error('CONTEXT_CHANGED'); };
    expect(await h.service.handle('example', { kind: 'set', patch: { uiFont: { size: 20 } } }, assertPage))
      .toMatchObject({ ok: false, error: { code: 'CONTEXT_CHANGED' } });
    expect(h.get().uiSize).not.toBe(20);
  });
  it('bounds in-flight writes without blocking reads or replaying rejected work', async () => {
    const h = fixture(), completions: Array<() => void> = [];
    h.setApply(() => new Promise(resolve => { completions.push(() => resolve({ status: 'applied' })); }));
    const first = h.service.handle('example', { kind: 'set', patch: { uiFont: { size: 16 } } });
    const second = h.service.handle('example', { kind: 'set', patch: { reading: { maxWidth: 720 } } });
    expect(await h.service.handle('example', { kind: 'set', patch: { uiFont: { size: 22 } } }))
      .toMatchObject({ ok: false, error: { code: 'APPEARANCE_BUSY' } });
    expect(await h.service.handle('example', { kind: 'read' })).toMatchObject({ ok: true });
    expect(completions).toHaveLength(2); completions.forEach(complete => complete());
    await Promise.all([first, second]); expect(h.get().uiSize).toBe(16);
  });
  it('exposes only declared fields and rejects private or undeclared writes', async () => {
    const h = fixture(['uiFont']);
    // The default size belongs to appearance tokens, not this capability test.
    expect(h.service.read('example').values).toEqual({ uiFont: { family: 'Inter', size: DEFAULT_APPEARANCE_SETTINGS.uiSize } });
    expect(await h.service.handle('example', { kind: 'set', patch: { theme: { light: { text: '#123456' } } } })).toMatchObject({ ok: false, error: { code: 'FIELD_NOT_DECLARED' } });
    expect(await h.service.handle('example', { kind: 'set', patch: { windowZoom: 3 } })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(h.get().windowZoom).toBe(1);
  });
  it('keeps user updates when a plugin supplies a stale revision, including an update while acquiring the lock', async () => {
    const h = fixture(), expected = h.service.read('example').revision;
    h.beforeUpdate(() => h.replace({ uiSize: 18 }));
    expect(await h.service.handle('example', { kind: 'set', ifRevision: expected, patch: { uiFont: { size: 20 } } }))
      .toMatchObject({ ok: false, error: { code: 'APPEARANCE_CHANGED' } });
    expect(h.get().uiSize).toBe(18);
  });
  it('reports saved without claiming visible application and resets only named fields', async () => {
    const h = fixture();
    expect(await h.service.handle('example', { kind: 'set', patch: { reading: { maxWidth: 720 }, theme: { dark: { text: '#eeeeee' } } } }))
      .toMatchObject({ ok: true, data: { values: { reading: { maxWidth: 720 }, theme: { dark: { text: '#eeeeee' } } }, application: { status: 'saved' } } });
    expect(await h.service.handle('example', { kind: 'reset', fields: ['reading'] })).toMatchObject({ ok: true });
    expect(h.get().reading).toBeUndefined(); expect(h.get().uiFamily).toBe('Inter');
    expect(h.get().themeColors).toEqual({ dark: { text: '#eeeeee' } });
  });
  it('rechecks the runtime before publication and preserves a manually replaced font on revocation', async () => {
    const h = fixture(); h.beforeUpdate(h.revoke);
    expect(await h.service.handle('example', { kind: 'set', patch: { uiFont: { size: 20 } } })).toMatchObject({ ok: false, error: { code: 'CONTEXT_CHANGED' } });
    expect(h.get().uiSize).not.toBe(20);
    const k = fixture(); k.replace({ uiFontResource: { family: `CindyPlugin_${'b'.repeat(64)}`, hash: 'b'.repeat(64), reference: 'asset:font', source: { instanceId: 'example', key: 'a'.repeat(64) } } });
    k.revoke(); await k.service.reconcile();
    expect(k.get().uiFamily).toBe('Inter'); expect(k.get().uiFontResource).toBeUndefined();
  });
});
