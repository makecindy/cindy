// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteDesktopSetting } from '../RemoteDesktopSetting';
import { WindowsDesktopSetup } from '../../../../main/remote-desktop/windowsSetup';
import type { WindowsDesktopSetupPhase } from '../../../../shared/remoteDesktop';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../RemoteDesktopPermissions', () => ({ RemoteDesktopPermissions: () => null }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('probes service status only while settings are mounted and after setup', async () => {
  vi.useFakeTimers();
  let support = 'missing';
  const state = vi.fn(async (probe?: boolean) => ({
    enabled: true,
    active: null,
    ...(probe ? { windowsSupport: support } : {}),
  }));
  const windowsSupport = vi.fn(async () => {
    support = 'ready';
  });
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  const view = render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(state).toHaveBeenCalledExactlyOnceWith(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(state.mock.calls.slice(1)).toEqual([[true], [true], [true]]);
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(true);
  expect(state).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeTruthy();
  view.unmount();
  const calls = state.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000);
  expect(state).toHaveBeenCalledTimes(calls);
});

it('recovers a slow initial probe discarded by an intervening enable action', async () => {
  vi.useFakeTimers();
  let complete!: (value: { enabled: boolean; active: null; windowsSupport: string }) => void;
  const state = vi
    .fn(async () => ({ enabled: true, active: null, windowsSupport: 'missing' }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  const enable = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { remoteDesktop: { state, enable } } });
  render(<RemoteDesktopSetting />);
  fireEvent.click(screen.getByRole('switch'));
  await act(async () => {});
  await act(async () => {
    complete({ enabled: false, active: null, windowsSupport: 'missing' });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(state).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
});

it('keeps ordinary remote desktop enabled when administrator authorization is cancelled', async () => {
  const state = vi.fn(async () => ({ enabled: true, active: null, windowsSupport: 'missing' }));
  const windowsSupport = vi.fn().mockRejectedValue(new Error('UAC cancelled'));
  const enable = vi.fn();
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport, enable } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(true);
  expect(enable).not.toHaveBeenCalled();
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('alert').textContent).toBe('remoteDesktop.windowsError');
  expect(
    screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' }).hasAttribute('disabled'),
  ).toBe(false);
});

it('uses the installed authorization after remount without requesting administrator approval again', async () => {
  let support = 'ready';
  const state = vi.fn(async () => ({ enabled: true, active: null, windowsSupport: support }));
  const windowsSupport = vi.fn(async (enabled: boolean) => {
    support = enabled ? 'ready' : 'missing';
  });
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  const first = render(<RemoteDesktopSetting />);
  await act(async () => {});
  first.unmount();
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(windowsSupport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(false);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
});

it('lets Dev prepare and authorize the service while keeping the trust scope visible', async () => {
  let support = 'missing';
  let finish!: () => void;
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: support,
    windowsDevelopment: true,
  }));
  const windowsSupport = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          support = 'ready';
          resolve();
        };
      }),
  );
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByText('remoteDesktop.windowsDevelopmentHint')).toBeTruthy();
  expect(screen.getByText('remoteDesktop.windowsDevelopmentMissing')).toBeTruthy();
  const enable = screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' });
  expect(enable.hasAttribute('disabled')).toBe(false);
  fireEvent.click(enable);
  expect(
    screen.getByRole('button', { name: 'remoteDesktop.windowsSettingUp' }).hasAttribute('disabled'),
  ).toBe(true);
  await act(async () => {
    finish();
  });
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(true);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeTruthy();
});

it('explains a Dev build failure separately from cancelled administrator approval', async () => {
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: 'missing',
    windowsDevelopment: true,
  }));
  const windowsSupport = vi
    .fn()
    .mockRejectedValue(
      new Error('[PRECONDITION_FAILED] Windows desktop native preparation failed'),
    );
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' }));
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toBe('remoteDesktop.windowsPreparationError');
});

it('reopens the same background preparation, then allows retry after failure without duplicating setup', async () => {
  vi.useFakeTimers();
  let fail!: (error: Error) => void;
  let progress!: (phase: WindowsDesktopSetupPhase) => void;
  const configure = vi.fn((_enabled, update) => {
    progress = update;
    return new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
  });
  const job = new WindowsDesktopSetup({ configure, stopDesktop: vi.fn() });
  const windowsSupport = vi.fn((enabled: boolean) => job.run(enabled));
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: 'missing',
    windowsDevelopment: true,
    windowsSetup: job.read(),
  }));
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  const first = render(<RemoteDesktopSetting />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' }));
  await act(async () => {
    await Promise.resolve();
    progress('compilingHost');
  });
  first.unmount();
  const reopened = render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByText('remoteDesktop.windowsCompilingHost')).toBeTruthy();
  const pending = screen.getByRole('button', { name: 'remoteDesktop.windowsSettingUp' });
  expect(pending.hasAttribute('disabled')).toBe(true);
  fireEvent.click(pending);
  expect(windowsSupport).toHaveBeenCalledOnce();
  reopened.unmount();
  await act(async () => {
    fail(new Error('DESKTOP_NATIVE_BUILD_FAILED'));
  });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toBe('remoteDesktop.windowsPreparationError');
  const retry = screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' });
  expect(retry.hasAttribute('disabled')).toBe(false);
  fireEvent.click(retry);
  await act(async () => {
    await Promise.resolve();
    progress('authorizing');
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByText('remoteDesktop.windowsAuthorizing')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(configure).toHaveBeenCalledTimes(2);
  await act(async () => {
    fail(new Error('cancelled'));
  });
});

it('does not permanently disable setup after a transient status probe failure', async () => {
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: 'unavailable',
    windowsDevelopment: true,
  }));
  const windowsSupport = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeTruthy();
  const retry = screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' });
  expect(retry.hasAttribute('disabled')).toBe(false);
  fireEvent.click(retry);
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(true);
});

it('keeps an independent remove action after post-install verification fails', async () => {
  let support = 'unavailable';
  let setup: {
    revision: number;
    phase: null;
    error: 'setup' | null;
    failedEnabled: boolean | null;
    startedAt: number | null;
  } = {
    revision: 1,
    phase: null,
    error: 'setup',
    failedEnabled: true,
    startedAt: 1,
  };
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: support,
    windowsSetup: setup,
  }));
  const windowsSupport = vi.fn(async (enabled: boolean) => {
    support = enabled ? 'ready' : 'missing';
    setup = {
      revision: setup.revision + 1,
      phase: null,
      error: null,
      failedEnabled: null,
      startedAt: null,
    };
  });
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(false);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeNull();
});

it('keeps Remove after Main restarts when native status is leftover unavailable', async () => {
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: 'unavailable',
  }));
  const windowsSupport = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' })).toBeTruthy();
});

it('keeps an independent remove action after a failed service update leaves the grant missing', async () => {
  let support: 'missing' | 'ready' = 'missing';
  let setup: {
    revision: number;
    phase: null;
    error: 'setup' | null;
    failedEnabled: boolean | null;
    startedAt: number | null;
  } = {
    revision: 3,
    phase: null,
    error: 'setup',
    failedEnabled: true,
    startedAt: 3,
  };
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: support,
    windowsSetup: setup,
  }));
  const windowsSupport = vi.fn(async (enabled: boolean) => {
    support = enabled ? 'ready' : 'missing';
    setup = {
      revision: setup.revision + 1,
      phase: null,
      error: null,
      failedEnabled: null,
      startedAt: null,
    };
  });
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(false);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeNull();
});

it('retries a failed uninstall instead of reinstalling after the service is already gone', async () => {
  let support: 'missing' | 'ready' = 'missing';
  let setup: {
    revision: number;
    phase: null;
    error: 'setup' | null;
    failedEnabled: boolean | null;
    startedAt: number | null;
  } = {
    revision: 2,
    phase: null,
    error: 'setup',
    failedEnabled: false,
    startedAt: 2,
  };
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: support,
    windowsSetup: setup,
  }));
  const windowsSupport = vi.fn(async (enabled: boolean) => {
    support = enabled ? 'ready' : 'missing';
    setup = {
      revision: setup.revision + 1,
      phase: null,
      error: null,
      failedEnabled: null,
      startedAt: null,
    };
  });
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsRetry' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(false);
});

it('keeps an independent remove action while the authorized service needs an update', async () => {
  let support = 'updateRequired';
  const state = vi.fn(async () => ({
    enabled: true,
    active: null,
    windowsSupport: support,
    windowsDevelopment: true,
  }));
  const windowsSupport = vi.fn(async (enabled: boolean) => {
    support = enabled ? 'ready' : 'missing';
  });
  Object.assign(window, { electronAPI: { remoteDesktop: { state, windowsSupport } } });
  render(<RemoteDesktopSetting />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsUpdate' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.windowsDisable' }));
  await act(async () => {});
  expect(windowsSupport).toHaveBeenCalledExactlyOnceWith(false);
  expect(screen.getByRole('button', { name: 'remoteDesktop.windowsEnable' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'remoteDesktop.windowsDisable' })).toBeNull();
});
