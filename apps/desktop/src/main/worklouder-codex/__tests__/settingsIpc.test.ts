import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkLouderCodexSettings,
  WorkLouderCodexState,
} from '../../../shared/workLouderCodex.js';
import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  createWorkLouderCodexDefaultSettings,
} from '../../../shared/workLouderCodex.js';
import { createWorkLouderCodexSettingsIpc } from '../settingsIpc.js';

const DEFAULT_SETTINGS: WorkLouderCodexSettings = createWorkLouderCodexDefaultSettings();

const EVENT = { senderFrame: 'fake' };

function makeIpc(options?: {
  assertTrustedSender?: (event: unknown) => void;
  writeThrows?: boolean;
}) {
  let settings = createWorkLouderCodexDefaultSettings();
  const assertTrustedSender = vi.fn(options?.assertTrustedSender ?? (() => undefined));
  const writeSettings = vi.fn((patch: Partial<WorkLouderCodexSettings>) => {
    if (options?.writeThrows) throw new Error('EACCES: /internal/private/path readonly');
    settings = { ...settings, ...patch };
    return { ...settings };
  });
  const applySettings = vi.fn((next: WorkLouderCodexSettings) => {
    settings = { ...next };
  });
  const getState = vi.fn((): WorkLouderCodexState => ({
    connectionStatus: 'connected',
    connectionReason: null,
    devicePresent: true,
    device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE },
    settings: { ...settings },
    agentSlots: Array.from({ length: 6 }, (_, slot) => ({
      slot,
      sessionId: null,
      title: null,
      action: null,
    })),
    taskOptions: [],
    agentSlotCount: 6,
  }));
  const resetSettings = vi.fn(() => {
    settings = createWorkLouderCodexDefaultSettings();
    return { ...settings };
  });
  const openInputMonitoringSettings = vi.fn(async () => undefined);
  const probeDevice = vi.fn();
  const publishTasks = vi.fn();
  const setLayoutPreviewActive = vi.fn();
  const ipc = createWorkLouderCodexSettingsIpc({
    assertTrustedSender,
    getState,
    writeSettings,
    resetSettings,
    applySettings,
    openInputMonitoringSettings,
    probeDevice,
    publishTasks,
    setLayoutPreviewActive,
  });
  return {
    ipc,
    assertTrustedSender,
    getState,
    writeSettings,
    resetSettings,
    applySettings,
    openInputMonitoringSettings,
    probeDevice,
    publishTasks,
    setLayoutPreviewActive,
  };
}

describe('Work Louder Codex settings IPC business body', () => {
  it('rejects an untrusted sender before reading or writing device state', () => {
    const untrusted = () => {
      throw new Error('untrusted sender');
    };
    const { ipc, getState, writeSettings, applySettings } = makeIpc({
      assertTrustedSender: untrusted,
    });

    expect(() => ipc.get(EVENT)).toThrow('untrusted sender');
    expect(() => ipc.set(EVENT, { lightingBrightness: 50 })).toThrow('untrusted sender');
    expect(getState).not.toHaveBeenCalled();
    expect(writeSettings).not.toHaveBeenCalled();
    expect(applySettings).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'settings patch required'],
    [[], 'settings patch required'],
    [{}, 'cannot be empty'],
    [{ unknown: true }, 'unknown Work Louder Codex setting'],
    [{ lightingBrightness: '50' }, 'must be an integer'],
    [{ lightingBrightness: 49.5 }, 'must be an integer'],
    [{ lightingBrightness: -1 }, 'must be an integer'],
    [{ lightingBrightness: 101 }, 'must be an integer'],
    [{ lightingAutoDim: 'sometimes' }, 'lightingAutoDim is invalid'],
    [{ deviceEnabled: 1 }, 'must be a boolean'],
    [{ singleTapAgentKeys: 1 }, 'must be a boolean'],
  ])('rejects invalid payload %j with INVALID_PARAMS', (value, messagePart) => {
    const { ipc, writeSettings, applySettings } = makeIpc();

    expect(() => ipc.set(EVENT, value)).toThrow('[INVALID_PARAMS]');
    expect(() => ipc.set(EVENT, value)).toThrow(messagePart);
    expect(writeSettings).not.toHaveBeenCalled();
    expect(applySettings).not.toHaveBeenCalled();
  });

  it('persists, applies, and returns a valid settings patch', () => {
    const { ipc, writeSettings, applySettings } = makeIpc();
    const patch = {
      lightingBrightness: 40,
      lightingAutoDim: 'off' as const,
      singleTapAgentKeys: false,
    };

    const state = ipc.set(EVENT, patch);

    expect(writeSettings).toHaveBeenCalledWith(patch);
    expect(applySettings).toHaveBeenCalledWith({
      deviceEnabled: false,
      lightingBrightness: 40,
      lightingAutoDim: 'off',
      agentSource: 'last-sent',
      customAgentKeys: [null, null, null, null, null, null],
      singleTapAgentKeys: false,
      layout: DEFAULT_SETTINGS.layout,
    });
    expect(state.settings).toMatchObject({
      lightingBrightness: 40,
      lightingAutoDim: 'off',
      singleTapAgentKeys: false,
    });
  });

  it('re-checks the device on probe and refuses untrusted callers', () => {
    const { ipc, probeDevice, assertTrustedSender } = makeIpc();

    const state = ipc.probe(EVENT);

    expect(probeDevice).toHaveBeenCalledOnce();
    expect(state.settings).toBeTruthy();

    assertTrustedSender.mockImplementationOnce(() => {
      throw new Error('untrusted');
    });
    expect(() => ipc.probe(EVENT)).toThrow('untrusted');
    // Rejected before reaching the device.
    expect(probeDevice).toHaveBeenCalledOnce();
  });

  it('takes the sidebar task list, including tasks on linked machines', () => {
    const { ipc, publishTasks } = makeIpc();

    ipc.publishTasks(EVENT, [
      { id: 'local-1', title: 'Local task', pinnedAt: null, userSendAt: 1_700 },
      // Main cannot see this one at all — it lives in the renderer's remote store.
      { id: 'remote-1', title: 'Remote task', pinnedAt: 1_700_000_000_000, userSendAt: null },
    ]);

    expect(publishTasks).toHaveBeenCalledWith([
      { id: 'local-1', title: 'Local task', pinnedAt: null, userSendAt: 1_700 },
      { id: 'remote-1', title: 'Remote task', pinnedAt: 1_700_000_000_000, userSendAt: null },
    ]);
  });

  it('rejects a malformed task list rather than projecting garbage onto the keys', () => {
    const { ipc, publishTasks } = makeIpc();

    expect(() => ipc.publishTasks(EVENT, 'nope')).toThrow();
    expect(() => ipc.publishTasks(EVENT, [{ id: '', title: 'x', pinnedAt: null }])).toThrow();
    expect(() => ipc.publishTasks(EVENT, [{ id: 'a', title: 5, pinnedAt: null }])).toThrow();
    expect(() =>
      ipc.publishTasks(EVENT, [{ id: 'a', title: 'x'.repeat(513), pinnedAt: null, userSendAt: null }]),
    ).toThrow('title is too long');
    expect(() =>
      ipc.publishTasks(
        EVENT,
        Array.from({ length: 101 }, (_, index) => ({
          id: `task-${index}`,
          title: 'x',
          pinnedAt: null,
          userSendAt: null,
        })),
      ),
    ).toThrow('too long');
    expect(publishTasks).not.toHaveBeenCalled();
  });

  it('drops a published catalog that belongs to another account generation', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    expect(source).toContain('if (isAppSessionBoundaryPending()) return null;');
    expect(source).toContain('if (rendererTaskCatalogScope !== currentTaskCatalogScope())');
    expect(source).toContain('if (!scope) return;');
    expect(source).toContain('workLouderCodexLightingController.applySettings(readWorkLouderCodexSettings());');
    expect(source).toContain('workLouderCodexLightingController.start();');
    expect(source).toContain('const win = actionWindowRouter.resolve(action);');
    expect(source).toContain('if (systemFrontmostInput.handle(action)) return;');
    expect(source).toContain('return win === main || isSecondaryAppWindow(win);');
    expect(source.indexOf('applySettings(readWorkLouderCodexSettings())')).toBeLessThan(
      source.indexOf('workLouderCodexLightingController.start();'),
    );
  });

  it('still accepts a layout saved before voiceButtonMode was removed', () => {
    const { ipc } = makeIpc();

    // Older builds stored a microphone mode. The key now follows Cindy's own
    // microphone, but a settings object round-tripped from such a build must
    // not be rejected outright.
    const state = ipc.set(EVENT, {
      layout: { ...DEFAULT_SETTINGS.layout, voiceButtonMode: 'push-to-talk' },
    });

    expect(state.settings.layout).not.toHaveProperty('voiceButtonMode');
    expect(state.settings.layout.separateMicrophoneKeys).toBe(false);
  });

  it('resets all settings through the dedicated reset operation', () => {
    const { ipc, resetSettings, applySettings } = makeIpc();

    const state = ipc.reset(EVENT);

    expect(resetSettings).toHaveBeenCalledOnce();
    expect(applySettings).toHaveBeenCalledWith(DEFAULT_SETTINGS);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('toggles layout preview without writing settings', () => {
    const { ipc, setLayoutPreviewActive, writeSettings } = makeIpc();

    ipc.setLayoutPreviewActive(EVENT, true);
    ipc.setLayoutPreviewActive(EVENT, false);

    expect(setLayoutPreviewActive).toHaveBeenNthCalledWith(1, true, EVENT);
    expect(setLayoutPreviewActive).toHaveBeenNthCalledWith(2, false, EVENT);
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it('opens macOS Input Monitoring settings only for trusted callers', async () => {
    const { ipc, openInputMonitoringSettings } = makeIpc();

    await ipc.openInputMonitoringSettings(EVENT);

    expect(openInputMonitoringSettings).toHaveBeenCalledOnce();
  });

  it('converts persistence failures to INTERNAL without leaking file paths', () => {
    const { ipc, applySettings } = makeIpc({ writeThrows: true });
    let caught: Error | null = null;
    try {
      ipc.set(EVENT, { lightingBrightness: 20 });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain('[INTERNAL]');
    expect(caught?.message).not.toContain('/internal/private/path');
    expect(applySettings).not.toHaveBeenCalled();
  });
});
