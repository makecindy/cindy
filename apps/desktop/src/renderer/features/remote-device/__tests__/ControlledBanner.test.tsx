// @vitest-environment jsdom

import { StrictMode, type ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ControlledBanner, __resetControlledBannerForTests } from '../ControlledBanner';

const navigate = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn(async () => false));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'remoteDevice.controlledBy') return `Controlled by ${String(values?.name)}`;
      if (key === 'remoteDevice.expandControlledNotice') {
        return `Expand: ${String(values?.label)}`;
      }
      return key;
    },
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactElement }) => children,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

beforeEach(() => {
  __resetControlledBannerForTests();
  const api = {
    getState: vi.fn(async () => ({
      remoteControlEnabled: true,
      keepAwake: false,
      linkStatus: 'online' as const,
      connectionIssue: null,
      standby: false,
      controlledBy: [{ deviceId: 'iphone', name: 'iPhone' }],
      revokedControllers: [],
      disabledControlDeviceIds: [],
      unresponsiveDeviceIds: [],
    })),
    onControlledState: vi.fn(() => vi.fn()),
    revoke: vi.fn(async () => undefined),
  };
  (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = {
    deviceLink: api,
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});

describe('ControlledBanner composer collapse state', () => {
  it('keeps collapse state isolated by session and restores the full chip from the breathing light', async () => {
    const view = render(
      <ControlledBanner placement="composer" sessionId="session-a" maxWidth={420} />,
    );

    expect(await screen.findByText('Controlled by iPhone')).toBeTruthy();
    const chip = document.querySelector('[data-controlled-banner-chip="true"]');
    const collapseButton = screen.getByRole('button', {
      name: 'remoteDevice.collapseControlledNotice',
    });
    expect(chip).toBeTruthy();
    expect(chip?.contains(collapseButton)).toBe(true);
    fireEvent.click(collapseButton);

    expect(screen.queryByText('Controlled by iPhone')).toBeNull();
    expect(document.querySelector('[data-controlled-banner-chip="true"]')).toBeNull();
    const collapsedButton = screen.getByRole('button', { name: 'Expand: Controlled by iPhone' });
    expect(collapsedButton).toBeTruthy();
    expect(collapsedButton.querySelector('span')?.classList.contains('translate-y-[2px]')).toBe(
      true,
    );

    view.rerender(<ControlledBanner placement="composer" sessionId="session-b" maxWidth={420} />);
    expect(screen.getByText('Controlled by iPhone')).toBeTruthy();

    view.rerender(<ControlledBanner placement="composer" sessionId="session-a" maxWidth={420} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand: Controlled by iPhone' }));

    expect(screen.getByText('Controlled by iPhone')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'remoteDevice.collapseControlledNotice' }),
    ).toBeTruthy();
  });
});

describe('ControlledBanner floating fallback', () => {
  it('does not restore an old two-device snapshot after a disconnect push', async () => {
    const previous = await window.electronAPI.deviceLink.getState();
    let resolve!: (value: typeof previous) => void;
    vi.mocked(window.electronAPI.deviceLink.getState).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<ControlledBanner />);
    const push = vi.mocked(window.electronAPI.deviceLink.onControlledState).mock.calls[0][0];
    act(() => push({ controllers: [{ deviceId: 'mac', name: 'MacBook' }] }));
    await act(async () =>
      resolve({
        ...previous,
        controlledBy: [
          { deviceId: 'mac', name: 'MacBook' },
          { deviceId: 'phone', name: 'Phone' },
        ],
      }),
    );
    expect(screen.getByText('Controlled by MacBook')).toBeTruthy();
    act(() => push({ controllers: [] }));
    expect(document.querySelector('[data-controlled-banner-chip]')).toBeNull();
  });
  it('yields to a mounted composer, including its collapsed indicator, and returns after unmount', async () => {
    const fallback = render(<ControlledBanner />);
    await screen.findByText('Controlled by iPhone');

    const composer = render(<ControlledBanner placement="composer" sessionId="bot-session" />);
    expect(screen.getAllByText('Controlled by iPhone')).toHaveLength(1);
    expect(fallback.container.childElementCount).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'remoteDevice.collapseControlledNotice' }));
    expect(screen.queryByText('Controlled by iPhone')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand: Controlled by iPhone' })).toBeTruthy();
    expect(fallback.container.childElementCount).toBe(0);

    composer.unmount();
    expect(screen.getAllByText('Controlled by iPhone')).toHaveLength(1);
    expect(fallback.container.childElementCount).toBe(1);
  });

  it('waits for the last inline owner and survives StrictMode effect replay', async () => {
    const fallback = render(<ControlledBanner />);
    await screen.findByText('Controlled by iPhone');
    const first = render(
      <StrictMode>
        <ControlledBanner placement="composer" sessionId="first" />
      </StrictMode>,
    );
    const second = render(<ControlledBanner placement="inline" />);
    expect(fallback.container.childElementCount).toBe(0);

    first.unmount();
    expect(fallback.container.childElementCount).toBe(0);
    second.unmount();
    expect(fallback.container.childElementCount).toBe(1);
  });

  it('handles placement changes without retaining a stale owner', async () => {
    const view = render(<ControlledBanner placement="composer" sessionId="session" />);
    await screen.findByText('Controlled by iPhone');
    view.rerender(<ControlledBanner />);
    expect(screen.getAllByText('Controlled by iPhone')).toHaveLength(1);
    view.rerender(<ControlledBanner placement="inline" />);
    expect(screen.getAllByText('Controlled by iPhone')).toHaveLength(1);
    view.unmount();
    render(<ControlledBanner />);
    expect(screen.getAllByText('Controlled by iPhone')).toHaveLength(1);
  });

  it('shows neither surface after disconnect and restores only the composer on reconnect', async () => {
    const fallback = render(<ControlledBanner />);
    render(<ControlledBanner placement="composer" sessionId="session" />);
    await screen.findByText('Controlled by iPhone');
    const onControlledState = vi.mocked(window.electronAPI.deviceLink.onControlledState);
    expect(onControlledState).toHaveBeenCalledTimes(1);
    const push = onControlledState.mock.calls[0][0];
    act(() => push({ controllers: [] }));
    expect(document.querySelector('[data-controlled-banner-chip]')).toBeNull();
    act(() => push({ controllers: [{ deviceId: 'iphone', name: 'iPhone' }] }));
    expect(screen.getAllByText('Controlled by iPhone')).toHaveLength(1);
    expect(fallback.container.childElementCount).toBe(0);
  });
});
