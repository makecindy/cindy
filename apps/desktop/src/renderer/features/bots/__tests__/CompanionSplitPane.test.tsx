// @vitest-environment jsdom
// Unit regression for #11517: a restored background companion pane must render
// its confirmed new home and persist that target, without navigating the window.
// Existing route tests mount a single full-page companion and miss this boundary.
// Minimal input: old remote target + Navigate to the same companion's new home.
import { useSyncExternalStore } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import CompanionSplitPane from '../CompanionSplitPane';
import { getSplitPanes, splitGroupStore } from '../../cc-agent/splitGroupStore';

const mocks = vi.hoisted(() => ({ destination: '/bots/remote/new/mate' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../botGroupStore', () => ({ useBotGroupSummary: () => null }));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => ({ actors: [] }) }));
vi.mock('../BotsFeatureLayout', () => ({ BotsFeatureLayout: () => <Outlet /> }));
vi.mock('../RemoteBotSessionView', () => ({
  RemoteBotSessionView: () => {
    const { deviceId, botId } = useParams();
    return deviceId === 'old' ? <Navigate to={mocks.destination} replace />
      : <div>Chat {deviceId} {botId}</div>;
  },
}));
vi.mock('../BotsHomeView', () => ({ BotsHomeView: () => <div>Local chat</div> }));

function Harness() {
  const state = useSyncExternalStore(splitGroupStore.subscribe, splitGroupStore.getSnapshot);
  const target = getSplitPanes(state.root).find(pane => pane.sessionId.startsWith('/bots/'))?.sessionId;
  const location = useLocation();
  return <>
    <output>{location.pathname}</output>
    {target && <CompanionSplitPane key={target} target={target} focused={false}>
      {(_title, _route, chat) => chat}
    </CompanionSplitPane>}
  </>;
}
beforeEach(() => {
  splitGroupStore.clear();
  splitGroupStore.addSession('/bots/remote/old/mate', 'task-a', 'right');
});
afterEach(() => { cleanup(); splitGroupStore.clear(); });

it.each(['/bots/remote/new/mate', '/bots/mate'])('follows the same companion to %s in its own pane', async destination => {
  mocks.destination = destination;
  render(<MemoryRouter initialEntries={['/cc-agent/task-a']}><Harness /></MemoryRouter>);
  await screen.findByText(destination === '/bots/mate' ? 'Local chat' : 'Chat new mate');
  expect(getSplitPanes(splitGroupStore.getSnapshot().root).map(pane => pane.sessionId))
    .toEqual(['task-a', destination]);
  expect(screen.getByText('/cc-agent/task-a')).toBeTruthy();
});

it('retains the original target when a redirect names a different companion', async () => {
  mocks.destination = '/bots/remote/new/other';
  render(<MemoryRouter initialEntries={['/cc-agent/task-a']}><Harness /></MemoryRouter>);
  await waitFor(() => expect(getSplitPanes(splitGroupStore.getSnapshot().root)[1].sessionId)
    .toBe('/bots/remote/old/mate'));
  expect(screen.getByText('/cc-agent/task-a')).toBeTruthy();
});
