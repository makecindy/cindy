// @vitest-environment jsdom
import { transferableAbortController } from 'node:util';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { readMainEntryRoute, rememberMainEntry } from '@/lib/mainEntryPreference';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import en from '@/i18n/locales/en/common.json';
import { MainEntryRedirect, useRememberMainEntry } from '../MainEntryRedirect';

const auth = vi.hoisted(() => ({ dataOwnerId: 'account-a' as string | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
});

function Layout() {
  useRememberMainEntry();
  const { navigateToView } = useActiveMainView();
  const location = useLocation();
  return <><button onClick={() => navigateToView('bots')}>Partners</button><button onClick={() => navigateToView('cc-agent')}>Tasks</button><output data-testid="route">{location.pathname}{location.search}</output><Outlet /></>;
}
function launch(path = '/') {
  const router = createMemoryRouter([{ element: <Layout />, children: [
    { path: '/', element: <MainEntryRedirect /> },
    // Stand-in for BotsHomeView: /bots resolves the last-viewed teammate (else Cindy).
    { path: '/bots', children: [{ index: true, element: <div data-testid="teammate-entry" /> }] },
    { path: '*', element: <div /> },
  ] }], { initialEntries: [path] });
  const tree = () => <I18nextProvider i18n={i18n}><MainViewHistoryProvider ownerKey={auth.dataOwnerId ?? 'signed-out'} locationKey={router.state.location.key}>
    <RouterProvider key={auth.dataOwnerId} router={router} />
  </MainViewHistoryProvider></I18nextProvider>;
  const view = render(tree());
  return { router, rerender: () => view.rerender(tree()) };
}
// React Router's Node-native Request requires a matching native AbortSignal.
const NativeAbortController = transferableAbortController().constructor;
beforeEach(() => {
  vi.stubGlobal('AbortController', NativeAbortController);
  localStorage.clear(); auth.dataOwnerId = 'account-a';
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('main entry startup', () => {
  it('reopens the teammate entry after closing a partner chat, without restoring its id', async () => {
    const app = launch();
    await act(() => app.router.navigate('/bots/private-bot/session/private-task'));
    cleanup();
    launch();
    expect(screen.getByTestId('route').textContent).toBe('/bots');
    expect(screen.getByTestId('teammate-entry')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('private-bot');
    expect(JSON.stringify(localStorage)).not.toContain('private-task');
  });
  it('opens the teammate entry resolver after restarting from tasks', () => {
    launch('/bots/dash/session/dash-main');
    fireEvent.click(screen.getByText('Tasks'));
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent');
    cleanup();
    launch();
    fireEvent.click(screen.getByText('Partners'));
    expect(screen.getByTestId('route').textContent).toBe('/bots');
    expect(screen.getByTestId('teammate-entry')).toBeTruthy();
  });
  it('returns to the selected partner when switching areas without restarting', () => {
    launch('/bots/dash/session/dash-main');
    fireEvent.click(screen.getByText('Tasks'));
    fireEvent.click(screen.getByText('Partners'));
    expect(screen.getByTestId('route').textContent).toBe('/bots/dash/session/dash-main');
  });
  it('does not restore the previous account partner through the area switcher', async () => {
    const app = launch('/bots/dash/session/dash-main');
    auth.dataOwnerId = 'account-b';
    app.rerender();
    await act(() => app.router.navigate('/cc-agent'));
    fireEvent.click(screen.getByText('Partners'));
    expect(screen.getByTestId('route').textContent).toBe('/bots');
  });
  it('keeps the task index behavior for no record and after returning to tasks', async () => {
    const app = launch();
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent');
    await act(() => app.router.navigate('/bots'));
    await act(() => app.router.navigate('/cc-agent/task-a'));
    cleanup();
    launch();
    expect(screen.getByTestId('route').textContent).toBe('/cc-agent');
  });
  it.each(['/cc-agent/target?message=one', '/bots/target/session/chat', '/settings'])('preserves explicit startup route %s', (path) => {
    rememberMainEntry('account-a', '/bots');
    launch(path);
    expect(screen.getByTestId('route').textContent).toBe(path);
  });
  it('never redirects a notification arriving after restoration back to the list', async () => {
    rememberMainEntry('account-a', '/bots');
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
    expect(screen.getByTestId('route').textContent).toBe('/bots');
  });
  it('keeps signed-out and invalid preferences on the existing default', () => {
    rememberMainEntry(null, '/bots');
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
