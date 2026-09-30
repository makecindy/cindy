import { sharedTaskHostPeer } from '@cindy/device-link';
// @vitest-environment jsdom
import { render, screen, fireEvent, createEvent, cleanup, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SharedTasksSection } from '../SharedTasksSection';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
const state = vi.hoisted(() => ({ sessions: [] as Session[], account: vi.fn(), openLink: vi.fn(), pin: vi.fn(), row: vi.fn(), mode: 'list' as 'list' | 'text' }));
vi.mock('@/hooks/useSidebarCardMode', () => ({ useSidebarMainViewMode: () => ({ mode: state.mode }) }));
vi.mock('@/features/cc-agent/sidebar/SessionCard', () => ({
  SessionCard: (props: { session: Session; onClick(): void; sharedTaskRole?: 'owned' | 'joined' }) => {
    state.row(props);
    return <button data-testid="ordinary-list-row" onClick={props.onClick}>{props.session.title}<span>{props.session.preview}</span></button>;
  },
}));
vi.mock('@/features/cc-agent/sidebar/SessionItem', () => ({
  SessionItem: (props: { session: Session; onClick(): void; sharedTaskRole?: 'owned' | 'joined' }) => {
    state.row(props);
    return <button data-testid="ordinary-text-row" onClick={props.onClick}>{props.session.title}</button>;
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { count?: number }) => key + (args?.count === undefined ? '' : ':' + args.count) }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'guest', isAuthenticated: true }) }));
vi.mock('../JoinSharedTaskDialog', () => ({ JoinSharedTaskDialog: () => null }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => state.sessions, isRemoteDeviceMarkedDisconnected: () => false,
  remoteProjectsStore: { pinSessionOrigin: state.pin },
}));
const guestTask = { id: 'joined-1', title: 'Joined task', deviceLinkDeviceId: sharedTaskHostPeer('share-1', 'desktop') } as Session;
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('guest');
  state.mode = 'list';
  state.sessions = [guestTask, { id: 'own-device-task', title: 'Own device task', deviceLinkDeviceId: 'my-computer' } as Session];
  state.account.mockResolvedValue([]);
  Object.assign(window, { electronAPI: { sharedTask: { account: state.account }, deviceLink: { openLink: state.openLink } } });
});
afterEach(cleanup);
it('uses the ordinary list row with the joined session preview and live status props', async () => {
  const session = { ...guestTask, preview: 'Latest shared message', agentKind: 'codex' } as Session;
  state.sessions = [session];
  render(<SharedTasksSection onSelect={vi.fn()} runningSessionIds={new Set([session.id])} attachedSessionIds={new Set([session.id])} notifications={new Set([session.id])} />);
  await act(async () => {});
  expect(screen.getByTestId('ordinary-list-row').textContent).toContain(session.preview);
  expect(state.row).toHaveBeenLastCalledWith(expect.objectContaining({
    session, navigationOnly: true, sharedTaskRole: 'joined', variant: 'list', isRunning: true, isAttached: true, hasAttentionNotification: true,
  }));
  expect(screen.getByRole('button', { name: 'sharedTask.title' })).toBeTruthy();
});
it('uses the local session title and preview instead of device labels and follows the ordinary text mode', async () => {
  state.sessions = [];
  const session = { id: 'host-task', title: 'Current title', preview: 'Latest local message' } as Session;
  state.account.mockResolvedValue([{ sharedTaskId: 'owned-1', sessionId: session.id, local: true, title: 'Old title' }]);
  const onAction = vi.fn();
  const onRename = vi.fn();
  const onTogglePin = vi.fn();
  const { rerender } = render(<SharedTasksSection localSessions={[session]} onAction={onAction} onRename={onRename} onTogglePin={onTogglePin} onSelect={vi.fn()} />);
  expect(await screen.findByTestId('ordinary-list-row')).toBeTruthy();
  expect(screen.getByText(session.preview!)).toBeTruthy();
  expect(screen.queryByText('sharedTask.thisDevice')).toBeNull();
  expect(screen.queryByText('Old title')).toBeNull();
  state.mode = 'text';
  rerender(<SharedTasksSection localSessions={[session]} onAction={onAction} onRename={onRename} onTogglePin={onTogglePin} onSelect={vi.fn()} />);
  expect(screen.getByTestId('ordinary-text-row')).toBeTruthy();
  expect(screen.queryByTestId('ordinary-list-row')).toBeNull();
  expect(state.row).toHaveBeenLastCalledWith(expect.objectContaining({ navigationOnly: false, sharedTaskRole: 'owned' }));
  state.row.mock.lastCall?.[0].onAction(session.id, 'archive');
  expect(onAction).toHaveBeenCalledWith(session.id, 'archive', 'owned-1');
  state.row.mock.lastCall?.[0].onRename(session.id, 'Renamed');
  state.row.mock.lastCall?.[0].onTogglePin(session.id, false);
  expect(onRename).toHaveBeenCalledWith(session.id, 'Renamed');
  expect(onTogglePin).toHaveBeenCalledWith(session.id, false);
});
it('keeps undiscovered host tasks navigable and only hydrates from the matching host mirror', async () => {
  const item = { sharedTaskId: 'owned-1', sessionId: 'host-task', hostDeviceId: 'other-pc', local: false, title: 'Hosted task' };
  state.account.mockResolvedValue([item]);
  state.sessions = [{ id: item.sessionId, title: 'Wrong host', preview: 'Wrong preview', deviceLinkDeviceId: 'unrelated-pc' } as Session];
  state.openLink.mockResolvedValue(undefined);
  const select = vi.fn();
  const { rerender } = render(<SharedTasksSection onSelect={select} />);
  const fallback = await screen.findByRole('button', { name: item.title + ', sharedTask.roleHost' });
  expect(screen.queryByTestId('ordinary-list-row')).toBeNull();
  expect(screen.queryByText('sharedTask.otherDevice')).toBeNull();
  expect(screen.queryByText('Wrong preview')).toBeNull();
  fireEvent.click(fallback);
  await waitFor(() => expect(select).toHaveBeenCalledWith(item.sessionId));
  expect(state.openLink).toHaveBeenCalledWith(item.hostDeviceId);
  state.sessions = [{ id: item.sessionId, title: item.title, preview: 'Host preview', deviceLinkDeviceId: item.hostDeviceId } as Session];
  rerender(<SharedTasksSection onSelect={select} />);
  expect(screen.getByTestId('ordinary-list-row').textContent).toContain('Host preview');
  fireEvent.click(screen.getByTestId('ordinary-list-row'));
  await act(async () => {});
  expect(state.openLink).toHaveBeenCalledTimes(1);
});
it.each(['owned', 'joined'] as const)('suppresses context menus within the %s group without changing left-click actions or sidebar blank space', async (role) => {
  if (role === 'owned') {
    state.sessions = [];
    state.account.mockResolvedValue([{ sharedTaskId: 'owned-1', sessionId: 'host-task', local: true, title: 'Hosted task' }]);
  }
  const organize = vi.fn();
  const select = vi.fn();
  render(<div onContextMenu={organize}>
    <SharedTasksSection onSelect={select} />
    <div data-testid="sidebar-blank" />
  </div>);
  const heading = await screen.findByRole('button', { name: 'sharedTask.title' });
  const title = role === 'owned' ? 'Hosted task' : 'Joined task';
  for (const target of [heading, screen.getByText(title), screen.getByRole('region')]) {
    const event = createEvent.contextMenu(target);
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(organize).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(state.openLink).not.toHaveBeenCalled();
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(heading);
  expect(screen.queryByText(title)).toBeNull();
  fireEvent.click(heading);
  fireEvent.click(screen.getByText(title));
  expect(select).toHaveBeenCalledWith(role === 'owned' ? 'host-task' : 'joined-1');
  fireEvent.contextMenu(screen.getByTestId('sidebar-blank'));
  expect(organize).toHaveBeenCalledTimes(1);
});
it('shows both roles in one group and suppresses context menus without opening tasks', async () => {
  state.account.mockResolvedValue([{ sharedTaskId: 'owned-1', sessionId: 'host-task', local: true, title: 'Hosted task' }]);
  const organize = vi.fn();
  const select = vi.fn();
  render(<div onContextMenu={organize}><SharedTasksSection
    localSessions={[{ id: 'host-task', title: 'Hosted task' } as Session]}
    onSelect={select}
  /></div>);
  await screen.findByText('Hosted task');
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.getByText('Joined task')).toBeTruthy();
  for (const title of ['Hosted task', 'Joined task']) {
    const row = screen.getByText(title);
    const rowEvent = createEvent.contextMenu(row);
    fireEvent(row, rowEvent);
    expect(rowEvent.defaultPrevented).toBe(true);
  }
  expect(state.row).toHaveBeenCalledWith(expect.objectContaining({ sharedTaskRole: 'owned' }));
  expect(state.row).toHaveBeenCalledWith(expect.objectContaining({ sharedTaskRole: 'joined' }));
  expect(organize).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(state.openLink).not.toHaveBeenCalled();
});
it('shows only joined tasks independently of the machine filter and does not reopen the active task', async () => {
  const select = vi.fn();
  render(<SharedTasksSection activeSessionId="joined-1" onSelect={select} />);
  await act(async () => {});
  expect(screen.getByText('sharedTask.title')).toBeTruthy();
  expect(screen.queryByText('Own device task')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Joined task/ }));
  expect(select).not.toHaveBeenCalled();
  expect(state.openLink).not.toHaveBeenCalled();
});
it('navigates directly from a joined task without opening a new link', async () => {
  const select = vi.fn();
  render(<SharedTasksSection activeSessionId="another" onSelect={select} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /Joined task/ }));
  expect(select).toHaveBeenCalledWith('joined-1');
  expect(state.openLink).not.toHaveBeenCalled();
});
it('shows the owned group alone for a host, with local task navigation', async () => {
  state.sessions=[]; state.account.mockResolvedValue([{ sharedTaskId: 'owned-1', sessionId: 'host-task', local: true, title: 'Hosted task' }]);
  const select=vi.fn(); render(<SharedTasksSection onSelect={select} />);
  await screen.findByText('sharedTask.title');
  expect(screen.queryByRole('tablist')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Hosted task/ }));
  expect(select).toHaveBeenCalledWith('host-task');
  expect(state.openLink).not.toHaveBeenCalled();
});
it('mixes roles by the sidebar activity clock, then removes an owner row when sharing ends', async () => {
  state.account.mockResolvedValue([{ sharedTaskId: 'owned-1', sessionId: 'host-task', local: true, title: 'Hosted task' }]);
  const local = {
    id: 'host-task',
    title: 'Hosted task',
    userSendAt: '2026-09-22T01:00:00.000Z',
    updatedAt: '2026-09-22T04:00:00.000Z',
  } as Session;
  state.sessions = [{
    ...guestTask,
    userSendAt: '2026-09-22T02:00:00.000Z',
    updatedAt: '2026-09-22T03:00:00.000Z',
  } as Session];
  const { rerender } = render(<SharedTasksSection localSessions={[local]} onSelect={vi.fn()} />);
  await screen.findByText('Hosted task');
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.getByText('Hosted task')).toBeTruthy();
  expect(screen.getByText('Joined task')).toBeTruthy();
  expect(screen.getAllByTestId('ordinary-list-row').map(row => row.textContent)).toEqual(['Joined task', 'Hosted task']);
  state.account.mockResolvedValue([]);
  window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
  await waitFor(() => expect(screen.queryByText('Hosted task')).toBeNull());
  expect(screen.getByText('Joined task')).toBeTruthy();
  state.sessions = [];
  rerender(<SharedTasksSection onSelect={vi.fn()} />);
  expect(screen.queryByRole('region')).toBeNull();
});
it('keeps the sidebar empty until sharing starts and hides it when the last owned share closes', async () => {
  state.sessions = [];
  render(<SharedTasksSection onSelect={vi.fn()} />);
  await act(async () => {});
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  state.account.mockResolvedValue([{ sharedTaskId: 'owned-1', sessionId: 'host-task', local: true, title: 'Hosted task' }]);
  window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
  expect(await screen.findByRole('button', { name: 'sharedTask.title' })).toBeTruthy();
  state.account.mockResolvedValue([]);
  window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
});
it('does not register a remote origin or navigate after an account change during opening', async () => {
  state.sessions=[]; state.account.mockResolvedValue([{ sharedTaskId: 'owned-1', sessionId: 'host-task', hostDeviceId: 'other-pc', local: false, title: 'Hosted task' }]);
  let finish!: () => void; state.openLink.mockImplementation(() => new Promise<void>(resolve => { finish=resolve; }));
  const select=vi.fn(); render(<SharedTasksSection onSelect={select} />);
  fireEvent.click(await screen.findByRole('button', { name: /Hosted task/ }));
  await act(async () => { setDataOwnerGeneration('new-account'); finish(); });
  expect(state.pin).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});
