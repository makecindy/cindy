// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useKeepAwakeSetting', () => ({
  useKeepAwakeSetting: () => ({ keepAwake: false, setKeepAwake: vi.fn() }),
}));

vi.mock('@/hooks/useSwallowActivationClickSettings', () => ({
  useSwallowActivationClickSettings: () => ({ enabled: false, setEnabled: vi.fn() }),
}));

vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: ({
    isCustomized,
    onReset,
  }: {
    isCustomized: boolean;
    onReset: () => void;
  }) =>
    isCustomized ? (
      <button type="button" onClick={onReset} aria-label="restore-interrupted-resume-default" />
    ) : null,
}));

import { WindowBehaviorSection } from '../WindowBehaviorSection';

function installElectronApi() {
  let state = { enabled: true, isCustomized: false, defaultEnabled: true };
  const interruptedTurnAutoResumeGet = vi.fn(async () => state);
  const interruptedTurnAutoResumeSet = vi.fn(async (enabled: boolean) => {
    state = { ...state, enabled, isCustomized: enabled !== state.defaultEnabled };
    return state;
  });
  const interruptedTurnAutoResumeReset = vi.fn(async () => {
    state = { enabled: true, isCustomized: false, defaultEnabled: true };
    return state;
  });
  const getLinuxCloseBehavior = vi.fn(async () => 'minimize' as const);
  const setLinuxCloseBehavior = vi.fn(async (behavior: 'quit' | 'minimize') => behavior);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowBehavior: {
        getLinuxCloseBehavior,
        setLinuxCloseBehavior,
      },
      maker: {
        interruptedTurnAutoResumeGet,
        interruptedTurnAutoResumeSet,
        interruptedTurnAutoResumeReset,
      },
    },
  });
  return {
    interruptedTurnAutoResumeGet,
    interruptedTurnAutoResumeSet,
    interruptedTurnAutoResumeReset,
  };
}

describe('WindowBehaviorSection interrupted turn auto-resume setting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the authoritative default and persists an explicit opt-out', async () => {
    const api = installElectronApi();
    render(<WindowBehaviorSection />);

    const toggle = await screen.findByRole('switch', {
      name: 'settings.windowBehavior.interruptedAutoResume.aria',
    });
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('checked'));

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(api.interruptedTurnAutoResumeSet).toHaveBeenCalledWith(false);
      expect(toggle.getAttribute('data-state')).toBe('unchecked');
    });
    expect(screen.getByRole('button', { name: 'restore-interrupted-resume-default' })).toBeTruthy();
  });

  it('restores the default through the main-process store', async () => {
    const api = installElectronApi();
    api.interruptedTurnAutoResumeGet.mockResolvedValueOnce({
      enabled: false,
      isCustomized: true,
      defaultEnabled: true,
    });
    render(<WindowBehaviorSection />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'restore-interrupted-resume-default' }),
    );

    await waitFor(() => expect(api.interruptedTurnAutoResumeReset).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole('switch', { name: 'settings.windowBehavior.interruptedAutoResume.aria' }),
    ).toBeTruthy();
  });

  it('waits for the authoritative setting before accepting a toggle', async () => {
    const api = installElectronApi();
    let resolveInitial!: (value: {
      enabled: boolean;
      isCustomized: boolean;
      defaultEnabled: boolean;
    }) => void;
    api.interruptedTurnAutoResumeGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );
    render(<WindowBehaviorSection />);

    const toggle = await screen.findByRole('switch', {
      name: 'settings.windowBehavior.interruptedAutoResume.aria',
    });
    expect(toggle).toHaveProperty('disabled', true);
    fireEvent.click(toggle);
    expect(api.interruptedTurnAutoResumeSet).not.toHaveBeenCalled();

    resolveInitial({ enabled: false, isCustomized: true, defaultEnabled: true });
    await waitFor(() => {
      expect(toggle).toHaveProperty('disabled', false);
      expect(toggle.getAttribute('data-state')).toBe('unchecked');
    });

    fireEvent.click(toggle);
    await waitFor(() => expect(api.interruptedTurnAutoResumeSet).toHaveBeenCalledWith(true));
  });
});
