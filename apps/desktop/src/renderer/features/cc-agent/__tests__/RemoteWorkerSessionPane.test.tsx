// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteWorkerSessionPane } from '../RemoteWorkerSessionPane';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sessionViewProps: null as Record<string, unknown> | null,
  store: {
    getSessionDeviceId: vi.fn<(id: string) => string | undefined>(() => undefined),
    pinSessionOrigin: vi.fn(),
    captureSessionRead: vi.fn(() =>
      Object.assign(() => true, { mergeActivity: (session: unknown) => session }),
    ),
    getDeviceSessions: vi.fn<() => Array<{ id: string }>>(() => []),
    getDeviceName: vi.fn(() => 'Mac mini'),
    mergeDeviceSessions: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { device?: string }) => (opts?.device ? `${key}:${opts.device}` : key),
  }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: mocks.store }));
vi.mock('../CCAgentSessionView', () => ({
  CCAgentSessionView: (props: Record<string, unknown>) => {
    mocks.sessionViewProps = props;
    return <div data-testid="session-view" />;
  },
}));

const device = {
  deviceId: 'mac-mini',
  remoteSessionId: 'remote-1',
  deviceName: 'Mac mini',
  reachable: true as boolean | null,
  workingDir: '/Users/demo/Interviews',
};

describe('RemoteWorkerSessionPane', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.sessionViewProps = null;
    Object.values(mocks.store).forEach((fn) => fn.mockClear());
    mocks.store.getSessionDeviceId.mockReturnValue(undefined);
    mocks.store.getDeviceSessions.mockReturnValue([]);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      deviceLink: { invoke: mocks.invoke },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('pins the task to the execution device before reading it, then shows it', async () => {
    mocks.invoke.mockResolvedValue({ id: 'remote-1', status: 'active' });
    render(
      <RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />,
    );
    expect(screen.getByText('orca.rolePill.executionDevice:Mac mini')).toBeTruthy();
    expect(screen.getByText('/Users/demo/Interviews')).toBeTruthy();
    await screen.findByTestId('session-view');
    expect(mocks.store.pinSessionOrigin).toHaveBeenCalledWith('mac-mini', 'remote-1');
    expect(mocks.store.pinSessionOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[0]!,
    );
    expect(mocks.invoke).toHaveBeenCalledWith('mac-mini', 'local-db:sessions:get', ['remote-1']);
    expect(mocks.store.mergeDeviceSessions).toHaveBeenCalledWith('mac-mini', 'Mac mini', [
      { id: 'remote-1', status: 'active' },
    ]);
    expect(mocks.sessionViewProps).toMatchObject({
      sessionIdProp: 'remote-1',
      sidebarTargetSessionId: 'lead-1',
      navigationMode: 'sidebar-embedded',
    });
  });

  it('only explains the situation while the device is unreachable, then recovers', async () => {
    const { rerender } = render(
      <RemoteWorkerSessionPane
        leadSessionId="lead-1"
        device={{ ...device, reachable: false }}
        viewVisible
        chatRealtime
      />,
    );
    expect(screen.getByText('orca.split.remoteWorkerUnreachable:Mac mini')).toBeTruthy();
    expect(screen.getByText('orca.rolePill.deviceUnreachable')).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValue({ id: 'remote-1', status: 'active' });
    rerender(
      <RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />,
    );
    await screen.findByTestId('session-view');
  });

  it('refuses a task already owned by another device', async () => {
    mocks.store.getSessionDeviceId.mockReturnValue('other-pc');
    render(
      <RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />,
    );
    await waitFor(() =>
      expect(screen.getByText('orca.split.remoteWorkerUnreachable:Mac mini')).toBeTruthy(),
    );
    expect(mocks.store.pinSessionOrigin).not.toHaveBeenCalled();
    expect(mocks.sessionViewProps).toBeNull();
  });

  it('keeps a loaded task mounted and read only while offline, then recovers', async () => {
    mocks.invoke.mockResolvedValue({ id: 'remote-1', status: 'active' });
    const { rerender } = render(<RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />);
    const view = await screen.findByTestId('session-view');
    rerender(<RemoteWorkerSessionPane leadSessionId="lead-1" device={{ ...device, reachable: false }} viewVisible chatRealtime />);
    expect(screen.getByTestId('session-view')).toBe(view);
    expect(mocks.sessionViewProps?.readOnly).toBe(true);
    rerender(<RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />);
    await waitFor(() => expect(mocks.sessionViewProps?.readOnly).toBe(false));
    expect(screen.getByTestId('session-view')).toBe(view);
  });

  it('opens an already cached task while offline without a remote call', async () => {
    mocks.store.getDeviceSessions.mockReturnValue([{ id: 'remote-1' }]);
    render(<RemoteWorkerSessionPane leadSessionId="lead-1" device={{ ...device, reachable: false }} viewVisible chatRealtime />);
    await screen.findByTestId('session-view');
    expect(mocks.sessionViewProps?.readOnly).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('allows retry after a transient read failure on a reachable device', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ id: 'remote-1', status: 'active' });
    render(<RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />);
    fireEvent.click(await screen.findByRole('button', { name: 'commonUi.retry' }));
    await screen.findByTestId('session-view');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.sessionViewProps?.readOnly).toBe(false);
  });
});
