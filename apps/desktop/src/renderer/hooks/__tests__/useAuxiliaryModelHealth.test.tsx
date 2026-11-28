// @vitest-environment jsdom
// Unit: settings follow provider repairs and coalesce concurrent invalidations; only a failed custom session can notify.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuxiliaryModelHealth } from '../../../shared/auxiliaryModelHealth';

const mocks = vi.hoisted(() => ({
  health: { status: 'ok' } as AuxiliaryModelHealth,
  listener: undefined as ((event: { section: string; ownerStamp: unknown }) => void) | undefined,
  providerListener: undefined as (() => void) | undefined,
  getHealth: vi.fn<() => Promise<AuxiliaryModelHealth>>(),
  secondary: false,
  toastWarning: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => mocks.secondary }));
vi.mock('@/lib/toast', () => ({ toast: { warning: mocks.toastWarning } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ isDataOwnerPushStampCurrent: () => true }));

import { useAuxiliaryModelHealth } from '../useAuxiliaryModelHealth';

const configProblem = (issue: 'provider_disabled' | 'signed_out'): AuxiliaryModelHealth => ({
  status: 'unavailable',
  kind: 'config',
  candidates: [{ ref: 'a', label: 'A · Cindy AI', issue }],
  since: 1,
});

/** Main changes the state and announces it on the app-settings push. */
async function push(next: AuxiliaryModelHealth): Promise<void> {
  mocks.health = next;
  await act(async () => {
    mocks.listener?.({ section: 'auxiliary-model-health', ownerStamp: null });
  });
}

describe('useAuxiliaryModelHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.health = { status: 'ok' };
    mocks.getHealth.mockReset().mockImplementation(async () => mocks.health);
    mocks.secondary = false;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        auxiliaryModelHealthGet: mocks.getHealth,
        onProvidersChanged: (listener: () => void) => {
          mocks.providerListener = listener;
          return () => { mocks.providerListener = undefined; };
        },
      },
      appPreferenceControl: {
        onSettingsChanged: (listener: typeof mocks.listener) => {
          mocks.listener = listener;
          return () => { mocks.listener = undefined; };
        },
      },
    };
  });

  afterEach(() => cleanup());

  it('refreshes the diagnostic after a provider repair without raising a global toast', async () => {
    mocks.health = configProblem('provider_disabled');
    const { result } = renderHook(() => useAuxiliaryModelHealth());
    await waitFor(() => expect(result.current).toEqual(mocks.health));
    let finish!: (health: AuxiliaryModelHealth) => void;
    mocks.getHealth.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { mocks.providerListener?.(); });
    mocks.health = { status: 'ok' };
    await act(async () => {
      mocks.providerListener?.();
      mocks.providerListener?.();
      expect(mocks.getHealth).toHaveBeenCalledTimes(2);
      finish(configProblem('provider_disabled'));
    });
    expect(mocks.getHealth).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ status: 'ok' });
    await push(configProblem('signed_out'));
    expect(result.current).toEqual(mocks.health);
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });
});
