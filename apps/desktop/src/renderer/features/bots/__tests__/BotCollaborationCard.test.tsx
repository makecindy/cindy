// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotSessionTaskCard, BotSessionTaskMessageTrace } from '../BotCollaborationCard';
import type { BotCollaborationMeta } from '../../../../shared/botCollaboration';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  remoteGet: vi.fn(),
  remoteRows: [] as any[],
  remoteChanged: null as any,
  remoteReadCurrent: true,
  navigate: vi.fn(),
  route: vi.fn(),
  row: null as any,
  origin: vi.fn(),
  pin: vi.fn(),
  running: new Map(),
  activity: null as any,
  attached: false,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../botDelegationLive', () => ({ useBotDelegation: () => ({ row: mocks.row }) }));
vi.mock('@/lib/sessionService', () => ({ get: mocks.get }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: mocks.route }));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { subscribe: () => () => {}, subscribePatches: () => () => {} },
}));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: any) => children }));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivity: () => mocks.activity }));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({
  useRemoteSessionActivity: () => null,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => mocks.running },
}));
vi.mock('@/lib/sessionAttentionStore', () => ({ useSessionAttentionKind: () => undefined }));
vi.mock('@/features/cc-agent/hooks/useSessionDisplayRunningState', () => ({
  useSessionDisplayRunningState: (_: unknown, running: Set<string>) => ({
    displayRunningSessionIds: running,
  }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getSessionDeviceId: mocks.origin,
    pinSessionOrigin: mocks.pin,
    getDeviceName: () => 'Remote Mac',
    getDeviceSessions: () => mocks.remoteRows,
    captureSessionRead: () =>
      Object.assign(() => mocks.remoteReadCurrent, { mergeActivity: (row: any) => row }),
    subscribe: (cb: any) => {
      mocks.remoteChanged = cb;
      return () => {};
    },
    mergeDeviceSessions: (device: string, name: string, rows: any[]) => {
      mocks.remoteRows = rows.map((row) => ({
        ...row,
        deviceLinkDeviceId: device,
        deviceLinkDeviceName: name,
      }));
      mocks.remoteChanged?.();
    },
  },
}));
vi.mock('@/features/cc-agent/sidebar/SessionStatusIcon', () => ({
  SessionStatusIcon: ({ session, isRunning, isAttached }: any) => (
    <i
      data-testid="original-harness"
      data-kind={session.agentKind}
      data-running={isRunning}
      data-attached={isAttached}
    />
  ),
}));
const card: BotCollaborationMeta = {
  v: 1,
  role: 'delegation-request',
  delegationId: 'd',
  fromBotId: 'b',
  fromBotName: 'Cindy',
  toBotId: null,
  toBotName: 'Cindy',
  parentSessionId: 'parent',
  childSessionId: 'child',
  objective: 'Original request',
};
const data = (value = card) => ({ ...value });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.row = null;
  mocks.remoteRows = [];
  mocks.remoteReadCurrent = true;
  mocks.remoteGet.mockResolvedValue({
    id: 'child',
    title: 'Remote title',
    agentKind: 'pi',
    status: 'active',
  });
  mocks.activity = null;
  mocks.running = new Map();
  mocks.origin.mockReturnValue(undefined);
  mocks.get.mockResolvedValue({
    id: 'child',
    title: 'Current title',
    agentKind: 'codex',
    status: 'active',
  });
  mocks.route.mockResolvedValue('/cc-agent/child');
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: { invoke: mocks.remoteGet },
      binding: {
        resolveSession: vi.fn(async () => ({ attached: false })),
        onChanged: () => () => {},
      },
    },
  });
});
afterEach(cleanup);
it('only renders valid requesting-side task references', () => {
  const { container, rerender } = render(<BotSessionTaskCard />);
  expect(container.firstChild).toBeNull();
  rerender(<BotSessionTaskCard data={data({ ...card, role: 'guest-request' })} />);
  expect(container.firstChild).toBeNull();
});
it('uses the actual session title and native harness, and opens that same session without mutating it', async () => {
  render(<BotSessionTaskCard data={data()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Current title' }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/child'));
  expect(mocks.route).toHaveBeenCalledWith('child', expect.objectContaining({ id: 'child' }));
  expect(screen.getByTestId('original-harness').getAttribute('data-kind')).toBe('codex');
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
it('takes actual runtime state instead of treating an ended delegation as completed work', async () => {
  mocks.row = { childSessionId: 'child', status: 'done' };
  mocks.running.set('child', { isRunning: true });
  render(<BotSessionTaskCard data={data()} />);
  await screen.findByRole('button', { name: 'Current title' });
  expect(screen.getByTestId('original-harness').getAttribute('data-running')).toBe('true');
  expect(screen.queryByText('bots.collab.status.done')).toBeNull();
});
it('preserves archived identity when opening; viewing never calls unarchive', async () => {
  mocks.get.mockResolvedValue({
    id: 'child',
    title: 'Archived title',
    agentKind: 'pi',
    status: 'archived',
  });
  render(<BotSessionTaskCard data={data()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Archived title' }));
  await waitFor(() =>
    expect(mocks.route).toHaveBeenCalledWith(
      'child',
      expect.objectContaining({ status: 'archived' }),
    ),
  );
});
it('keeps a readable fallback when metadata is unavailable without inventing a harness', async () => {
  mocks.get.mockRejectedValue(new Error('offline'));
  render(<BotSessionTaskCard data={data()} />);
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  expect(
    (screen.getByRole('button', { name: 'Original request' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(screen.queryByTestId('original-harness')).toBeNull();
});
it('pins remote child reads and navigation to the parent device', async () => {
  mocks.origin.mockImplementation((id: string) => (id === 'parent' ? 'mac-a' : undefined));
  render(<BotSessionTaskCard data={data()} />);
  await screen.findByRole('button', { name: 'Remote title' });
  expect(mocks.remoteGet).toHaveBeenCalledWith('mac-a', 'local-db:sessions:get', ['child']);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(screen.getByTestId('original-harness').getAttribute('data-kind')).toBe('pi');
  act(() => {
    mocks.remoteRows = [{ ...mocks.remoteRows[0], title: 'Remote renamed' }];
    mocks.remoteChanged();
  });
  expect(screen.getByRole('button', { name: 'Remote renamed' })).toBeTruthy();
  expect(mocks.pin).toHaveBeenCalledWith('mac-a', 'child');
});
it('does not read a conflicting child origin', () => {
  mocks.origin.mockImplementation((id: string) => (id === 'parent' ? 'mac-a' : 'mac-b'));
  render(<BotSessionTaskCard data={data()} />);
  expect(mocks.get).not.toHaveBeenCalled();
});
it('keeps interjections as quiet traces', () => {
  render(<BotSessionTaskMessageTrace data={data({ ...card, role: 'interjection' })} />);
  expect(screen.getByText('bots.collab.messageSent')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

it('keeps a newer remote mirror instead of publishing a stale GET', async () => {
  let resolve!: (row: any) => void;
  mocks.origin.mockImplementation((id: string) => (id === 'parent' ? 'mac-a' : undefined));
  mocks.remoteGet.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<BotSessionTaskCard data={data()} />);
  act(() => {
    mocks.remoteReadCurrent = false;
    mocks.remoteRows = [
      { id: 'child', title: 'New remote title', agentKind: 'codex', deviceLinkDeviceId: 'mac-a' },
    ];
    mocks.remoteChanged();
  });
  await act(async () => resolve({ id: 'child', title: 'Stale title', agentKind: 'pi' }));
  expect(screen.getByRole('button', { name: 'New remote title' })).toBeTruthy();
  expect(screen.getByTestId('original-harness').getAttribute('data-kind')).toBe('codex');
});
