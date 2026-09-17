// @vitest-environment jsdom
import { cleanup, render, screen, act } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { readMainEntryRoute, rememberMainEntry } from '@/lib/mainEntryPreference';
import { botsListRoute } from '@/features/bots/botsListRoute';
import { MainEntryRedirect, useRememberMainEntry } from '../MainEntryRedirect';

const auth = vi.hoisted(() => ({ dataOwnerId: 'account-a' as string | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

function Layout() {
  useRememberMainEntry();
  const location = useLocation();
  return <><output data-testid="route">{location.pathname}{location.search}</output><Outlet /></>;
}
function launch(path = '/') {
  const router = createMemoryRouter([{ element: <Layout />, children: [
    { path: '/', element: <MainEntryRedirect /> },
    { path: '/bots', children: [botsListRoute] },
    { path: '*', element: <div /> },
  ] }], { initialEntries: [path] });
  const tree = () => <MainViewHistoryProvider ownerKey={auth.dataOwnerId ?? 'signed-out'} locationKey={router.state.location.key}>
    <RouterProvider key={auth.dataOwnerId} router={router} />
  </MainViewHistoryProvider>;
  const view = render(tree());
  return { router, rerender: () => view.rerender(tree()) };
}
beforeEach(() => { localStorage.clear(); auth.dataOwnerId = 'account-a'; });
afterEach(cleanup);

describe('main entry startup', () => {
  it('reopens the partner list after closing a partner chat, without restoring its id', async () => {
    const app = launch();
    await act(() => app.router.navigate('/bots/private-bot/session/private-task'));
    cleanup();
    launch();
    expect(screen.getByTestId('route').textContent).toBe('/bots/list');
    expect(screen.getByRole('main').childElementCount).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('private-bot');
    expect(JSON.stringify(localStorage)).not.toContain('private-task');
  });
  it('keeps the task index behavior for no record and after returning to tasks', async () => {
    const app = launch();
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent');
    await act(() => app.router.navigate('/bots/list'));
    await act(() => app.router.navigate('/cc-agent/task-a'));
    cleanup();
    launch();
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent');
  });
  it.each(['/cc-agent/target?message=one', '/bots/target/session/chat', '/settings'])('preserves explicit startup route %s', (path) => {
    rememberMainEntry('account-a', '/bots/list');
    launch(path);
    expect(screen.getByTestId('route').textContent).toBe(path);
  });
  it('never redirects a notification arriving after restoration back to the list', async () => {
    rememberMainEntry('account-a', '/bots/list');
    const app = launch();
    await act(() => app.router.navigate('/cc-agent/notification-target'));
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent/notification-target');
  });
  it('does not seed a new account from the previous account route', async () => {
    const app = launch('/bots/private-bot/session/private-task');
    auth.dataOwnerId = 'account-b';
    app.rerender();
    expect(readMainEntryRoute('account-b')).toBe('/cc-agent');
    await act(() => app.router.navigate('/'));
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent');
    auth.dataOwnerId = 'account-a';
    app.rerender();
    await act(() => app.router.navigate('/'));
    expect(screen.getByTestId('route').textContent).toBe('/bots/list');
  });
  it('keeps signed-out and invalid preferences on the existing default', () => {
    rememberMainEntry(null, '/bots/list');
    expect(readMainEntryRoute(null)).toBe('/cc-agent');
    localStorage.setItem('cindy.mainEntry.v1.owner.account-a', '/bots/specific');
    expect(readMainEntryRoute('account-a')).toBe('/cc-agent');
  });
  it('degrades to the default when browser storage is unavailable', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readMainEntryRoute('account-a')).toBe('/cc-agent');
    expect(() => rememberMainEntry('account-a', '/bots')).not.toThrow();
    get.mockRestore();
  });
});
