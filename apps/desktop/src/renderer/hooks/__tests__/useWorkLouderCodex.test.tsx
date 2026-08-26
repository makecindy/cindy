// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  createWorkLouderCodexDefaultSettings,
  type WorkLouderCodexState,
} from '../../../shared/workLouderCodex';
import { useWorkLouderCodex } from '../useWorkLouderCodex';

function state(
  connectionStatus: WorkLouderCodexState['connectionStatus'],
  lightingBrightness = 100,
): WorkLouderCodexState {
  return {
    connectionStatus,
    connectionReason: null,
    devicePresent: connectionStatus === 'connected' ? true : null,
    device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE },
    settings: {
      ...createWorkLouderCodexDefaultSettings(),
      lightingBrightness,
    },
    agentSlots: Array.from({ length: 6 }, (_, slot) => ({
      slot,
      sessionId: null,
      title: null,
      action: null,
    })),
    taskOptions: [],
    agentSlotCount: 6,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function installApi(api: {
  getState: () => Promise<WorkLouderCodexState>;
  setSettings: (patch: unknown) => Promise<WorkLouderCodexState>;
  resetSettings: () => Promise<WorkLouderCodexState>;
  openInputMonitoringSettings: () => Promise<void>;
  onStateChanged: (callback: (next: WorkLouderCodexState) => void) => () => void;
}): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { workLouderCodex: api },
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI');
  vi.clearAllMocks();
});

describe('useWorkLouderCodex', () => {
  it('keeps a pushed state when the initial snapshot resolves late', async () => {
    const initial = deferred<WorkLouderCodexState>();
    let onStateChanged: ((next: WorkLouderCodexState) => void) | undefined;
    installApi({
      getState: vi.fn(() => initial.promise),
      setSettings: vi.fn(),
      resetSettings: vi.fn(),
      openInputMonitoringSettings: vi.fn(),
      onStateChanged: vi.fn((callback) => {
        onStateChanged = callback;
        return vi.fn();
      }),
    });
    const { result } = renderHook(() => useWorkLouderCodex());

    act(() => onStateChanged?.(state('connected', 60)));
    await act(async () => {
      initial.resolve(state('connecting', 100));
      await initial.promise;
    });

    expect(result.current.state).toEqual(state('connected', 60));
  });

  it('preserves a newer connection status when a settings save fails', async () => {
    const saving = deferred<WorkLouderCodexState>();
    let onStateChanged: ((next: WorkLouderCodexState) => void) | undefined;
    installApi({
      getState: vi.fn(async () => state('connected')),
      setSettings: vi.fn(() => saving.promise),
      resetSettings: vi.fn(),
      openInputMonitoringSettings: vi.fn(),
      onStateChanged: vi.fn((callback) => {
        onStateChanged = callback;
        return vi.fn();
      }),
    });
    const { result } = renderHook(() => useWorkLouderCodex());
    await waitFor(() => expect(result.current.state).toEqual(state('connected')));

    let mutation!: Promise<void>;
    await act(async () => {
      mutation = result.current.setSettings({ lightingBrightness: 40 });
      await Promise.resolve();
    });
    expect(result.current.state?.settings.lightingBrightness).toBe(40);
    act(() => onStateChanged?.(state('not-detected')));
    await act(async () => {
      saving.reject(new Error('write failed'));
      await mutation;
    });

    expect(result.current.state).toEqual(state('not-detected'));
    expect(result.current.error).toBe('save');
  });
});
