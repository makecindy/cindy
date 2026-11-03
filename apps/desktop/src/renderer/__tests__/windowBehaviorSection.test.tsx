// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowBehaviorSection } from '@/components/settings/WindowBehaviorSection';
import type { LoginItemState } from '../../shared/loginItem';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useKeepAwakeSetting', () => ({
  useKeepAwakeSetting: () => ({ keepAwake: false, setKeepAwake: vi.fn() }),
}));

vi.mock('@/hooks/useSwallowActivationClickSettings', () => ({
  useSwallowActivationClickSettings: () => ({ enabled: false, setEnabled: vi.fn() }),
}));

function installWindowBehaviorApi(platform: 'darwin' | 'linux' | 'win32') {
  const getLoginItem = vi.fn(async (): Promise<LoginItemState> => ({
    available: true,
    enabled: false,
    requiresApproval: false,
  }));
  const setLoginItem = vi.fn(async (enabled: boolean): Promise<LoginItemState> => ({
    available: true,
    enabled,
    requiresApproval: false,
  }));
  const getWindowsCloseBehavior = vi.fn(async () => 'tray' as const);
  const setWindowsCloseBehavior = vi.fn(async (behavior: 'quit' | 'tray') => behavior);
  const getLinuxCloseBehavior = vi.fn(async () => 'minimize' as const);
  const setLinuxCloseBehavior = vi.fn(async (behavior: 'quit' | 'minimize') => behavior);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform,
      windowBehavior: {
        getLoginItem,
        setLoginItem,
        getWindowsCloseBehavior,
        setWindowsCloseBehavior,
        getLinuxCloseBehavior,
        setLinuxCloseBehavior,
      },
    } as unknown as Window['electronAPI'],
  });
  return {
    getLoginItem,
    setLoginItem,
    getWindowsCloseBehavior,
    setWindowsCloseBehavior,
    getLinuxCloseBehavior,
    setLinuxCloseBehavior,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as Partial<Window>).electronAPI;
});

describe('WindowBehaviorSection login startup', () => {
  const label = 'settings.windowBehavior.loginItem.label';

  it.each(['win32', 'darwin'] as const)(
    'starts off on %s and saves explicit on/off choices',
    async (platform) => {
      const api = installWindowBehaviorApi(platform);
      render(<WindowBehaviorSection />);
      const toggle = screen.getByRole('switch', { name: label });
      await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(api.setLoginItem).not.toHaveBeenCalled();
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
      expect(api.setLoginItem).toHaveBeenLastCalledWith(true);
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
      expect(api.setLoginItem).toHaveBeenLastCalledWith(false);
    },
  );

  it('does not expose or query login startup on Linux', async () => {
    const api = installWindowBehaviorApi('linux');
    render(<WindowBehaviorSection />);
    expect(screen.queryByRole('switch', { name: label })).toBeNull();
    expect(api.getLoginItem).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it('keeps the development-build control disabled without an installation hint', async () => {
    const api = installWindowBehaviorApi('win32');
    api.getLoginItem.mockResolvedValue({
      available: false,
      unavailableReason: 'development',
      enabled: false,
      requiresApproval: false,
    });
    render(<WindowBehaviorSection />);
    await act(async () => {});
    expect(screen.queryByText('settings.windowBehavior.loginItem.development')).toBeNull();
    expect(screen.getByRole('switch', { name: label }).hasAttribute('disabled')).toBe(true);
  });

  it('shows pending macOS approval and lets the user cancel registration', async () => {
    const api = installWindowBehaviorApi('darwin');
    api.getLoginItem.mockResolvedValue({ available: true, enabled: false, requiresApproval: true });
    render(<WindowBehaviorSection />);
    await screen.findByText('settings.windowBehavior.loginItem.requiresApproval');
    const toggle = screen.getByRole('switch', { name: label });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(api.setLoginItem).toHaveBeenCalledWith(false);
  });

  it('reloads system changes when returning to the window', async () => {
    const api = installWindowBehaviorApi('win32');
    render(<WindowBehaviorSection />);
    const toggle = screen.getByRole('switch', { name: label });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    api.getLoginItem.mockResolvedValue({ available: true, enabled: true, requiresApproval: false });
    fireEvent.focus(window);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('shows read failure instead of presenting an editable default', async () => {
    const api = installWindowBehaviorApi('win32');
    api.getLoginItem.mockRejectedValue(new Error('unavailable'));
    render(<WindowBehaviorSection />);
    await screen.findByText('settings.windowBehavior.loginItem.loadFailed');
    expect(screen.getByRole('switch', { name: label }).hasAttribute('disabled')).toBe(true);
  });

  it('re-reads actual state after a rejected save and lets the user retry', async () => {
    const api = installWindowBehaviorApi('win32');
    api.setLoginItem.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] refused'));
    render(<WindowBehaviorSection />);
    const toggle = screen.getByRole('switch', { name: label });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    await screen.findByText('settings.windowBehavior.loginItem.notApplied');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('disabled')).toBe(false);
    expect(api.getLoginItem).toHaveBeenCalledTimes(2);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('locks the switch and ignores focus refreshes while saving', async () => {
    const api = installWindowBehaviorApi('win32');
    let finish!: (state: LoginItemState) => void;
    api.setLoginItem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<WindowBehaviorSection />);
    const toggle = screen.getByRole('switch', { name: label });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    expect(toggle.hasAttribute('disabled')).toBe(true);
    fireEvent.focus(window);
    fireEvent.click(toggle);
    expect(api.getLoginItem).toHaveBeenCalledTimes(1);
    expect(api.setLoginItem).toHaveBeenCalledTimes(1);
    await act(async () => finish({ available: true, enabled: true, requiresApproval: false }));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('WindowBehaviorSection close behavior', () => {
  it('shows minimize and quit on Linux and persists Linux choices', async () => {
    const api = installWindowBehaviorApi('linux');

    render(<WindowBehaviorSection />);

    expect(await screen.findByText('settings.windowBehavior.closeBehavior.label')).toBeTruthy();
    expect(api.getLinuxCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.getWindowsCloseBehavior).not.toHaveBeenCalled();
    expect(
      screen.getByRole('radio', { name: 'settings.windowBehavior.closeBehavior.minimize' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('radio', { name: 'settings.windowBehavior.closeBehavior.tray' }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('radio', { name: 'settings.windowBehavior.closeBehavior.quit' }),
    );

    await waitFor(() => expect(api.setLinuxCloseBehavior).toHaveBeenCalledWith('quit'));
    expect(api.setWindowsCloseBehavior).not.toHaveBeenCalled();
  });

  it('keeps tray and quit on Windows', async () => {
    const api = installWindowBehaviorApi('win32');

    render(<WindowBehaviorSection />);

    expect(await screen.findByText('settings.windowBehavior.closeBehavior.label')).toBeTruthy();
    expect(api.getWindowsCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.getLinuxCloseBehavior).not.toHaveBeenCalled();
    expect(
      screen.getByRole('radio', { name: 'settings.windowBehavior.closeBehavior.tray' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('radio', { name: 'settings.windowBehavior.closeBehavior.minimize' }),
    ).toBeNull();
  });

  it('keeps close behavior settings hidden on macOS', async () => {
    installWindowBehaviorApi('darwin');

    render(<WindowBehaviorSection />);

    expect(screen.queryByText('settings.windowBehavior.closeBehavior.label')).toBeNull();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'settings.windowBehavior.loginItem.label' }).hasAttribute('disabled')).toBe(false));
  });
});
