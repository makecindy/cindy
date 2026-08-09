import { describe, expect, it, vi } from 'vitest';

import type { AppshotCaptureResult } from '../../shared/appshots.js';
import type { AppshotShortcutState } from '../../main/appshots/shortcutService.js';
import { createAppshotsBridge } from '../appshotsBridge.js';

const result: AppshotCaptureResult = {
  captureId: 'capture-1',
  image: {
    url: 'cindy-media://blobs/example.png',
    filename: 'example.png',
    size: 9,
    mimeType: 'image/png',
  },
  metadata: {
    schemaVersion: 1,
    captureId: 'capture-1',
    capturedAt: '2026-08-06T01:02:03.000Z',
    applicationName: 'Example App',
    bundleIdentifier: null,
    windowTitle: null,
    accessibilityText: null,
    accessibilityTruncated: false,
  },
};

describe('createAppshotsBridge', () => {
  it('exposes fixed invoke channels and arguments', async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    const bridge = createAppshotsBridge({ invoke, on: vi.fn(), removeListener: vi.fn() });

    await bridge.capture();
    await bridge.listPending();
    await bridge.ack('capture-1');

    expect(invoke.mock.calls).toEqual([
      ['appshots:capture'],
      ['appshots:list-pending'],
      ['appshots:ack', 'capture-1'],
    ]);
  });

  it('strips the Electron event and removes the exact subscribed listener', () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const callback = vi.fn();
    const bridge = createAppshotsBridge({ invoke: vi.fn(), on, removeListener });

    const dispose = bridge.onCaptured(callback);
    expect(on).toHaveBeenCalledWith('appshots:captured', expect.any(Function));
    const listener = on.mock.calls[0][1];
    const electronEvent = { sender: 'must not escape' };
    listener(electronEvent, result);

    expect(callback).toHaveBeenCalledWith(result);
    expect(callback).not.toHaveBeenCalledWith(electronEvent, result);
    dispose();
    expect(removeListener).toHaveBeenCalledWith('appshots:captured', listener);
  });

  it('uses fixed settings channels and strips shortcut state events', async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    const on = vi.fn();
    const removeListener = vi.fn();
    const callback = vi.fn();
    const bridge = createAppshotsBridge({ invoke, on, removeListener });
    const preferences = {
      preferred: { kind: 'dual-modifier' as const, modifier: 'command' as const },
      fallback: { kind: 'accelerator' as const, combo: { code: 'KeyA', meta: true, ctrl: false, alt: false, shift: true } },
    };
    const state: AppshotShortcutState = {
      preferences,
      configured: preferences.preferred,
      active: preferences.preferred,
    };

    await bridge.getShortcutState();
    await bridge.setShortcutPreferences(preferences);
    await bridge.resetShortcutPreferences();
    const dispose = bridge.onShortcutStateChanged(callback);
    const listener = on.mock.calls[0][1];
    listener({ sender: 'must not escape' }, state);
    dispose();

    expect(invoke.mock.calls).toEqual([
      ['appshots:shortcut-state'],
      ['appshots:shortcut-preferences:set', preferences],
      ['appshots:shortcut-preferences:reset'],
    ]);
    expect(callback).toHaveBeenCalledWith(state);
    expect(removeListener).toHaveBeenCalledWith('appshots:shortcut-state-changed', listener);
  });
});
