// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { RemoteWorkerSessionPane } from '../RemoteWorkerSessionPane';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  ensureInitialMessages: vi.fn(),
  releaseHistory: vi.fn(),
  localDeviceId: 'this-mac' as string | null,
  sessionViewProps: null as Record<string, unknown> | null,
  store: {
    subscribe: vi.fn(() => () => undefined),
    getSessionDeviceId: vi.fn<(id: string) => string | undefined>(() => undefined),
    pinSessionOrigin: vi.fn(),
    captureSessionRead: vi.fn(() =>
      Object.assign(() => true, { mergeActivity: (session: unknown) => session }),
    ),
    getDeviceSessions: vi.fn<() => Array<{ id: string }>>(() => []),
    getDeviceName: vi.fn(() => 'Mac mini'),
    getDeviceLifecycleEpoch: vi.fn(() => 0),
    mergeDeviceSessions: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, opts?: { device?: string }) => (opts?.device ? `${key}:${opts.device}` : key),
  }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: mocks.store }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthDeviceId: () => mocks.localDeviceId }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    ensureInitialMessages: mocks.ensureInitialMessages,
    enterView: () => mocks.releaseHistory,
  },
}));
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
    mocks.ensureInitialMessages.mockClear();
    mocks.releaseHistory.mockClear();
    mocks.sessionViewProps = null;
    mocks.localDeviceId = 'this-mac';
    Object.values(mocks.store).forEach((fn) => fn.mockClear());
    const origins = new Map<string, string>();
    mocks.store.getSessionDeviceId.mockImplementation((id) => origins.get(id));
    mocks.store.pinSessionOrigin.mockImplementation((host, id) => { origins.set(id, host); });
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
    expect(await screen.findByText('orca.split.remoteWorkerUnreachable:Mac mini')).toBeTruthy();
    expect(screen.getByText('orca.rolePill.deviceUnreachable')).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValue({ id: 'remote-1', status: 'active' });
    rerender(
      <RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />,
    );
    await screen.findByTestId('session-view');
  });

  it('starts history before cold metadata settles and shares a pending metadata read on return', async () => {
    const row = { id: 'remote-1', status: 'active' };
    let resolveFirst!: (value: typeof row) => void;
    mocks.invoke.mockImplementation((host: string) => host === 'mac-mini'
      ? new Promise<typeof row>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve({ id: 'remote-2', status: 'active' }));
    const show = (target: typeof device) => (
      <RemoteWorkerSessionPane key={target.remoteSessionId} leadSessionId="lead-1"
        device={target} viewVisible chatRealtime />
    );
    const pane = render(show(device));
    await waitFor(() => expect(mocks.ensureInitialMessages).toHaveBeenCalledTimes(1));
    const firstRead = mocks.ensureInitialMessages.mock.calls[0][1];
    expect(screen.queryByTestId('session-view')).toBeNull();

    pane.rerender(show({ ...device, deviceId: 'other-pc', remoteSessionId: 'remote-2' }));
    await screen.findByTestId('session-view');
    expect(mocks.sessionViewProps?.sessionIdProp).toBe('remote-2');
    expect(mocks.releaseHistory).toHaveBeenCalledTimes(1);
    pane.rerender(show(device));
    await waitFor(() => expect(mocks.ensureInitialMessages).toHaveBeenCalledTimes(3));
    expect(mocks.ensureInitialMessages.mock.calls[2]).toEqual(['remote-1', firstRead]);
    expect(mocks.invoke.mock.calls.filter(([host]) => host === 'mac-mini')).toHaveLength(1);

    await act(async () => resolveFirst(row));
    await screen.findByTestId('session-view');
    expect(mocks.sessionViewProps?.sessionIdProp).toBe('remote-1');
    expect(mocks.store.mergeDeviceSessions.mock.calls.filter(([host]) => host === 'mac-mini')).toHaveLength(1);
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

  it('loads the same device and task again after an account change without applying the old row', async () => {
    const originalOwner = getDataOwnerGeneration().dataOwnerId;
    const row = { id: 'remote-1', status: 'active', title: 'Previous' };
    let finishPrevious!: (value: typeof row) => void;
    mocks.invoke
      .mockImplementationOnce(() => new Promise<typeof row>((resolve) => { finishPrevious = resolve; }))
      .mockResolvedValueOnce({ ...row, title: 'Current' });
    const pane = () => <RemoteWorkerSessionPane leadSessionId="lead-1" device={device} viewVisible chatRealtime />;
    try {
      setDataOwnerGeneration('previous-owner');
      const view = render(pane());
      await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
      setDataOwnerGeneration('current-owner');
      view.rerender(pane());
      await screen.findByTestId('session-view');
      await act(async () => finishPrevious(row));
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
      expect(mocks.releaseHistory).toHaveBeenCalledTimes(1);
      expect(mocks.store.mergeDeviceSessions).toHaveBeenCalledExactlyOnceWith('mac-mini', 'Mac mini', [
        { ...row, title: 'Current' },
      ]);
    } finally {
      setDataOwnerGeneration(originalOwner);
    }
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

  it('opens a worker that runs on this computer as a local task, never as a remote mirror', async () => {
    render(
      <RemoteWorkerSessionPane
        leadSessionId="lead-1"
        device={{ ...device, deviceId: 'this-mac', reachable: null }}
        viewVisible
        chatRealtime
      />,
    );
    await screen.findByTestId('session-view');
    expect(mocks.sessionViewProps).toMatchObject({ sessionIdProp: 'remote-1', readOnly: false });
    // 本机任务一旦钉成「本机这台设备上的远程任务」，侧栏会多出一条同 id 的远程行，归档也会绕隧道写回本机。
    expect(mocks.store.pinSessionOrigin).not.toHaveBeenCalled();
    expect(mocks.store.mergeDeviceSessions).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('waits for the local device id before registering an execution device', async () => {
    mocks.localDeviceId = null;
    mocks.invoke.mockResolvedValue({ id: 'remote-1', status: 'active' });
    const offline = { ...device, reachable: false };
    const { rerender } = render(
      <RemoteWorkerSessionPane leadSessionId="lead-1" device={offline} viewVisible chatRealtime />,
    );
    expect(screen.getByText('orca.split.remoteWorkerLoading:Mac mini')).toBeTruthy();
    // 还不知道任务在不在本机时，不能先闪一下「连不上」。
    expect(screen.queryByText('orca.rolePill.deviceUnreachable')).toBeNull();
    expect(mocks.store.pinSessionOrigin).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.localDeviceId = 'this-mac';
    rerender(
      <RemoteWorkerSessionPane leadSessionId="lead-1" device={offline} viewVisible chatRealtime />,
    );
    await screen.findByText('orca.split.remoteWorkerUnreachable:Mac mini');
    expect(mocks.store.pinSessionOrigin).toHaveBeenCalledWith('mac-mini', 'remote-1');
    expect(screen.getByText('orca.rolePill.deviceUnreachable')).toBeTruthy();
  });
});
