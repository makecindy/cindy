// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontSettingsProvider, useFontSettings } from '@/hooks/useFontSettings';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
} from '../../shared/appearanceSettings';

const originalElectronAPI = window.electronAPI;
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(FontSettingsProvider, null, children);

function installBridge(initial: AppearanceSettings) {
  let snapshot = initial;
  let onChanged: ((next: AppearanceSettings) => void) | undefined;
  const setPatch = vi.fn(async (patch: Partial<AppearanceSettings>) => {
    snapshot = { ...snapshot, ...patch };
    onChanged?.(snapshot);
  });
  const logToMain = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appearanceSettings: {
        getSync: () => snapshot,
        setPatch,
        onChanged: (callback: typeof onChanged) => {
          onChanged = callback;
          return () => {
            onChanged = undefined;
          };
        },
      },
      logToMain,
    },
  });
  return {
    setPatch,
    logToMain,
    broadcast: (next: Partial<AppearanceSettings>) => {
      snapshot = { ...snapshot, ...next };
      onChanged?.(snapshot);
    },
  };
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: originalElectronAPI,
  });
});

describe('terminal font settings isolation', () => {
  it('patches and resets only terminal fields without rewriting UI or code CSS', async () => {
    const bridge = installBridge({
      ...DEFAULT_APPEARANCE_SETTINGS,
      uiFamily: 'Inter',
      uiSize: 16,
      codeFamily: 'Consolas',
      codeSize: 18,
    });
    const { result } = renderHook(() => useFontSettings(), { wrapper });
    const cssBefore = [document.documentElement.style.cssText, document.body.style.cssText];
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');
    const removeProperty = vi.spyOn(document.documentElement.style, 'removeProperty');

    act(() => {
      result.current.setTerminalFamily('  Menlo  ');
      result.current.setTerminalSize(20);
    });
    await waitFor(() => expect(bridge.setPatch).toHaveBeenCalledTimes(2));
    expect(bridge.setPatch.mock.calls).toEqual([
      [{ terminalFamily: 'Menlo' }],
      [{ terminalSize: 20 }],
    ]);
    expect(result.current.terminalFamily).toBe('Menlo');
    expect(result.current.terminalSize).toBe(20);
    expect(result.current.uiFamily).toBe('Inter');
    expect(result.current.uiSize).toBe(16);
    expect(result.current.codeFamily).toBe('Consolas');
    expect(result.current.codeSize).toBe(18);

    act(() => result.current.resetTerminalFamily());
    await waitFor(() => expect(bridge.setPatch).toHaveBeenCalledTimes(3));
    expect(bridge.setPatch).toHaveBeenLastCalledWith({ terminalFamily: '' });
    expect(result.current.terminalSize).toBe(20);
    act(() => result.current.resetTerminalSize());
    await waitFor(() => expect(bridge.setPatch).toHaveBeenCalledTimes(4));
    expect(bridge.setPatch).toHaveBeenLastCalledWith({ terminalSize: 13 });
    expect(result.current.terminalFamily).toBe('');
    expect(result.current.terminalSize).toBe(13);
    expect([document.documentElement.style.cssText, document.body.style.cssText]).toEqual(
      cssBefore,
    );
    expect(setProperty).not.toHaveBeenCalled();
    expect(removeProperty).not.toHaveBeenCalled();
  });

  it('receives terminal-only broadcasts without touching global font styles', () => {
    const bridge = installBridge({ ...DEFAULT_APPEARANCE_SETTINGS });
    const { result } = renderHook(() => useFontSettings(), { wrapper });
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');
    act(() => bridge.broadcast({ terminalFamily: 'Monaco', terminalSize: 17 }));
    expect(result.current.terminalFamily).toBe('Monaco');
    expect(result.current.terminalSize).toBe(17);
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('keeps newer pending values over broadcasts and restores confirmed terminal state on failure', async () => {
    const bridge = installBridge({ ...DEFAULT_APPEARANCE_SETTINGS });
    let rejectWrite!: (error: Error) => void;
    bridge.setPatch.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const { result } = renderHook(() => useFontSettings(), { wrapper });
    act(() => {
      result.current.setTerminalFamily('Menlo');
      result.current.setTerminalSize(18);
    });
    await waitFor(() => expect(bridge.setPatch).toHaveBeenCalledTimes(1));

    act(() => bridge.broadcast({ terminalFamily: 'Monaco', codeSize: 19 }));
    expect(result.current.terminalFamily).toBe('Menlo');
    expect(result.current.terminalSize).toBe(18);
    expect(result.current.codeSize).toBe(19);

    await act(async () => rejectWrite(new Error('write failed')));
    await waitFor(() => expect(bridge.setPatch).toHaveBeenCalledTimes(2));
    expect(result.current.terminalFamily).toBe('Monaco');
    expect(result.current.terminalSize).toBe(18);
    expect(result.current.codeSize).toBe(19);
    expect(bridge.setPatch).toHaveBeenLastCalledWith({ terminalSize: 18 });
    expect(bridge.logToMain).toHaveBeenCalledTimes(1);
  });
});
