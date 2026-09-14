// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CHANNEL } from '@cindy/device-link';
import i18n from '@/i18n';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { toast } from '@/lib/toast';
import { DeviceSectionHeader } from '../DeviceSectionHeader';

const fixture = vi.hoisted(() => ({ devices: [] as DeviceLinkDeviceView[] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => fixture.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

const capabilities = {
  version: 1,
  enabled: true,
  canControl: true,
  platform: 'win32',
  displays: [{ id: 'screen', width: 1920, height: 1080 }],
};
const invoke = vi.fn();
const open = vi.fn();
const toggle = vi.fn();
const device = (): DeviceLinkDeviceView => ({
  deviceId: 'remote',
  name: 'Remote computer',
  platform: 'win32',
  appVersion: '1',
  lastSeenAt: null,
  online: true,
  busy: true,
  remoteControlEnabled: true,
  controlEnabled: true,
  isSelf: false,
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  revokedDevicesStore.clearAll();
  fixture.devices = [device()];
  invoke.mockReset().mockResolvedValue(capabilities);
  open.mockReset().mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { deviceLink: { invoke }, openRemoteDesktop: open } });
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  revokedDevicesStore.clearAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function header(deviceId: string | null = 'remote') {
  return (
    <DeviceSectionHeader deviceId={deviceId} name="Remote computer">
      <button type="button" onClick={toggle}>
        Machine
      </button>
    </DeviceSectionHeader>
  );
}
function row() {
  return screen.getByRole('button', { name: 'Machine' }).parentElement!;
}
async function hover() {
  fireEvent.mouseEnter(row());
  await act(async () => vi.advanceTimersByTimeAsync(151));
}
function unavailable() {
  const button = screen.getByRole('button', { name: /^Remote desktop unavailable:/ });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.querySelector('.lucide-monitor-off')).not.toBeNull();
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
  expect(toggle).not.toHaveBeenCalled();
  return button;
}

it('does not add a remote shortcut or probe to the local machine', async () => {
  render(header(null));
  await hover();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});

it('checks on hover without starting a desktop, then opens the right machine without toggling it', async () => {
  render(header());
  expect(invoke).not.toHaveBeenCalled();
  const action = screen.getByRole('button', { name: 'Checking remote desktop…' });
  expect(action.parentElement!.className).toContain('group-hover/device-header:opacity-100');
  expect(action.parentElement!.className).toContain('has-[:focus-visible]:opacity-100');
  await hover();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('remote', REMOTE_DESKTOP_CHANNEL, [
    { op: 'capabilities' },
  ]);
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Machine' }).querySelector('button')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open remote desktop' }));
  expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'remote', name: 'Remote computer' });
  expect(toggle).not.toHaveBeenCalled();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Machine' }));
  expect(toggle).toHaveBeenCalledOnce();
});

it.each([
  [{ online: false }, 'This computer is offline.'],
  [
    { remoteControlEnabled: false },
    i18n.getResource('en', 'common', 'remoteDesktop.remoteDisabled'),
  ],
  [{ controlEnabled: false }, 'Allow control of this computer in Remote control settings.'],
  [{ platform: 'ios' }, 'This device does not support remote desktop.'],
  [{ isSelf: true }, 'This device does not support remote desktop.'],
] satisfies [Partial<DeviceLinkDeviceView>, string][])(
  'does not probe a known unavailable device: %j',
  async (patch, reason) => {
    fixture.devices = [{ ...device(), ...patch }];
    render(header());
    await hover();
    expect(unavailable().getAttribute('aria-label')).toContain(reason);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it('does not probe a revoked or missing device', async () => {
  revokedDevicesStore.markRevoked('remote');
  const view = render(header());
  await hover();
  expect(unavailable().getAttribute('aria-label')).toContain(i18n.t('remoteDesktop.accessRevoked'));
  act(() => revokedDevicesStore.clearAll());
  fixture.devices = [];
  view.rerender(header());
  await act(async () => vi.advanceTimersByTimeAsync(200));
  unavailable();
  expect(invoke).not.toHaveBeenCalled();
});

it.each([
  null,
  { ...capabilities, enabled: false },
  { ...capabilities, version: 0 },
  { ...capabilities, displays: [] },
  { ...capabilities, displays: [{ id: 'screen', width: '1920', height: 1080 }] },
  { ...capabilities, permissions: { screenRecording: 'missing', accessibility: 'granted' } },
])('shows an unavailable icon when desktop capabilities reject access: %j', async (value) => {
  invoke.mockResolvedValue(value);
  render(header());
  await hover();
  unavailable();
});

it('allows viewing when only input control or accessibility permission is unavailable', async () => {
  invoke.mockResolvedValue({
    ...capabilities,
    canControl: false,
    permissions: {
      screenRecording: 'granted',
      accessibility: 'missing',
    },
  });
  render(header());
  await hover();
  expect(
    screen.getByRole('button', { name: 'Open remote desktop' }).getAttribute('aria-disabled'),
  ).toBe('false');
});

it.each(['CHANNEL_NOT_ALLOWED', 'ACCESS_REVOKED', 'INVOKE_TIMEOUT'])(
  'marks a rejected probe unavailable without showing a hover-triggered toast: %s',
  async (code) => {
    invoke.mockRejectedValue(new Error(code));
    render(header());
    await hover();
    unavailable();
    expect(toast.error).not.toHaveBeenCalled();
  },
);

it('debounces quick passes, refreshes on re-entry, and never polls while hovering', async () => {
  render(header());
  fireEvent.mouseEnter(row());
  fireEvent.mouseLeave(row());
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(invoke).not.toHaveBeenCalled();
  await hover();
  fireEvent.mouseLeave(row());
  invoke.mockResolvedValue({ ...capabilities, enabled: false });
  await hover();
  unavailable();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('ignores a late capability reply after the machine goes offline', async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(header());
  await hover();
  fixture.devices = [{ ...device(), online: false }];
  view.rerender(header());
  await act(async () => resolve(capabilities));
  expect(unavailable().getAttribute('aria-label')).toContain('This computer is offline.');
});

it('keeps keyboard focus on the same action while its availability changes', async () => {
  render(header());
  const action = screen.getByRole('button', { name: 'Checking remote desktop…' });
  const matches = action.matches.bind(action);
  vi.spyOn(action, 'matches').mockImplementation(
    (selector) => selector === ':focus-visible' || matches(selector),
  );
  act(() => action.focus());
  await act(async () => vi.advanceTimersByTimeAsync(151));
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  expect(document.activeElement).toBe(action);
});

it('turns a failed open into an unavailable icon and coalesces repeated clicks', async () => {
  let reject!: (error: Error) => void;
  open.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  render(header());
  await hover();
  const action = screen.getByRole('button', { name: 'Open remote desktop' });
  fireEvent.click(action);
  fireEvent.click(action);
  expect(open).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('ACCESS_REVOKED')));
  expect(
    screen
      .getByRole('button', { name: /^Remote desktop unavailable:/ })
      .querySelector('.lucide-monitor-off'),
  ).not.toBeNull();
  expect(toast.error).toHaveBeenCalledWith(i18n.t('remoteDesktop.connectionError'));
});
