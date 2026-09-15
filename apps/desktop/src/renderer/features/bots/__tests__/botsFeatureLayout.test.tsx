// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { MainViewHistoryContext, type MainViewHistory } from '@/contexts/MainViewHistoryContext';
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
  return (
    <>
      {['/bots', '/bots/roster', '/bots/remote/host/one', '/bots/missing'].map((path) => (
        <button key={path} onClick={() => navigate(path)}>
          {path}
        </button>
      ))}
    </>
  );
}
function mount(history: { current: MainViewHistory }) {
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
      <MemoryRouter initialEntries={['/bots/one/session/chat']}>
        <Navigation />
        <Routes>
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
