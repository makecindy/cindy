// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexMicroGuardState } from '../../../shared/codexMicroGuard';
import { useCodexMicroGuard } from '../useCodexMicroGuard';

const DISABLED: CodexMicroGuardState = {
  supported: true,
  enabled: false,
  status: 'disabled',
};

const listeners = new Set<(state: CodexMicroGuardState) => void>();
const api = {
  getState: vi.fn(async () => DISABLED),
  setEnabled: vi.fn(async (enabled: boolean): Promise<CodexMicroGuardState> => ({
    supported: true,
    enabled,
    status: enabled ? 'protecting' : 'disabled',
  })),
  recover: vi.fn(async () => DISABLED),
  onStateChanged: vi.fn((listener: (state: CodexMicroGuardState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }),
};

describe('useCodexMicroGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { codexMicroGuard: api },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('loads, mutates, and follows main-process state pushes', async () => {
    const { result } = renderHook(() => useCodexMicroGuard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toEqual(DISABLED);

    await act(async () => result.current.setEnabled(true));
    expect(api.setEnabled).toHaveBeenCalledWith(true);
    expect(result.current.state?.status).toBe('protecting');

    act(() => {
      for (const listener of listeners) {
        listener({ supported: true, enabled: true, status: 'intercepted' });
      }
    });
    expect(result.current.state?.status).toBe('intercepted');
  });

  it('reloads authoritative state after a failed mutation', async () => {
    api.setEnabled.mockRejectedValueOnce(new Error('failed'));
    const { result } = renderHook(() => useCodexMicroGuard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.setEnabled(true));

    expect(result.current.error).toBe(true);
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual(DISABLED);

    act(() => {
      for (const listener of listeners) listener(DISABLED);
    });
    expect(result.current.error).toBe(false);
  });
});
