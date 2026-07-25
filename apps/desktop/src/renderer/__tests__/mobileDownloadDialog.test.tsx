// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,mobile-download'),
}));
vi.mock('qrcode', () => ({ toDataURL }));

import {
  MobileDownloadDialog,
  resolveMobileRemotePresentation,
  resolveMobileDownloadUrl,
} from '@/components/sidebar/MobileDownloadDialog';

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'sidebar', 'MobileDownloadDialog.tsx'),
  'utf8',
);
const globalStyles = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

const openExternal = vi.fn(async () => ({ success: true }));
type DeviceLinkState = Awaited<ReturnType<ElectronAPI['deviceLink']['getState']>>;
const getState = vi.fn<() => Promise<DeviceLinkState>>(async () => ({
  remoteControlEnabled: true,
  keepAwake: false,
  linkStatus: 'online',
  connectionIssue: null,
  controlledBy: [],
  revokedControllers: [],
  disabledControlDeviceIds: [],
}));
const listDevices = vi.fn(async () => ({
  devices: [
    {
      deviceId: 'desktop-device-1',
      name: 'Studio Mac',
      platform: 'darwin',
      appVersion: '1.0.0',
      lastSeenAt: null,
      online: true,
      busy: false,
      remoteControlEnabled: true,
      controlEnabled: true,
      isSelf: true,
    },
    {
      deviceId: 'mobile-device-1',
      name: 'My iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
      lastSeenAt: null,
      online: true,
      busy: false,
      remoteControlEnabled: false,
      controlEnabled: true,
      isSelf: false,
    },
  ],
}));
let presenceChangedHandler: (() => void) | undefined;
const onPresenceChanged = vi.fn((handler: () => void) => {
  presenceChangedHandler = handler;
  return vi.fn();
});
const onStatusChanged = vi.fn(() => vi.fn());
const onConnectionIssue = vi.fn(() => vi.fn());
const detachedTriggerRef = { current: null as HTMLButtonElement | null };

beforeEach(() => {
  toDataURL.mockClear();
  openExternal.mockClear();
  getState.mockClear();
  listDevices.mockClear();
  presenceChangedHandler = undefined;
  onPresenceChanged.mockClear();
  onStatusChanged.mockClear();
  onConnectionIssue.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      clientEndpoints: { websiteUrl: 'https://cindy.cn' },
      openExternal,
      deviceLink: {
        getState,
        listDevices,
        onPresenceChanged,
        onStatusChanged,
        onConnectionIssue,
      },
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(window.performance.now()), 0),
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (frameId: number) => window.clearTimeout(frameId),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('resolveMobileDownloadUrl', () => {
  it('builds the all-versions page from the regional website endpoint', () => {
    expect(resolveMobileDownloadUrl('https://cindy.cn')).toBe(
      'https://cindy.cn/download/#all-versions',
    );
    expect(resolveMobileDownloadUrl('https://cindy.app')).toBe(
      'https://cindy.app/download/#all-versions',
    );
  });

  it.each(['', 'not-a-url', 'http://cindy.cn', 'https://user:pass@cindy.cn'])(
    'rejects an unsafe regional website endpoint: %s',
    (websiteUrl) => {
      expect(resolveMobileDownloadUrl(websiteUrl)).toBeNull();
    },
  );
});

describe('resolveMobileRemotePresentation', () => {
  const selfDevice = {
    deviceId: 'desktop-device-1',
    name: 'Studio Mac',
    platform: 'darwin',
    appVersion: null,
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: true,
  };

  it('distinguishes disabled, connecting, ready, and linked paths', () => {
    expect(
      resolveMobileRemotePresentation({
        enabled: false,
        linkStatus: 'stopped',
        connectionIssue: null,
        devices: [selfDevice],
      }),
    ).toMatchObject({ state: 'disabled', selfDeviceId: 'desktop-device-1' });
    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        linkStatus: 'connecting',
        connectionIssue: null,
        devices: [selfDevice],
      }),
    ).toMatchObject({ state: 'connecting' });
    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        linkStatus: 'online',
        connectionIssue: null,
        devices: [selfDevice],
      }),
    ).toMatchObject({ state: 'ready', linkedMobileName: null });
    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        linkStatus: 'online',
        connectionIssue: null,
        devices: [
          selfDevice,
          {
            ...selfDevice,
            deviceId: 'mobile-1',
            name: 'My iPhone',
            platform: 'ios',
            isSelf: false,
          },
        ],
      }),
    ).toMatchObject({ state: 'linked', linkedMobileName: 'My iPhone' });
  });

  it('surfaces relay connection issues instead of reporting an endless connection attempt', () => {
    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        linkStatus: 'connecting',
        connectionIssue: {
          kind: 'auth-failed',
          at: 1,
        },
        devices: [selfDevice],
      }),
    ).toMatchObject({ state: 'error' });
  });
});

describe('MobileDownloadDialog', () => {
  it('does not generate a QR code before the dialog opens', () => {
    render(
      <MobileDownloadDialog
        open={false}
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );
    expect(toDataURL).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it('generates the regional QR code and exposes an equivalent browser action', async () => {
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    expect(await screen.findByAltText('sidebar.mobileDownload.qrAlt')).toBeTruthy();
    expect(toDataURL).toHaveBeenCalledWith('https://cindy.cn/download/#all-versions', {
      margin: 2,
      width: 234,
    });

    const openButton = screen.getByRole('button', {
      name: 'sidebar.mobileDownload.openPage',
    });
    await waitFor(() => expect(document.activeElement).toBe(openButton));
    fireEvent.click(openButton);
    expect(openExternal).toHaveBeenCalledWith('https://cindy.cn/download/#all-versions');
  });

  it('shows the linked mobile state, desktop device ID, and remote settings action', async () => {
    const onOpenRemoteSettings = vi.fn();
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={onOpenRemoteSettings}
        triggerRef={detachedTriggerRef}
      />,
    );

    expect(await screen.findByText('sidebar.mobileDownload.remoteStatus.linked')).toBeTruthy();
    const deviceId = screen.getByText('desktop-device-1');
    expect(deviceId).toBeTruthy();
    expect(deviceId.className).toContain('select-text');
    expect(deviceId.className).toContain('break-all');
    fireEvent.click(
      screen.getByRole('button', { name: 'sidebar.mobileDownload.openRemoteSettings' }),
    );
    expect(onOpenRemoteSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest remote snapshot when event-driven refreshes resolve out of order', async () => {
    let resolveStaleState!: (state: Awaited<ReturnType<typeof getState>>) => void;
    const staleState = {
      remoteControlEnabled: true,
      keepAwake: false,
      linkStatus: 'connecting' as const,
      connectionIssue: null,
      controlledBy: [],
      revokedControllers: [],
      disabledControlDeviceIds: [],
    };
    getState
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleState = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...staleState,
        linkStatus: 'online',
      });

    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    await waitFor(() => expect(presenceChangedHandler).toBeTypeOf('function'));
    await act(async () => {
      presenceChangedHandler?.();
    });
    expect(await screen.findByText('sidebar.mobileDownload.remoteStatus.linked')).toBeTruthy();

    await act(async () => {
      resolveStaleState(staleState);
    });
    await waitFor(() =>
      expect(screen.getByText('sidebar.mobileDownload.remoteStatus.linked')).toBeTruthy(),
    );
    expect(screen.queryByText('sidebar.mobileDownload.remoteStatus.connecting')).toBeNull();
  });

  it('uses the failed status color when the remote state cannot be read', async () => {
    getState.mockRejectedValueOnce(new Error('state unavailable'));
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    const status = await screen.findByText('sidebar.mobileDownload.remoteStatus.error');
    expect(
      status.parentElement?.querySelector('[aria-hidden="true"]')?.getAttribute('style'),
    ).toContain('--remote-status-failed');
  });

  it('uses the official Cindy artwork and the shared dialog tokens', () => {
    expect(source).toContain('@/../../resources/icon.png?url');
    expect(source).toContain("t('sidebar.mobileDownload.title')");
    expect(source).toContain('<Smartphone');
    expect(source).toContain('<Monitor');
    expect(source).toContain("t('sidebar.mobileDownload.subtitle')");
    expect(source).toContain('bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]');
    expect(source).not.toMatch(/(?:linear|conic|radial)-gradient/);
    expect(source).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });

  it('focuses a usable fallback when the download endpoint is invalid', async () => {
    window.electronAPI.clientEndpoints.websiteUrl = 'not-a-url';
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'sidebar.mobileDownload.openRemoteSettings' }),
      ),
    );
  });

  it('returns focus to the sidebar trigger when the dialog closes', async () => {
    function FocusReturnHarness() {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button">
            download trigger
          </button>
          <MobileDownloadDialog
            open={open}
            onOpenChange={setOpen}
            remoteAvailable
            onOpenRemoteSettings={vi.fn()}
            triggerRef={triggerRef}
          />
        </>
      );
    }

    render(<FocusReturnHarness />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'sidebar.mobileDownload.close',
      }),
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'download trigger' })),
    );
  });

  it('keeps pointer tilt outside React state and animates only the edge transform', () => {
    expect(source).toContain('onPointerMove={handleQrPointerMove}');
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('perspective(760px)');
    expect(source).toContain('scale3d(1.018, 1.018, 1.018)');
    expect(source).not.toContain('const [qrPointer');
    expect(source).not.toContain('setQrAutoAngle');
    expect(globalStyles).toContain('@keyframes mobile-download-edge-turn');
    expect(globalStyles).toContain(
      'animation: mobile-download-edge-turn var(--mobile-download-edge-cycle) linear infinite',
    );
    expect(globalStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(globalStyles).toMatch(/\.mobile-download-qr-edge\s*\{\s*animation: none;\s*transform:/);
  });

  it('queues one mouse-tilt frame and cancels it when the dialog unmounts', () => {
    const requestFrame = vi.fn(() => 37);
    const cancelFrame = vi.fn();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: requestFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: cancelFrame,
    });

    const view = render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable={false}
        onOpenRemoteSettings={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );
    const card = screen.getByTestId('mobile-download-qr-card');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 236,
      bottom: 236,
      left: 0,
      width: 236,
      height: 236,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(card, {
      pointerType: 'mouse',
      clientX: 180,
      clientY: 80,
    });

    expect(card.dataset.pointerActive).toBe('true');
    expect(requestFrame).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(37);
  });

  it('does not queue pointer motion when reduced motion is requested', () => {
    const requestFrame = vi.fn(() => 37);
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: requestFrame,
    });
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable={false}
        onOpenRemoteSettings={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );
    fireEvent.pointerMove(screen.getByTestId('mobile-download-qr-card'), {
      pointerType: 'mouse',
      clientX: 180,
      clientY: 80,
    });

    expect(requestFrame).not.toHaveBeenCalled();
  });
});
