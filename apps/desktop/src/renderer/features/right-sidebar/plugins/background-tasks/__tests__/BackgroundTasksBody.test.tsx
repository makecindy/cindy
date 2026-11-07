// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabKindHostContext } from '../../../types';
import type { SessionTaskItem } from '../listSessionTasks';
import { BackgroundTasksBody } from '../BackgroundTasksBody';

const mocks = vi.hoisted(() => ({
  clearAttention: vi.fn(),
  attentionKind: undefined as 'done' | 'error' | 'awaiting' | undefined,
  remotePhase: 'completed' as 'completed' | 'error' | 'needs-interaction',
  reconcile: vi.fn(async () => true),
  focusTask: vi.fn(),
  sidebarWindow: false,
  items: [] as SessionTaskItem[],
  snapshot: { messages: [], taskUpdates: new Map(), isStreaming: false },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sessionAttentionStore', () => ({
  clearSystemSessionAttention: mocks.clearAttention,
  getSessionAttentionKind: () => mocks.attentionKind,
}));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({
  getRemoteSessionActivity: () => ({ phase: mocks.remotePhase }),
}));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => mocks.sidebarWindow }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => 'remote-device',
  useRemoteDevices: () => [],
}));
vi.mock('@/lib/makerChatStore', () => ({
  EMPTY_TASK_UPDATES: new Map(),
  makerChatStore: {
    subscribe: () => () => {},
    getSnapshot: () => mocks.snapshot,
    enterView: () => () => {},
    ensureInitialMessages: vi.fn(),
    reconcileRemoteMessages: mocks.reconcile,
  },
}));
vi.mock('@/lib/makerTransport', () => ({
  isRemoteSessionSticky: () => true,
  listSessionBackgroundTasksFor: async () => ({ tasks: [] }),
  getWorkflowProgressFor: async () => null,
}));
vi.mock('../listSessionTasks', () => ({
  listSessionTasks: () => ({
    running: mocks.items.filter((item) => item.status === 'running'),
    completed: mocks.items.filter((item) => item.status !== 'running'),
  }),
}));
vi.mock('../chatTaskFocusIntent', () => ({ requestChatTaskFocus: mocks.focusTask }));
vi.mock('../WorkflowProgressTree', () => ({ WorkflowProgressTree: () => null }));

const ctx: TabKindHostContext = {
  tabId: 'background-tasks',
  sessionId: 'remote-session',
  workdir: '',
  remoteHostId: null,
  patchState: vi.fn(),
  onVisibilityChange: vi.fn(),
  setCloseInterceptor: () => () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sidebarWindow = false;
  mocks.attentionKind = 'done';
  mocks.remotePhase = 'completed';
  mocks.items = [{
    key: 'task',
    kind: 'workflow',
    title: 'Completed task',
    status: 'completed',
    provider: 'claude-code',
    toolCallClientId: 'tool-call',
    orderIndex: 0,
  }];
});
afterEach(cleanup);

describe('background task row attention', () => {
  it('requests a protected navigation receipt when opening workflow details', () => {
    render(<BackgroundTasksBody state={{}} ctx={ctx} />);
    expect(mocks.clearAttention).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Completed task/ }));

    expect(mocks.clearAttention).toHaveBeenCalledExactlyOnceWith('remote-session', 'passive');
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith('remote-session', { force: true });
    expect(screen.getByRole('button', { name: 'rightSidebar.backgroundTasks.back' })).toBeTruthy();
    expect(mocks.focusTask).not.toHaveBeenCalled();
  });

  it('acknowledges the session and preserves chat task focus', () => {
    mocks.items[0].kind = 'agent';
    render(<BackgroundTasksBody state={{}} ctx={ctx} />);

    fireEvent.click(screen.getByRole('button', { name: /Completed task/ }));

    expect(mocks.clearAttention).toHaveBeenCalledExactlyOnceWith('remote-session', 'passive');
    expect(mocks.focusTask).toHaveBeenCalledExactlyOnceWith('remote-session', 'tool-call');
  });

  it.each(['workflow', 'agent'] as const)('opens a running %s without acknowledging another completed task', (kind) => {
    mocks.items.push({ ...mocks.items[0], key: 'running-task', title: 'Running task', kind, status: 'running' });
    render(<BackgroundTasksBody state={{}} ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: /Running task/ }));
    expect(mocks.clearAttention).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it.each(['error', 'awaiting'] as const)('retains current %s attention when opening an older completed task', (kind) => {
    mocks.attentionKind = kind;
    render(<BackgroundTasksBody state={{}} ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: /Completed task/ }));
    expect(mocks.clearAttention).not.toHaveBeenCalled();
  });

  it.each(['error', 'needs-interaction'] as const)('retains remote %s attention missing from the local map', (phase) => {
    mocks.attentionKind = undefined;
    mocks.remotePhase = phase;
    render(<BackgroundTasksBody state={{}} ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: /Completed task/ }));
    expect(mocks.clearAttention).not.toHaveBeenCalled();
  });

  it('does not acknowledge non-actionable chat rows in a detached sidebar', () => {
    mocks.sidebarWindow = true;
    mocks.items[0].kind = 'agent';
    render(<BackgroundTasksBody state={{}} ctx={ctx} />);

    fireEvent.click(screen.getByRole('button', { name: /Completed task/ }));

    expect(mocks.clearAttention).not.toHaveBeenCalled();
    expect(mocks.focusTask).not.toHaveBeenCalled();
  });
});
