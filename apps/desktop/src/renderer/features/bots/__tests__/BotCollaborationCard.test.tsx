// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { BotSessionTaskCard, BotSessionTaskMessageTrace } from '../BotCollaborationCard';
import { SessionQuickSendProvider, useSessionQuickSend } from '@/components/chat/SessionQuickSendContext';
import { useChatSessionFile } from '@/components/chat/ChatSessionFileContext';
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
  resolved: true,
  stale: false,
  cancel: vi.fn(),
  send: vi.fn(),
  trace: vi.fn(),
  toast: vi.fn(),
  prs: [] as any[],
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../botDelegationLive', () => ({
  useBotDelegation: () => ({ row: mocks.row, resolved: mocks.resolved, stale: mocks.stale }),
  isActiveDelegationStatus: (status: string) => ['queued', 'running', 'waiting'].includes(status),
}));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/lib/makerTransport', () => ({
  makerApiForSticky: () => ({ cancelBotDelegation: mocks.cancel }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.toast } }));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useElementVisible: () => ({ ref: () => {}, visible: false }) }));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ registerPrConsumer: () => () => {}, invalidateRemotePrRefs: () => {} }),
  usePrRefsForSession: () => mocks.prs,
  usePrStatuses: () => ({ statuses: new Map(), successfulStatuses: new Map(), refreshError: false }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, workingDir }: any) => {
    const sender = useSessionQuickSend();
    const { localConfirmed } = useChatSessionFile();
    return <div data-testid="markdown" data-working-dir={workingDir} data-local-confirmed={String(localConfirmed)}>{content}
      {content === 'inline-send-preview' ? <button disabled={!sender} onClick={() => void sender?.send('child reply')}>Preview send</button> : null}
    </div>;
  },
}));
// The surrounding chat is a confirmed-local task; the card's nested provider decides the child's.
vi.mock('@/components/chat/ChatSessionFileContext', async () => {
  const { createContext, createElement, useContext } = await import('react');
  type FileContextValue = { origin: { kind: string }; sessionId?: string; workingDir: string; localConfirmed?: boolean };
  const FileContext = createContext<FileContextValue>({ origin: { kind: 'local' }, sessionId: 'parent', workingDir: '/parent', localConfirmed: true });
  return {
    useChatSessionFile: () => useContext(FileContext),
    ChatSessionFileProvider: ({ value, children }: { value: FileContextValue; children: ReactNode }) =>
      createElement(FileContext.Provider, { value }, children),
  };
});
vi.mock('@/lib/sessionService', () => ({ get: mocks.get }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: mocks.route }));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { subscribe: () => () => {}, subscribePatches: () => () => {} },
}));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivity: () => mocks.activity }));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({
  useRemoteSessionActivity: () => null,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribeAll: () => () => {},
    getRunningSnapshot: () => mocks.running,
    sendMessage: mocks.send,
  },
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
  mocks.resolved = true;
  mocks.stale = false;
  mocks.prs = [];
  mocks.cancel.mockResolvedValue({ ok: true, delegationId: 'd', childSessionId: 'child' });
  mocks.send.mockResolvedValue(true);
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
    workingDir: '/child',
    model: 'gpt-x',
    effort: 'high',
    permissionMode: 'default',
  });
  mocks.route.mockResolvedValue('/cc-agent/child');
  mocks.trace.mockResolvedValue({ ok: true, delegationId: 'd' });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: { invoke: mocks.remoteGet },
      maker: { traceBotDelegationNote: mocks.trace },
      openExternal: vi.fn(async () => ({ success: true })),
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
const cardState = () => document.querySelector('[data-bot-task-card]')?.getAttribute('data-bot-task-card');
const at = Date.parse('2026-10-15T08:00:00Z');
const delegation = (fields: Record<string, unknown>) => ({
  id: 'd', childSessionId: 'child', title: 'Row title', status: 'running', pendingInteraction: null,
  resultSummary: null, artifacts: [], lastError: null, createdAt: at, acceptedAt: at, completedAt: null,
  updatedAt: at, ...fields,
});
it('uses the actual session title and harness, and opens that same session without mutating it', async () => {
  render(<BotSessionTaskCard data={data()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Current title' }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/child'));
  expect(mocks.route).toHaveBeenCalledWith('child', expect.objectContaining({ id: 'child' }));
  expect(screen.getByText('bots.collab.backgroundTask · Codex')).toBeTruthy();
});
it('takes actual runtime state instead of treating an ended delegation as completed work', async () => {
  mocks.row = { childSessionId: 'child', status: 'done' };
  mocks.running.set('child', { isRunning: true });
  render(<BotSessionTaskCard data={data()} />);
  await screen.findByRole('button', { name: 'Current title' });
  await waitFor(() => expect(cardState()).toBe('running'));
  expect(screen.queryByText('bots.collab.status.done')).toBeNull();
});
it('shows the current action and elapsed time while running, and stops through the delegation', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(at + 65_000);
  try {
    mocks.row = delegation({ status: 'running' });
    mocks.activity = { phase: 'running', compactDetail: 'Running pnpm test', currentTurnActive: true };
    render(<BotSessionTaskCard data={data()} sessionId="parent" />);
    expect(cardState()).toBe('running');
    expect(screen.getByText('Running pnpm test')).toBeTruthy();
    expect(screen.getByText(/bots\.collab\.elapsed/).textContent).toContain('bots.collab.duration.minutes');
    expect(screen.getByRole('button', { name: /bots\.collab\.watchWork/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.stop/ }));
    await act(async () => {});
    expect(mocks.cancel).toHaveBeenCalledWith('parent', 'd');
  } finally {
    vi.useRealTimers();
  }
});
it('reports a failed stop without pretending the task stopped', async () => {
  mocks.row = delegation({ status: 'running' });
  mocks.cancel.mockResolvedValue({ ok: false, errorCode: 'X', message: 'Could not stop' });
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.stop/ }));
  expect((await screen.findByRole('alert')).textContent).toBe('Could not stop');
  expect(cardState()).toBe('running');
});
it('adds a note to a local running task as the owner, with the task runtime settings', async () => {
  mocks.row = delegation({ status: 'running' });
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.addNote/ }));
  const input = screen.getByRole('textbox', { name: 'bots.collab.addNote' });
  fireEvent.change(input, { target: { value: '  Cover offline reconnect  ' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(
    'child', 'Cover offline reconnect', 'gpt-x', 'high', 'default', '/child',
  ));
  // The Bot's chat keeps the「已告诉后台任务」trace of what the owner told the task.
  await waitFor(() => expect(mocks.trace).toHaveBeenCalledWith('parent', 'd', 'Cover offline reconnect'));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(mocks.toast).toHaveBeenCalledWith('bots.collab.addNoteSent');
});
it.each([4000, 4001])('checks the trace length limit before delivering a %i-character note', async length => {
  mocks.row = delegation({ status: 'running' });
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.addNote/ }));
  const input = screen.getByRole('textbox', { name: 'bots.collab.addNote' }) as HTMLInputElement;
  const text = '字'.repeat(length);
  // Programmatic change bypasses the native input limit: submit must also validate before sending.
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
  if (length === 4000) {
    await waitFor(() => expect(mocks.trace).toHaveBeenCalledWith('parent', 'd', text));
    expect(mocks.send).toHaveBeenCalledWith('child', text, 'gpt-x', 'high', 'default', '/child');
    expect(mocks.toast).toHaveBeenCalledWith('bots.collab.addNoteSent');
  } else {
    expect((await screen.findByRole('alert')).textContent).toBe('bots.collab.actionFailed');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.trace).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(input.value).toBe(text);
  }
  expect(input.maxLength).toBe(4000);
});
it('still reports a delivered note when only its chat trace fails, and leaves no trace for an undelivered one', async () => {
  mocks.row = delegation({ status: 'running' });
  mocks.trace.mockRejectedValueOnce(new Error('offline'));
  const { unmount } = render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.addNote/ }));
  const input = screen.getByRole('textbox', { name: 'bots.collab.addNote' });
  fireEvent.change(input, { target: { value: 'Keep the risk list' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('bots.collab.addNoteSent'));
  expect(screen.queryByRole('alert')).toBeNull();
  unmount();

  mocks.send.mockResolvedValueOnce(false);
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.addNote/ }));
  const again = screen.getByRole('textbox', { name: 'bots.collab.addNote' });
  fireEvent.change(again, { target: { value: 'Never delivered' } });
  fireEvent.submit(again.closest('form')!);
  expect((await screen.findByRole('alert')).textContent).toBe('bots.collab.actionFailed');
  expect(mocks.trace).toHaveBeenCalledTimes(1);
});
it('shows what the task waits for and lets the user look at it', async () => {
  mocks.row = delegation({ status: 'waiting', pendingInteraction: { summary: 'Allow npm install', kind: 'permission' } });
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  expect(cardState()).toBe('waiting');
  expect(screen.getByText(/bots\.collab\.awaitingConfirm:.*Allow npm install/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.lookAt/ }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/child'));
  expect(screen.getByRole('button', { name: /bots\.collab\.stop/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /bots\.collab\.addNote/ })).toBeNull();
});
it('shows the result summary when completed and expands the result in place', async () => {
  mocks.row = delegation({ status: 'completed', completedAt: at + 14 * 60_000, resultSummary: 'Retry capped at 3.',
    artifacts: [{ path: 'a.ts', absolutePath: '/child/a.ts', status: 'modified' }] });
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  expect(cardState()).toBe('completed');
  // The child session (title, working directory) has loaded.
  await screen.findByRole('button', { name: 'Current title' });
  expect(screen.getByText('Retry capped at 3.')).toBeTruthy();
  expect(screen.getByText(/bots\.collab\.tookTime/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /bots\.collab\.stop/ })).toBeNull();
  const toggle = screen.getByRole('button', { name: /bots\.collab\.expandResult/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(screen.getAllByTestId('markdown').map((node) => node.textContent))
    .toEqual(['Retry capped at 3.', '[a.ts](</child/a.ts>)']);
  // Relative links in a live result resolve against the background task's own directory, not the chat's.
  expect(screen.getAllByTestId('markdown').map((node) => node.getAttribute('data-working-dir'))).toEqual(['/child', '/child']);
  expect(screen.getByRole('button', { name: /bots\.collab\.collapseResult/ }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: /bots\.collab\.artifactCount/ })).toBeTruthy();
});
it('shows the failure reason in one line', () => {
  mocks.row = delegation({ status: 'timed-out', lastError: 'TIMEOUT: upstream did not finish' });
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  expect(cardState()).toBe('failed');
  expect(screen.getByText('upstream did not finish')).toBeTruthy();
  expect(screen.getByText('bots.collab.status.timed-out')).toBeTruthy();
  expect(screen.getByRole('button', { name: /bots\.collab\.expandDetails/ })).toBeTruthy();
});
it('keeps the stale warning when the task row cannot refresh', () => {
  mocks.row = delegation({ status: 'running' });
  mocks.stale = true;
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  expect(screen.getByText('bots.collab.stale')).toBeTruthy();
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
  expect(screen.getByText('bots.collab.backgroundTask')).toBeTruthy();
});
it('pins remote child reads and navigation to the parent device', async () => {
  mocks.origin.mockImplementation((id: string) => (id === 'parent' ? 'mac-a' : undefined));
  mocks.row = delegation({ status: 'running' });
  render(<BotSessionTaskCard data={data()} />);
  await screen.findByRole('button', { name: 'Remote title' });
  expect(mocks.remoteGet).toHaveBeenCalledWith('mac-a', 'local-db:sessions:get', ['child']);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(screen.getByText('bots.collab.backgroundTask · Pi')).toBeTruthy();
  // Sending as the owner is local-only; a remote task keeps open/stop.
  expect(screen.queryByRole('button', { name: /bots\.collab\.addNote/ })).toBeNull();
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
it('keeps legacy interjections as quiet traces', () => {
  render(<BotSessionTaskMessageTrace data={data({ ...card, role: 'interjection' })} />);
  expect(screen.getByText('bots.collab.messageSent')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows what was told to the task when the trace carries a preview', () => {
  render(<BotSessionTaskMessageTrace data={data({ ...card, role: 'interjection', interjectionPreview: 'Cover offline reconnect' })} />);
  expect(screen.getByText('bots.collab.messageSentWithText:{"text":"Cover offline reconnect"}')).toBeTruthy();
  expect(screen.queryByText('bots.collab.messageSent')).toBeNull();
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
  expect(screen.getByText('bots.collab.backgroundTask · Codex')).toBeTruthy();
});

// Tier 1, PR #6871: existing result tests lacked a writable parent context.
// A child result's Markdown consumer must not acquire the parent's send capability.
// The expanded result belongs to the child task. A confirmed-local chat must not let a child that
// runs on another device, over SSH or with a conflicting origin search its directory on this machine.
it.each([
  ['a local child', undefined, {}, 'true'],
  ['a child on the parent\'s remote device', 'mac-a', {}, 'false'],
  ['a child with a conflicting origin', 'conflict', {}, 'false'],
  ['an SSH child', undefined, { remoteHostId: 'host-1' }, 'false'],
] as const)('confirms local ownership for %s only when the child runs here', async (_label, parentDevice, childFields, expected) => {
  if (parentDevice === 'conflict') mocks.origin.mockImplementation((id: string) => (id === 'child' ? 'mac-b' : undefined));
  else mocks.origin.mockImplementation((id: string) => (id === 'parent' ? parentDevice : undefined));
  mocks.get.mockResolvedValue({ id: 'child', title: 'Current title', status: 'active', workingDir: '/child', ...childFields });
  mocks.row = delegation({ status: 'completed', resultSummary: 'See renders/out/clip.mp4' });
  render(<BotSessionTaskCard data={data()} sessionId="parent" />);
  if (parentDevice !== 'conflict') await screen.findByRole('button', { name: parentDevice ? 'Remote title' : 'Current title' });
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.expandResult/ }));
  expect(screen.getByTestId('markdown').getAttribute('data-local-confirmed')).toBe(expected);
});

it('keeps expanded child result controls read-only inside a writable parent', async () => {
  const send = vi.fn().mockResolvedValue(true);
  mocks.row = delegation({ status: 'completed', resultSummary: 'inline-send-preview' });
  render(<SessionQuickSendProvider value={{ send }}><BotSessionTaskCard data={data()} sessionId="parent" /></SessionQuickSendProvider>);
  await screen.findByRole('button', { name: 'Current title' });
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.expandResult/ }));
  const submit = screen.getByRole('button', { name: 'Preview send' });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(submit);
  expect(send).not.toHaveBeenCalled();
});
