/**
 * broadcastTargets.test.ts
 * ---------------------------------------------------------------------------
 * Regression (P0-4.1): `broadcastToAllWindows` must only push high-frequency
 * `maker:*` events to app-content chat/sidebar windows, skipping hidden ghost
 * sandboxes, overlays, login popups, destroyed windows, and the prewarmed
 * hidden resource-usage window.
 *
 * Production entry: `selectMakerBroadcastTargets` / `shouldReceiveMakerBroadcast`.
 * Coverage gap: existing maker-ipc tests injected stubbed `broadcastToAllWindows`
 * callbacks and never exercised window target filtering.
 * Minimal input: list containing main, secondary, detached RSB, ghost sandbox,
 * voice overlay, prewarmed resource-usage, and destroyed BrowserWindow stubs.
 * Tier: unit.
 */

import { describe, expect, it } from 'vitest';
import type { BrowserWindow } from 'electron';

import {
  selectMakerBroadcastTargets,
  shouldReceiveMakerBroadcast,
} from '../broadcastTargets.js';
import { markAppContentWindow } from '../../windowFocusClassifier.js';
import { markResourceUsageWebContentsId } from '../../resource-usage-window/registry.js';

function fakeWindow(id: number, opts?: { destroyed?: boolean; wcDestroyed?: boolean }): BrowserWindow {
  return {
    isDestroyed: () => opts?.destroyed === true,
    webContents: {
      id,
      isDestroyed: () => opts?.wcDestroyed === true,
    },
  } as unknown as BrowserWindow;
}

describe('selectMakerBroadcastTargets', () => {
  it('delivers only to live app-content chat/sidebar windows and skips overlays, sandboxes, and resource usage', () => {
    const mainWin = fakeWindow(9101);
    const secondaryWin = fakeWindow(9102);
    const rsbWin = fakeWindow(9103);
    const resourceUsageWin = fakeWindow(9104);
    const ghostSandboxWin = fakeWindow(9105);
    const voiceOverlayWin = fakeWindow(9106);
    const destroyedWin = fakeWindow(9107, { destroyed: true });
    const disposedWcWin = fakeWindow(9108, { wcDestroyed: true });

    markAppContentWindow(mainWin);
    markAppContentWindow(secondaryWin);
    markAppContentWindow(rsbWin);
    markAppContentWindow(resourceUsageWin);
    markAppContentWindow(destroyedWin);
    markAppContentWindow(disposedWcWin);
    markResourceUsageWebContentsId(9104);

    const targets = selectMakerBroadcastTargets([
      mainWin,
      secondaryWin,
      rsbWin,
      resourceUsageWin,
      ghostSandboxWin,
      voiceOverlayWin,
      destroyedWin,
      disposedWcWin,
    ]);

    expect(targets).toEqual([mainWin, secondaryWin, rsbWin]);
    expect(shouldReceiveMakerBroadcast(ghostSandboxWin)).toBe(false);
    expect(shouldReceiveMakerBroadcast(voiceOverlayWin)).toBe(false);
    expect(shouldReceiveMakerBroadcast(resourceUsageWin)).toBe(false);
    expect(shouldReceiveMakerBroadcast(destroyedWin)).toBe(false);
    expect(shouldReceiveMakerBroadcast(disposedWcWin)).toBe(false);
  });
});
