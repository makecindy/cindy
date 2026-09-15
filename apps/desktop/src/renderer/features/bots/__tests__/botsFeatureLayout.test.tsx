// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { MainViewHistoryContext, type MainViewHistory } from '@/contexts/MainViewHistoryContext';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { BotsFeatureLayout } from '../BotsFeatureLayout';

const mocks = vi.hoisted(() => ({ profiles: [{ id: 'one', status: 'active' }] }));
vi.mock('../botStore', () => ({
  refreshBotProfiles: vi.fn(),
  useBotProfiles: () => mocks.profiles,
}));
vi.mock('../useRemoteBots', () => ({ useRemoteBotSync: vi.fn() }));
vi.mock('../BotsSidebar', () => ({ BotsSidebar: () => null }));
vi.mock('../BotSettingsDrawer', () => ({ BotSettingsDrawer: () => null }));
vi.mock('../../feature-context', () => ({ useOwnTopNavScrollableRows: vi.fn() }));

function Navigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { navigateToView } = useActiveMainView();
  return (
    <>
      <output data-testid="location">{location.pathname + location.search + location.hash}</output>
      <button onClick={() => navigateToView('cc-agent')}>Tasks</button>
      <button onClick={() => navigateToView('bots')}>Teammates</button>
      {['/bots', '/bots/roster', '/bots/roster/?step=avatar#picker', '/bots/remote/host/one', '/bots/missing'].map((path) => (
        <button key={path} onClick={() => navigate(path)}>
          {path}
        </button>
      ))}
    </>
  );
}
function mount(history: { current: MainViewHistory }, initialEntry = '/bots/one/session/chat') {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        onBotProfileChanged: () => () => {},
        onBotLifecycleChanged: () => () => {},
      },
    },
  });
  return render(
    <MainViewHistoryContext.Provider value={history}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Navigation />
        <Routes>
          <Route path="/cc-agent" element={null} />
          <Route path="/bots" element={<BotsFeatureLayout />}>
            <Route index element={null} />
            <Route path="roster" element={null} />
            <Route path="remote/:deviceId/:botId" element={null} />
            <Route path=":botId" element={null} />
            <Route path=":botId/session/:sessionId" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>
    </MainViewHistoryContext.Provider>,
  );
}
afterEach(cleanup);

it.each(['/bots/roster', '/bots/roster/?step=avatar#picker'])(
  'returns through the teammate entry resolver after leaving creation at %s',
  (creationPath) => {
    const history = { current: { lastMatchedKey: 'bots', paths: {} } as MainViewHistory };
    mount(history);
    fireEvent.click(screen.getByRole('button', { name: creationPath }));
    expect(screen.getByTestId('location').textContent).toBe(creationPath);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(screen.getByTestId('location').textContent).toBe('/bots');
    expect(history.current.lastBotId).toBe('one');
  },
);

it('uses the entry resolver after creation even without a remembered teammate', () => {
  const history = { current: { lastMatchedKey: 'bots', paths: {} } as MainViewHistory };
  mount(history, '/bots/roster');
  fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
  expect(screen.getByTestId('location').textContent).toBe('/bots');
  expect(history.current.lastBotId).toBeUndefined();
});

it('still restores a remote teammate route when no creation page was visited', () => {
  const history = { current: { lastMatchedKey: 'bots', paths: {} } as MainViewHistory };
  mount(history);
  fireEvent.click(screen.getByRole('button', { name: '/bots/remote/host/one' }));
  fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
  fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
  expect(screen.getByTestId('location').textContent).toBe('/bots/remote/host/one');
  expect(history.current.lastBotId).toBe('one');
});

it('remembers the visited local teammate across index, creation, remote and missing routes', () => {
  const history = { current: { lastMatchedKey: 'bots', paths: {} } as MainViewHistory };
  mount(history);
  expect(history.current.lastBotId).toBe('one');
  for (const path of ['/bots', '/bots/roster', '/bots/remote/host/one', '/bots/missing']) {
    fireEvent.click(screen.getByRole('button', { name: path }));
    expect(history.current.lastBotId).toBe('one');
  }
});

it('does not seed a new owner from the inherited router entry', () => {
  const history = {
    current: {
      lastMatchedKey: 'cc-agent',
      paths: {},
      ignoredLocationKey: 'default',
    } as MainViewHistory,
  };
  mount(history);
  expect(history.current.lastBotId).toBeUndefined();
});
