import { describe, expect, it, vi } from 'vitest';
import { createPluginAppearanceIpc } from '../pluginAppearanceIpc.js';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../shared/appearanceSettings.js';
import { PLUGIN_APPEARANCE_APPLIED, PLUGIN_APPEARANCE_FONT } from '../../../shared/pluginAppearance.js';

/* C4/C11: an acknowledgement is evidence only from the selected trusted window.
 * Minimum failure: another window claims a successful application. Tier: unit. */
describe('plugin appearance application bridge', () => {
  it('accepts only the selected window acknowledgement and leaves unconfirmed saves explicit', async () => {
    const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
    let message: { requestId: string } | undefined;
    const bridge = createPluginAppearanceIpc({ assertTrusted: () => {}, service: () => ({ font: async () => ({ family: 'font', base64: '' }) }) as never,
      viewingWindow: () => ({ id: 12, send: (_channel, raw) => { message = raw as { requestId: string }; } }) });
    bridge.register({ handle: (name: string, handler: (event: unknown, raw: unknown) => unknown) => handlers.set(name, handler) } as never);
    const applied = vi.fn(); const pending = bridge.apply(DEFAULT_APPEARANCE_SETTINGS).then(applied);
    handlers.get(PLUGIN_APPEARANCE_APPLIED)!({ sender: { id: 13 } }, { requestId: message!.requestId, status: 'applied' });
    await Promise.resolve(); expect(applied).not.toHaveBeenCalled();
    handlers.get(PLUGIN_APPEARANCE_APPLIED)!({ sender: { id: 12 } }, { requestId: message!.requestId, status: 'saved' });
    await pending; expect(applied).toHaveBeenCalledWith({ status: 'saved', reason: 'APPLICATION_PENDING' });
  });
  it('rejects untrusted font access and never accepts a renderer supplied path', async () => {
    const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(); let trusted = false;
    const font = vi.fn();
    const bridge = createPluginAppearanceIpc({ assertTrusted: () => { if (!trusted) throw new Error('untrusted'); },
      service: () => ({ font }) as never, viewingWindow: () => null });
    bridge.register({ handle: (name: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(name, handler) } as never);
    await expect(handlers.get(PLUGIN_APPEARANCE_FONT)!({}, 'uiFont')).rejects.toThrow('untrusted');
    trusted = true; await expect(handlers.get(PLUGIN_APPEARANCE_FONT)!({}, '/private/font.ttf')).rejects.toThrow('INVALID_PARAMS');
    expect(font).not.toHaveBeenCalled();
    expect(await bridge.apply(DEFAULT_APPEARANCE_SETTINGS)).toEqual({ status: 'saved', reason: 'NO_VIEWING_WINDOW' });
  });
});
