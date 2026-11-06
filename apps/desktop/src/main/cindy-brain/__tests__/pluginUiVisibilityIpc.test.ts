import { describe, expect, it, vi } from 'vitest';
import { createPluginUiVisibilityIpc } from '../pluginUiVisibilityIpc.js';
import { PLUGIN_UI_VISIBILITY_APPLIED, PLUGIN_UI_VISIBILITY_GET, PLUGIN_UI_VISIBILITY_RELEASE } from '../../../shared/pluginUiVisibility.js';

describe('plugin visibility window application', () => {
  it('accepts acknowledgement only from the affected trusted window', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    let requestId = '';
    const nativeButtons = vi.fn();
    const bridge = createPluginUiVisibilityIpc({ assertTrusted: () => {}, snapshot: () => ({} as never), open: () => true, close: () => {},
      window: id => ({ id, nativeButtons, send: (_channel, raw) => { requestId = (raw as { requestId: string }).requestId; } }) });
    bridge.register({ handle: (name: string, handler: (event: unknown, input: unknown) => unknown) => handlers.set(name, handler) } as never);
    const done = vi.fn();
    const pending = bridge.apply(12, { workspace: false, windowControls: true } as never).then(done);
    expect(nativeButtons).toHaveBeenCalledWith(false);
    handlers.get(PLUGIN_UI_VISIBILITY_APPLIED)!({ sender: { id: 13 } }, { requestId });
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    handlers.get(PLUGIN_UI_VISIBILITY_APPLIED)!({ sender: { id: 12 } }, { requestId });
    await pending; expect(done).toHaveBeenCalledWith('applied');
  });
  it('registers only a trusted window with the main layout and releases it on unmount', () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const close = vi.fn();
    const bridge = createPluginUiVisibilityIpc({ assertTrusted: () => {}, snapshot: () => ({ workspace: true } as never),
      open: id => id === 12, close, window: () => null });
    bridge.register({ handle: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) } as never);
    expect(() => handlers.get(PLUGIN_UI_VISIBILITY_GET)!({ sender: { id: 13 } })).toThrow('VISIBILITY_UNAVAILABLE');
    expect(handlers.get(PLUGIN_UI_VISIBILITY_GET)!({ sender: { id: 12 } })).toEqual({ workspace: true });
    handlers.get(PLUGIN_UI_VISIBILITY_RELEASE)!({ sender: { id: 12 } });
    expect(close).toHaveBeenCalledWith(12);
  });
  it('reports an unavailable window without claiming success', async () => {
    const bridge = createPluginUiVisibilityIpc({ assertTrusted: () => {}, snapshot: () => ({} as never), open: () => false, close: () => {}, window: () => null });
    expect(await bridge.apply(12, {} as never)).toBe('unconfirmed');
  });
});
