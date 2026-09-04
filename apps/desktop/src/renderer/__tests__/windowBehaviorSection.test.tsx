// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowBehaviorSection } from '@/components/settings/WindowBehaviorSection';

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
  const getWindowsCloseBehavior = vi.fn(async () => 'tray' as const);
  const setWindowsCloseBehavior = vi.fn(async (behavior: 'quit' | 'tray') => behavior);
  const getLinuxCloseBehavior = vi.fn(async () => 'minimize' as const);
  const setLinuxCloseBehavior = vi.fn(async (behavior: 'quit' | 'minimize') => behavior);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform,
      windowBehavior: {
        getWindowsCloseBehavior,
        setWindowsCloseBehavior,
        getLinuxCloseBehavior,
        setLinuxCloseBehavior,
      },
    } as unknown as Window['electronAPI'],
  });
  return {
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

    fireEvent.click(screen.getByRole('radio', { name: 'settings.windowBehavior.closeBehavior.quit' }));

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

  it('keeps close behavior settings hidden on macOS', () => {
    installWindowBehaviorApi('darwin');

    render(<WindowBehaviorSection />);

    expect(screen.queryByText('settings.windowBehavior.closeBehavior.label')).toBeNull();
  });
});
