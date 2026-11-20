// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPerformanceTraceProbe } from '@/lib/performanceTraceProbe';
import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';
import type { PerformanceTraceEvent } from '../../../../shared/performanceTrace';
import { OrcaWorkerPanel } from '../OrcaWorkerPanel';
import { requestNewWorkerFromShortcut } from '../lib/newWorkerShortcut';
import type { WorkerInfo } from '../hooks/useWorkers';
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
  focusWorkers: null as WorkerInfo[] | null,
  switchFocus: vi.fn<(input: { leadSessionId: string; workerIdOrLabel: string }) => Promise<void>>(),
  refreshFocus: vi.fn(),
  resolveInteraction: vi.fn(),
  selectionInput: null as Record<string, unknown> | null,
  sessions: [] as Array<{ id: string; agentDeviceId?: string | null; orcaRole?: 'lead' }>,
  sessionsLoading: false,
  sidebarWindow: false,
  windowVisible: true,
  watchAttention: vi.fn(),
  refreshProjection: vi.fn(),
  refreshSettings: vi.fn(),
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
const origins = vi.hoisted(() => {
  const map = new Map<string, string>();
  const listeners = new Set<() => void>();
  return {
    map,
    store: {
      getSessionDeviceId: (sessionId: string) => map.get(sessionId),
      pinSessionOrigin: (deviceId: string, sessionId: string) => {
        map.set(sessionId, deviceId);
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
});
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
  remoteProjectsStore: origins.store,
}));
vi.mock('@/hooks/useWindowVisible', () => ({
  useWindowVisible: () => mocks.windowVisible,
  useDocumentVisible: () => true,
}));
vi.mock('../hooks/useOrcaWorkerAttentionWatcher', () => ({
  useOrcaWorkerAttentionByLeadIds: mocks.watchAttention,
}));
vi.mock('../hooks/useStopOrcaCollab', () => ({
  useStopOrcaCollabWithoutNavigation: () => ({ requestStop: vi.fn() }),
}));
vi.mock('../hooks/workerProjectionStore', () => ({
  useWorkerProjectionOwner: vi.fn(),
  revalidateActiveWorkersProjection: mocks.refreshProjection,
  revalidateActiveWorkerSettings: mocks.refreshSettings,
}));
vi.mock('../../right-sidebar/plugins/orca-workers/actions', () => ({
  clearOrcaWorkersSelectionIntent: vi.fn(),
  consumeOrcaWorkersFocusHint: vi.fn(),
  consumeOrcaWorkersSearchJump: vi.fn(),
  writeOrcaWorkersFocusIntent: vi.fn(),
}));
vi.mock('../../right-sidebar/lib/mergeSidebarWindowBack', () => ({
  mergeSidebarWindowBack: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/makerTransport', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/makerTransport')>(),
  orcaWorkflowsFor: () => ({ switchFocus: mocks.switchFocus }),
}));
vi.mock('../hooks/useWorkers', () => ({
  useWorkers: () => ({
    workers: mocks.focusWorkers ?? [],
    focusedWorker: mocks.focusWorkers?.find((worker) => worker.focused) ?? null,
    refresh: mocks.refreshFocus,
  }),
}));

function renderWorkerApproval(sessionId: unknown) {
  if (!mocks.focusWorkers || (sessionId !== 'session-b' && sessionId !== 'remote-b')) return null;
  return <PermissionPrompt
    permission={{ requestId: 'request-b', toolName: 'Write', input: { file_path: 'pending.txt' } }}
    onRespond={(decision) => mocks.resolveInteraction(sessionId, 'request-b', decision)}
  />;
}

vi.mock('../CCAgentSessionView', () => ({
  CCAgentSessionView: (props: Record<string, unknown>) => {
    mocks.sessionViewProps = { ...props, originAtMount: origins.map.get(props.sessionIdProp as string) ?? null };
    return renderWorkerApproval(props.sessionIdProp);
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
    return renderWorkerApproval((props.device as WorkerInfo['executionDevice'])?.remoteSessionId);
  },
}));
vi.mock('../RolePillDropdown', () => ({
  WorkerListToolbar: (props: Record<string, unknown>) => {
    mocks.toolbarProps = props;
    return mocks.focusWorkers ? (
      <button type="button" onClick={() => (props.onSwitchFocus as (id: string) => void)('worker-b')}>
        Worker B
      </button>
    ) : null;
  },
}));
vi.mock('../hooks/useOrcaWorkerSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useOrcaWorkerSelection')>();
  return { useOrcaWorkerSelection: (input: Parameters<typeof actual.useOrcaWorkerSelection>[0]) => {
    if (mocks.focusWorkers) return actual.useOrcaWorkerSelection(input);
    mocks.selectionInput = { ...input };
    return {
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
    editWorker: null,
    handleOpenEditWorker: vi.fn(),
    handleCloseEditWorker: vi.fn(),
    handleUpdateWorker: vi.fn(),
    handleCreateWorker: vi.fn(),
    handleSwitchFocus: vi.fn(),
    handleArchiveWorker: vi.fn(),
    workerPermissionMode: 'auto',
    ...mocks.selection,
    };
  } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OrcaWorkerPanel pending focus', () => {
  afterEach(() => { cleanup(); mocks.focusWorkers = null; });

  // The real selection and approval paths previously let a deferred focus expose
  // Worker's pending approval before switchFocus could succeed or fail.
  it.each(['local', 'remote'] as const)('gates %s Worker approval until focus succeeds', async (kind) => {
    mocks.resolveInteraction.mockClear();
    mocks.toastError.mockClear();
    mocks.switchFocus.mockReset();
    const worker: WorkerInfo = {
      workerId: 'worker-a', sessionId: 'session-a', role: 'developer', agent: 'codex',
      model: 'gpt-5.4', effort: null, label: null, status: 'running', focused: true, idleSince: null,
    };
    const target: WorkerInfo = {
      ...worker, workerId: 'worker-b', sessionId: 'session-b', focused: false,
      ...(kind === 'remote' ? {
        executionDevice: {
          deviceId: 'pc-b', remoteSessionId: 'remote-b', deviceName: 'PC B', reachable: true, workingDir: null,
        },
      } : {}),
    };
    mocks.focusWorkers = [worker, target];
    mocks.refreshFocus.mockImplementation(async () => {
      mocks.focusWorkers = [{ ...worker, focused: false }, { ...target, focused: true }];
      return { status: 'applied', workers: mocks.focusWorkers };
    });
    let rejectFocus!: (error: Error) => void;
    const permittedFocus = deferred<void>();
    mocks.switchFocus
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFocus = reject; }))
      .mockReturnValueOnce(permittedFocus.promise);
    render(<MemoryRouter><OrcaWorkerPanel leadSessionId="lead-approval" deviceId={null} viewVisible /></MemoryRouter>);

    const attemptApproval = () => {
      const allow = screen.queryByRole('button', { name: /allowOnce/ });
      if (allow) fireEvent.click(allow);
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(mocks.resolveInteraction).not.toHaveBeenCalled();
      expect(allow).toBeNull();
    };
    fireEvent.click(screen.getByRole('button', { name: 'Worker B' }));
    expect(mocks.toolbarProps.selectedWorkerId).toBe('worker-b');
    attemptApproval();
    await act(async () => rejectFocus(new Error('focus request denied')));
    expect(mocks.toolbarProps.selectedWorkerId).toBe('worker-a');
    expect(mocks.toastError).toHaveBeenCalledWith('focus request denied');
    attemptApproval();

    fireEvent.click(screen.getByRole('button', { name: 'Worker B' }));
    attemptApproval();
    await act(async () => permittedFocus.resolve(undefined));
    fireEvent.click(await screen.findByRole('button', { name: /allowOnce/ }));
    expect(mocks.resolveInteraction).toHaveBeenCalledExactlyOnceWith(
      kind === 'remote' ? 'remote-b' : 'session-b', 'request-b', { behavior: 'allow' },
    );
  });
});

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
    expect(mocks.toolbarProps.onEditWorker).toBeTypeOf('function');
  });

  it('fails closed for unresolved device ownership', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeUndefined();
    expect(mocks.toolbarProps.onEditWorker).toBeUndefined();
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

  it('only records commits for the latest switch, including a remote worker history', () => {
    const events: PerformanceTraceEvent[] = [];
    const stop = installPerformanceTraceProbe(batch => events.push(...batch));
    const showWorker = (workerId: string) => {
      const row = { ...remoteWorker, workerId, sessionId: workerId };
      mocks.selection = { workers: [row], selectedWorkerRecord: row, selectedWorkerId: workerId, workerSessionId: workerId };
    };
    try {
      showWorker('old');
      const panel = render(<OrcaWorkerPanel leadSessionId="lead" deviceId={null} viewVisible />);
      const select = mocks.toolbarProps.onSwitchFocus as (target: string) => void;
      select('superseded');
      select('latest');
      showWorker('superseded');
      panel.rerender(<OrcaWorkerPanel leadSessionId="lead" deviceId={null} viewVisible />);
      expect(mocks.remotePaneProps!.onHistoryCommit).toBeUndefined();
      showWorker('latest');
      panel.rerender(<OrcaWorkerPanel leadSessionId="lead" deviceId={null} viewVisible />);
      const ready = mocks.remotePaneProps!.onHistoryCommit as (stage: string) => void;
      ready('history');
      ready('history');
      ready('input');
      ready('fresh-history');
    } finally {
      stop();
    }
    const ops = events.filter(e => e.kind === 'operation');
    expect(ops.map(e => e.label)).toEqual([
      'worker-switch', 'worker-switch-cancelled', 'worker-switch', 'worker-selection-commit',
      'worker-history-commit', 'worker-input-ready', 'worker-history-fresh-commit',
    ]);
    expect(ops.slice(3).map(e => e.at)).toEqual(Array(4).fill(ops[2].at));
  });

  it('rejects a history callback captured before returning to the same Worker', () => {
    const events: PerformanceTraceEvent[] = [];
    const stop = installPerformanceTraceProbe((batch) => events.push(...batch));
    const show = (workerId: string) => {
      const row = { ...remoteWorker, workerId, sessionId: workerId };
      mocks.selection = { workers: [row], selectedWorkerRecord: row, selectedWorkerId: workerId, workerSessionId: workerId };
      return <OrcaWorkerPanel leadSessionId="lead" deviceId={null} viewVisible />;
    };
    try {
      const panel = render(show('start'));
      const select = (id: string) => (mocks.toolbarProps.onSwitchFocus as (target: string) => void)(id);
      select('a');
      panel.rerender(show('a'));
      const obsolete = mocks.remotePaneProps!.onHistoryCommit as (stage: string) => void;
      select('b');
      panel.rerender(show('b'));
      select('a');
      panel.rerender(show('a'));
      obsolete('history');
      const current = mocks.remotePaneProps!.onHistoryCommit as (stage: string) => void;
      current('input');
      current('history');
    } finally {
      stop();
    }
    expect(events.filter(({ label }) => label === 'worker-history-commit' || label === 'worker-input-ready')
      .map(({ label }) => label)).toEqual(['worker-input-ready', 'worker-history-commit']);
  });

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
    expect(origins.map.has('proxy-1')).toBe(false);
  });

  /**
   * 测试价值
   * - 生产入口与可观察结果：真实 OrcaWorkerPanel；远程 Lead 的同机 worker 在任务视图挂载时
   *   已登记到 Lead 的设备，列表里其它同机 worker 也已登记（工具栏的项目行不再走本机 IPC）。
   * - Bug 依据：2026-11-17 唤醒后 Mac Studio 的分片尚未刷新，worker 不在镜像里，协同面板走本机
   *   local-db:sessions:get → 「找不到这条任务」，并报 maker:worker:project-label「Local project required」。
   * - 规则：remote-and-mobile-adaptation「Orca 远程 worker」—— 数据库读取失败不得回退到本机。
   * - 现有覆盖缺口：只覆盖了单独运行设备的 worker（RemoteWorkerSessionPane 自行登记）与本机 Lead。
   * - 最小失败输入：deviceId='studio'，选中 worker 无 executionDevice，归属表为空。
   * - tier：unit（jsdom）。
   */
  it('routes a remote Lead\'s same-device workers to that device before the task view mounts', () => {
    origins.map.clear();
    const localWorker: Record<string, unknown> = { ...remoteWorker };
    delete localWorker.executionDevice;
    const sibling = { ...localWorker, workerId: 'w-2', sessionId: 'proxy-2', focused: false };
    const elsewhere = { ...remoteWorker, workerId: 'w-3', sessionId: 'proxy-3', focused: false };
    const known = { ...localWorker, workerId: 'w-4', sessionId: 'proxy-known', focused: false };
    origins.map.set('proxy-known', 'mac-mini');
    mocks.selection = {
      workers: [localWorker, sibling, elsewhere, known],
      focusedWorker: localWorker,
      selectedWorkerRecord: localWorker,
      selectedWorkerId: 'w-1',
      workerSessionId: 'proxy-1',
    };
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="studio" viewVisible />);
    expect(mocks.sessionViewProps).toMatchObject({ sessionIdProp: 'proxy-1', originAtMount: 'studio' });
    expect(origins.map.get('proxy-2')).toBe('studio');
    // A worker on its own execution device keeps that device's pane; no lead-device pin.
    expect(origins.map.has('proxy-3')).toBe(false);
    // An origin already known for another device is never overwritten.
    expect(origins.map.get('proxy-known')).toBe('mac-mini');
    origins.map.clear();
  });

  // PR #6787: the work computer no longer depends on the Lead's Agent location.
  // Exercise the real panel's dialog contract, retaining SSH/controlled limits.
  it('offers execution devices for a confirmed local Lead independently of its Agent location', () => {
    const { rerender } = render(
      <OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} agentDeviceId={null} viewVisible />,
    );
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} agentDeviceId={null} sshRemote viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="dev-1" agentDeviceId={null} viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} agentDeviceId="agent-pc" viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
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

describe('OrcaWorkerPanel in the separate sidebar window', () => {
  const localWorker = {
    workerId: 'w-1',
    sessionId: 'worker-s1',
    role: 'developer',
    agent: 'claude-code',
    model: 'm',
    effort: null,
    label: null,
    status: 'running',
    focused: true,
    idleSince: null,
  };

  function selectWorker(worker: Record<string, unknown>) {
    mocks.selection = {
      workers: [worker],
      focusedWorker: worker,
      selectedWorkerRecord: worker,
      selectedWorkerId: worker.workerId,
      workerSessionId: worker.sessionId,
    };
  }

  beforeEach(() => {
    mocks.sidebarWindow = true;
    mocks.sessionViewProps = null;
    mocks.remotePaneProps = null;
  });

  afterEach(() => {
    cleanup();
    mocks.sidebarWindow = false;
    mocks.selection = {};
    mocks.sessionViewProps = null;
    mocks.remotePaneProps = null;
  });

  it('shows a main-window entry instead of mounting the Worker conversation', () => {
    selectWorker(localWorker);
    const onViewWorkerInMainWindow = vi.fn();
    const view = render(
      <OrcaWorkerPanel
        leadSessionId="lead-1"
        deviceId={null}
        viewVisible
        onViewWorkerInMainWindow={onViewWorkerInMainWindow}
      />,
    );

    expect(mocks.sessionViewProps).toBeNull();
    expect(mocks.remotePaneProps).toBeNull();
    expect(view.getByText('orca.split.workerHiddenInSeparateWindow')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'orca.split.viewWorkerInMainWindow' }));
    expect(onViewWorkerInMainWindow).toHaveBeenCalledWith('worker-s1');
    // 对话没显示出来，不能当作用户在看：不自动确认「已完成」，也不清提醒。
    expect(mocks.selectionInput).toMatchObject({ viewVisible: false });
    expect(mocks.toolbarProps.clearAttentionWhenVisible).toBe(false);
  });

  it('does not mount the remote Worker pane either', () => {
    selectWorker({
      ...localWorker,
      executionDevice: {
        deviceId: 'mac-mini',
        remoteSessionId: 'remote-1',
        deviceName: 'Mac mini',
        reachable: true,
      },
    });
    const view = render(
      <OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible onViewWorkerInMainWindow={vi.fn()} />,
    );

    expect(mocks.remotePaneProps).toBeNull();
    expect(mocks.sessionViewProps).toBeNull();
    expect(view.getByText('orca.split.workerHiddenInSeparateWindow')).toBeTruthy();
  });

  it('keeps the waiting placeholder when no Worker is selected', () => {
    const view = render(
      <OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible onViewWorkerInMainWindow={vi.fn()} />,
    );

    expect(view.getByText('orca.split.waitingForWorker')).toBeTruthy();
    expect(view.queryByText('orca.split.workerHiddenInSeparateWindow')).toBeNull();
  });

  it('still embeds the Worker conversation in the main window', () => {
    mocks.sidebarWindow = false;
    selectWorker(localWorker);
    const view = render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);

    expect(mocks.sessionViewProps).toMatchObject({ sessionIdProp: 'worker-s1' });
    expect(view.queryByText('orca.split.workerHiddenInSeparateWindow')).toBeNull();
    expect(mocks.selectionInput).toMatchObject({ viewVisible: true });
    expect(mocks.toolbarProps.clearAttentionWhenVisible).toBe(true);
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
    mocks.windowVisible = true;
    mocks.watchAttention.mockClear();
    mocks.refreshProjection.mockClear();
    mocks.refreshSettings.mockClear();
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

  // Detached tabs own their watcher even while hidden. Only an actually
  // visible collaboration view may refresh its projection. The detached window
  // shows a placeholder instead of the Worker conversation, so even a visible
  // detached tab must not clear attention.
  // Hook tests alone cannot catch dropping these caller-side lifecycle inputs.
  it('keeps detached attention watching while hidden and refreshes only on visibility', () => {
    mocks.sidebarWindow = true;
    mocks.sessions = [{ id: 'lead-1', orcaRole: 'lead' }];
    mocks.windowVisible = false;
    const view = render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.watchAttention).toHaveBeenLastCalledWith(['lead-1'], undefined);
    expect(mocks.toolbarProps.clearAttentionWhenVisible).toBe(false);
    expect(mocks.refreshProjection).not.toHaveBeenCalled();
    expect(mocks.refreshSettings).not.toHaveBeenCalled();

    mocks.windowVisible = true;
    view.rerender(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.watchAttention).toHaveBeenLastCalledWith(['lead-1'], 'lead-1');
    expect(mocks.toolbarProps.clearAttentionWhenVisible).toBe(false);
    expect(mocks.refreshProjection).toHaveBeenCalledWith('lead-1');
    expect(mocks.refreshSettings).toHaveBeenCalledWith('lead-1');

    view.rerender(<OrcaWorkersTabBody ctx={ctx} state={{}} active shellVisible={false} />);
    expect(mocks.watchAttention).toHaveBeenLastCalledWith(['lead-1'], undefined);
    expect(mocks.toolbarProps.clearAttentionWhenVisible).toBe(false);
  });

  it.each([false, true])('keeps execution devices available with a remote Agent (detached: %s)', async (detached) => {
    mocks.sidebarWindow = detached;
    mocks.sessions = [
      { id: 'other-lead', agentDeviceId: null, orcaRole: 'lead' },
      { id: 'lead-1', agentDeviceId: 'agent-pc', orcaRole: 'lead' },
    ];
    const { rerender } = render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
    expect(mocks.createProps.onCreate).toBeTypeOf('function');
    await act(async () => (mocks.toolbarProps.onOpenCreate as () => void)());
    expect(mocks.setCreateOpen).toHaveBeenCalledWith(true);

    mocks.sessions = [{ id: 'lead-1', agentDeviceId: null, orcaRole: 'lead' }];
    rerender(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
  });

  it('keeps execution devices independent of pending Lead Agent metadata', () => {
    mocks.sessionsLoading = true;
    const { rerender } = render(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
    expect(mocks.workerAgentInput?.controlledDeviceId).toBeUndefined();

    mocks.sessionsLoading = false;
    mocks.sessions = [{ id: 'lead-1', orcaRole: 'lead' }];
    rerender(<OrcaWorkersTabBody ctx={ctx} state={{}} active />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
    expect(mocks.workerAgentInput?.controlledDeviceId).toBeNull();
  });
});
