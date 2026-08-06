// @vitest-environment jsdom

import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
