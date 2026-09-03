// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowControls } from '@/components/title-bar/WindowControls';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function installWindowsApi(closeBehavior: 'quit' | 'tray' | null) {
  let closeBehaviorRequested: (() => void) | null = null;
  const getWindowsCloseBehavior = vi.fn(async () => closeBehavior);
  const setWindowsCloseBehavior = vi.fn(async (behavior: 'quit' | 'tray') => behavior);
  const onWindowsCloseBehaviorRequested = vi.fn((callback: () => void) => {
    closeBehaviorRequested = callback;
    return vi.fn();
  });
  const notifyWindowsCloseBehaviorPromptShown = vi.fn();
  const anySessionInTurn = vi.fn(async () => false);
  const windowClose = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      windowBehavior: {
        getWindowsCloseBehavior,
        setWindowsCloseBehavior,
        onWindowsCloseBehaviorRequested,
        notifyWindowsCloseBehaviorPromptShown,
      },
      anySessionInTurn,
      windowClose,
      windowMinimize: vi.fn(),
      windowMaximize: vi.fn(),
    } as unknown as Window['electronAPI'],
  });
  return {
    getWindowsCloseBehavior,
    setWindowsCloseBehavior,
    onWindowsCloseBehaviorRequested,
    notifyWindowsCloseBehaviorPromptShown,
    anySessionInTurn,
    windowClose,
    requestCloseBehavior: () => closeBehaviorRequested?.(),
  };
}

function installLinuxApi(closeBehavior: 'quit' | 'minimize' | null) {
  let closeBehaviorRequested: (() => void) | null = null;
  const getLinuxCloseBehavior = vi.fn(async () => closeBehavior);
  const setLinuxCloseBehavior = vi.fn(async (behavior: 'quit' | 'minimize') => behavior);
  const onLinuxCloseBehaviorRequested = vi.fn((callback: () => void) => {
    closeBehaviorRequested = callback;
    return vi.fn();
  });
  const notifyLinuxCloseBehaviorPromptShown = vi.fn();
  const anySessionInTurn = vi.fn(async () => false);
  const windowClose = vi.fn();
  const windowMinimize = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowBehavior: {
        getLinuxCloseBehavior,
        setLinuxCloseBehavior,
        onLinuxCloseBehaviorRequested,
        notifyLinuxCloseBehaviorPromptShown,
      },
      anySessionInTurn,
      windowClose,
      windowMinimize,
      windowMaximize: vi.fn(),
    } as unknown as Window['electronAPI'],
  });
  return {
    getLinuxCloseBehavior,
    setLinuxCloseBehavior,
    onLinuxCloseBehaviorRequested,
    notifyLinuxCloseBehaviorPromptShown,
    anySessionInTurn,
    windowClose,
    windowMinimize,
    requestCloseBehavior: () => closeBehaviorRequested?.(),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  delete (window as Partial<Window>).electronAPI;
});

describe('Windows close behavior', () => {
  it('uses the default minimize action when no override is provided', () => {
    installWindowsApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.minimize' }));

    expect(window.electronAPI.windowMinimize).toHaveBeenCalledTimes(1);
  });

  it('uses a window-specific minimize action when provided', () => {
    installWindowsApi(null);
    const onMinimize = vi.fn();
    render(<WindowControls onMinimize={onMinimize} />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.minimize' }));

    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.windowMinimize).not.toHaveBeenCalled();
  });

  it('hides minimize when the current surface opts out', () => {
    installWindowsApi(null);
    render(<WindowControls showMinimize={false} />);

    expect(screen.queryByRole('button', { name: 'titleBar.minimize' })).toBeNull();
  });

  it('does not subscribe to main-window close requests from a secondary window', () => {
    window.history.replaceState({}, '', '/?secondaryWindow=1');
    const api = installWindowsApi(null);

    render(<WindowControls />);

    expect(api.onWindowsCloseBehaviorRequested).not.toHaveBeenCalled();
  });

  it('closes to the tray without showing the quit protection flow', async () => {
    const api = installWindowsApi('tray');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.getWindowsCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
  });

  it('keeps the existing quit protection flow when quit is selected', async () => {
    const api = installWindowsApi('quit');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.getWindowsCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).toHaveBeenCalledTimes(1);
  });

  it('uses the Cindy dialog for the first close and persists the safe tray choice', async () => {
    const api = installWindowsApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.windowBehavior.closeBehavior.tray' }),
    );

    await waitFor(() => expect(api.setWindowsCloseBehavior).toHaveBeenCalledWith('tray'));
    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
  });

  it('opens the same dialog for a native Windows close request', async () => {
    const api = installWindowsApi(null);
    render(<WindowControls />);

    act(() => api.requestCloseBehavior());

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    await waitFor(() => expect(api.notifyWindowsCloseBehaviorPromptShown).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.windowBehavior.closeBehavior.quit' }),
    );

    await waitFor(() => expect(api.setWindowsCloseBehavior).toHaveBeenCalledWith('quit'));
    await waitFor(() => expect(api.anySessionInTurn).toHaveBeenCalledTimes(1));
    expect(api.windowClose).toHaveBeenCalledTimes(1);
  });

  it('acknowledges another native close request while the custom dialog is already visible', async () => {
    const api = installWindowsApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));
    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    await waitFor(() => expect(api.notifyWindowsCloseBehaviorPromptShown).toHaveBeenCalledOnce());

    act(() => api.requestCloseBehavior());

    expect(api.notifyWindowsCloseBehaviorPromptShown).toHaveBeenCalledTimes(2);
  });
});

describe('Linux close behavior', () => {
  it('minimizes immediately when the saved behavior is minimize', async () => {
    const api = installLinuxApi('minimize');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowMinimize).toHaveBeenCalledTimes(1));
    expect(api.getLinuxCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
    expect(api.windowClose).not.toHaveBeenCalled();
  });

  it('uses the Cindy dialog for the first close and persists the minimize choice', async () => {
    const api = installLinuxApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    expect(screen.getByText('settings.windowBehavior.closePrompt.linuxDetail')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.windowBehavior.closeBehavior.minimize' }),
    );

    await waitFor(() => expect(api.setLinuxCloseBehavior).toHaveBeenCalledWith('minimize'));
    await waitFor(() => expect(api.windowMinimize).toHaveBeenCalledTimes(1));
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
  });

  it('keeps the existing quit protection flow when quit is selected', async () => {
    const api = installLinuxApi('quit');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.anySessionInTurn).toHaveBeenCalledTimes(1);
    expect(api.windowMinimize).not.toHaveBeenCalled();
  });

  it('opens the same dialog for a native Linux close request', async () => {
    const api = installLinuxApi(null);
    render(<WindowControls />);

    act(() => api.requestCloseBehavior());

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    await waitFor(() => expect(api.notifyLinuxCloseBehaviorPromptShown).toHaveBeenCalledOnce());
  });
});
