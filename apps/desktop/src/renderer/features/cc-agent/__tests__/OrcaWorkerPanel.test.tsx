// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrcaWorkerPanel } from '../OrcaWorkerPanel';
import { requestNewWorkerFromShortcut } from '../lib/newWorkerShortcut';
import { OrcaWorkersTabBody } from '../../right-sidebar/plugins/orca-workers/OrcaWorkersTabBody';

const mocks = vi.hoisted(() => ({
  hardLimit: 2,
  refreshCreationState: vi.fn(),
  setCreateOpen: vi.fn(),
  toastError: vi.fn(),
  toolbarProps: {} as Record<string, unknown>,
  createProps: {} as Record<string, unknown>,
  sessionViewProps: null as Record<string, unknown> | null,
  remotePaneProps: null as Record<string, unknown> | null,
  selection: {} as Record<string, unknown>,
  sessions: [] as Array<{ id: string; agentDeviceId?: string | null; orcaRole?: 'lead' }>,
  sessionsLoading: false,
  sidebarWindow: false,
  workerAgentInput: null as Record<string, unknown> | null,
  workerAgentDevices: {
    leadAgentDeviceId: 'agent-pc' as string | null,
    devices: [{ deviceId: 'agent-pc', name: 'Agent PC' }] as Array<{ deviceId: string; name: string }> | undefined,
  },
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useAgentIslandSettings', () => ({ isAgentIslandSupported: () => false }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => mocks.sidebarWindow }));
vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: mocks.sessions, isLoading: mocks.sessionsLoading }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
}));
vi.mock('@/hooks/useWindowVisible', () => ({
  useWindowVisible: () => true,
  useDocumentVisible: () => true,
}));
vi.mock('../hooks/useOrcaWorkerAttentionWatcher', () => ({
  useOrcaWorkerAttentionByLeadIds: vi.fn(),
}));
vi.mock('../hooks/useStopOrcaCollab', () => ({
  useStopOrcaCollabWithoutNavigation: () => ({ requestStop: vi.fn() }),
}));
vi.mock('../hooks/workerProjectionStore', () => ({
  useWorkerProjectionOwner: vi.fn(),
  revalidateActiveWorkersProjection: vi.fn(),
  revalidateActiveWorkerSettings: vi.fn(),
}));
vi.mock('../../right-sidebar/plugins/orca-workers/actions', () => ({
  clearOrcaWorkersSelectionIntent: vi.fn(),
  consumeOrcaWorkersFocusHint: vi.fn(),
  consumeOrcaWorkersSearchJump: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));
vi.mock('../CCAgentSessionView', () => ({
  CCAgentSessionView: (props: Record<string, unknown>) => {
    mocks.sessionViewProps = props;
    return null;
  },
}));
vi.mock('../hooks/useWorkerAgentDevices', () => ({
  useWorkerAgentDevices: (input: Record<string, unknown>) => {
    mocks.workerAgentInput = input;
    return mocks.workerAgentDevices;
  },
}));
vi.mock('../CreateWorkerPopover', () => ({
  CreateWorkerPopover: (props: Record<string, unknown>) => {
    mocks.createProps = props;
    return null;
  },
}));
vi.mock('../RemoteWorkerSessionPane', () => ({
  RemoteWorkerSessionPane: (props: Record<string, unknown>) => {
    mocks.remotePaneProps = props;
    return null;
  },
}));
vi.mock('../RolePillDropdown', () => ({
  WorkerListToolbar: (props: Record<string, unknown>) => {
    mocks.toolbarProps = props;
    return null;
  },
}));
vi.mock('../hooks/useOrcaWorkerSelection', () => ({
  useOrcaWorkerSelection: () => ({
    workers: [],
    focusedWorker: null,
    activeWorkerCount: 0,
    softLimit: 1,
    hardLimit: mocks.hardLimit,
    refresh: vi.fn(),
    refreshCreationState: mocks.refreshCreationState,
    selectedWorkerRecord: null,
    selectedWorkerId: null,
    workerSessionId: null,
    createOpen: false,
    setCreateOpen: mocks.setCreateOpen,
    handleCreateWorker: vi.fn(),
    handleSwitchFocus: vi.fn(),
    handleArchiveWorker: vi.fn(),
    workerPermissionMode: 'auto',
    ...mocks.selection,
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OrcaWorkerPanel New Maker shortcut', () => {
  beforeEach(() => {
    mocks.hardLimit = 2;
    mocks.refreshCreationState.mockReset();
    mocks.setCreateOpen.mockReset();
    mocks.toastError.mockReset();
    mocks.toolbarProps = {};
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the existing create dialog only from the visible collaboration panel', async () => {
    mocks.refreshCreationState.mockResolvedValue({
      status: 'applied',
      workers: [],
      hardLimit: 2,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.refreshCreationState).toHaveBeenCalledOnce();
    expect(mocks.setCreateOpen).toHaveBeenCalledWith(true);
  });

  it('consumes the shortcut without opening when the refreshed team is at the hard limit', async () => {
    mocks.hardLimit = 1;
    mocks.refreshCreationState.mockResolvedValue({
      status: 'applied',
      workers: [{ status: 'running' }],
      hardLimit: 1,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
  });

  it('consumes the shortcut and reports an error when authoritative creation state cannot be refreshed', async () => {
    mocks.refreshCreationState.mockResolvedValue({
      status: 'failed',
      workers: [],
      hardLimit: null,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'newChat.collaboration.createWorkerRefreshFailed',
    );
  });

  it('does not retain an in-flight shortcut after the visible panel unmounts', async () => {
    const pending = deferred<{ status: 'applied'; workers: []; hardLimit: number }>();
    mocks.refreshCreationState.mockReturnValue(pending.promise);
    const panel = render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    const request = requestNewWorkerFromShortcut();
    await waitFor(() => expect(mocks.refreshCreationState).toHaveBeenCalledOnce());
    panel.unmount();
    await act(async () => pending.resolve({ status: 'applied', workers: [], hardLimit: 2 }));

    await expect(request).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
    await expect(requestNewWorkerFromShortcut()).resolves.toBe(false);
  });
});

describe('OrcaWorkerPanel settings navigation wiring', () => {
  afterEach(() => {
    cleanup();
  });

  it('omits settings navigation for device-link controlled leads', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="dev-1" viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeUndefined();
  });

  it('wires settings navigation for local leads', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeTypeOf('function');
  });

  it('fails closed for unresolved device ownership', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeUndefined();
  });
});

describe('OrcaWorkerPanel worker on another computer', () => {
  afterEach(() => {
    cleanup();
    mocks.selection = {};
    mocks.sessionViewProps = null;
    mocks.remotePaneProps = null;
  });

  const remoteWorker = {
    workerId: 'w-1',
    sessionId: 'proxy-1',
    role: 'transcriber',
    agent: 'claude-code',
    model: 'm',
    effort: null,
    label: null,
    status: 'running',
    focused: true,
    idleSince: null,
    executionDevice: {
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      deviceName: 'Mac mini',
      reachable: true,
      workingDir: '/Users/demo/Interviews',
    },
  };

  it('shows the task on the execution device instead of the local proxy task', () => {
    mocks.selection = {
      workers: [remoteWorker],
      focusedWorker: remoteWorker,
      selectedWorkerRecord: remoteWorker,
      selectedWorkerId: 'w-1',
      workerSessionId: 'proxy-1',
    };
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.sessionViewProps).toBeNull();
    expect(mocks.remotePaneProps).toMatchObject({
      leadSessionId: 'lead-1',
      device: remoteWorker.executionDevice,
    });
  });

  it('keeps local workers on the local task view', () => {
    const localWorker: Record<string, unknown> = { ...remoteWorker };
    delete localWorker.executionDevice;
    mocks.selection = {
      workers: [localWorker],
      focusedWorker: localWorker,
      selectedWorkerRecord: localWorker,
      selectedWorkerId: 'w-1',
      workerSessionId: 'proxy-1',
    };
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.remotePaneProps).toBeNull();
    expect(mocks.sessionViewProps).toMatchObject({ sessionIdProp: 'proxy-1' });
  });

  it('offers execution devices only for a confirmed local Lead and local Agent', () => {
    const { rerender } = render(
      <OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} agentDeviceId={null} viewVisible />,
    );
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} agentDeviceId={null} sshRemote viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="dev-1" agentDeviceId={null} viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} agentDeviceId="agent-pc" viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
  });

  it("hands the Lead's Agent location and the other computers to the Worker dialog", () => {
    const { rerender } = render(
      <OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} agentDeviceId="agent-pc" viewVisible />,
    );
    expect(mocks.workerAgentInput).toMatchObject({ controlledDeviceId: null, leadAgentDeviceId: 'agent-pc' });
    expect(mocks.createProps).toMatchObject({
      leadAgentDeviceId: 'agent-pc',
      remoteAgentDevices: [{ deviceId: 'agent-pc', name: 'Agent PC' }],
    });
    // Lead 的 Agent 位置还没解析时不按任何一台读候选。
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="dev-1" viewVisible />);
    expect(mocks.workerAgentInput).toMatchObject({ controlledDeviceId: undefined });
  });
});

describe('OrcaWorkersTabBody Lead Agent context', () => {
  const ctx = {
    tabId: 'orca-tab',
    sessionId: 'lead-1',
    workdir: '/projects/lead',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
  };

  beforeEach(() => {
    mocks.sessions = [];
    mocks.sessionsLoading = false;
    mocks.sidebarWindow = false;
    mocks.createProps = {};
    mocks.selection = {};
    mocks.setCreateOpen.mockReset();
    mocks.refreshCreationState.mockResolvedValue({
      status: 'applied', workers: [], hardLimit: 2,
    });
  });

  afterEach(() => {
    cleanup();
    mocks.sidebarWindow = false;
  });

  it.each([false, true])('hides execution devices for a remote Agent while keeping creation available (detached: %s)', async (detached) => {
    mocks.sidebarWindow = detached;
    mocks.sessions = [
      { id: 'other-lead', agentDeviceId: null, orcaRole: 'lead' },
      { id: 'lead-1', agentDeviceId: 'agent-pc', orcaRole: 'lead' },
    ];
    const { rerender } = render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    expect(mocks.createProps.onCreate).toBeTypeOf('function');
    await act(async () => (mocks.toolbarProps.onOpenCreate as () => void)());
    expect(mocks.setCreateOpen).toHaveBeenCalledWith(true);

    mocks.sessions = [{ id: 'lead-1', agentDeviceId: null, orcaRole: 'lead' }];
    rerender(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
  });

  it('does not offer execution devices before Lead metadata is available', () => {
    mocks.sessionsLoading = true;
    const { rerender } = render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);

    mocks.sessionsLoading = false;
    mocks.sessions = [{ id: 'lead-1', orcaRole: 'lead' }];
    rerender(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
  });
});
