// @vitest-environment jsdom
/**
 * Roster timing around entering a companion, with the real botStore and
 * controllable (deferred) `bots.list` reads (issue #12004, PR #11998).
 *
 * It separates "a roster snapshot is usable" from "this refresh finished":
 * - opening a healthy companion from the sidebar must not wait for a background
 *   refresh that is still in flight;
 * - after "continue on this computer" finished and the demotion cleared, the
 *   recovery page must wait for the refresh that brings the companion back, then
 *   enter only that companion (the order #11831 protects).
 *
 * A separate file because botSessionRead / remoteBotSession mock botStore and the
 * router at module level; these cases need the real store and a real router.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanionCloudSnapshot } from '../../../../shared/companionCloud';

const h = vi.hoisted(() => ({
  cloud: { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] } as CompanionCloudSnapshot,
  cloudListeners: new Set<() => void>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../companionCloudStore', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useCompanionCloud: () => useSyncExternalStore((listener) => {
      h.cloudListeners.add(listener);
      return () => h.cloudListeners.delete(listener);
    }, () => h.cloud),
  };
});
vi.mock('../botReadState', () => ({ getBotLastReadAt: () => null, markBotRead: vi.fn(),
  getBotLastReadAtMap: () => ({}), seedMissingBotReadState: vi.fn() }));
vi.mock('../BotDmThreadHost', () => ({ BotDmThreadHost: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ readOnly }: { readOnly?: boolean }) => <div data-testid="chat" data-readonly={String(!!readOnly)} />,
}));
// The recovery view's own takeover IPC is replaced by the step it ends with
// (`ensureBotProfilesLoaded(true)`), driven by the test below.
vi.mock('../CloudCompanionOfflineView', () => ({ CloudCompanionOfflineView: () => <div>recovery-view</div> }));
vi.mock('../useRemoteBots', () => ({ markRemoteBotRead: vi.fn(), useRemoteBots: () => [] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => null,
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ensureBotProfilesLoaded, refreshBotProfiles, useBotProfiles } from '../botStore';
import { BotSessionView } from '../BotSessionView';
import { RemoteBotSessionView } from '../RemoteBotSessionView';
import { BOT_DIRECT_ENTRY_STATE } from '../botNavigation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const row = (id: string) => ({
  id, name: id, status: 'active', enabled: true, createdAt: 1,
  sessions: [{ id: `${id}-main`, kind: 'chat', role: 'canonical', status: 'active', title: '', updatedAt: 1 }],
});

function setCloud(next: CompanionCloudSnapshot) {
  h.cloud = next;
  for (const listener of h.cloudListeners) listener();
}

/** Stands in for BotsHomeView at /bots/:botId: which companion was entered, on which roster. */
function EnteredProbe() {
  const { botId } = useParams();
  const roster = useBotProfiles().map((bot) => bot.id).join(',');
  return <div data-testid="entered">{`${botId}|${roster}`}</div>;
}

let owner = 0;
const list = vi.fn();
const get = vi.fn();

beforeEach(() => {
  // A new data owner gives the module-level roster store a clean projection.
  setDataOwnerGeneration(`roster-timing-${++owner}`, owner);
  list.mockReset();
  get.mockReset();
  h.cloudListeners.clear();
  h.cloud = { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] };
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: {
    localDb: { bots: { list, get } },
    ghosts: { noteSessionFocused: vi.fn() },
    deviceLink: { invoke: vi.fn(() => new Promise(() => {})) },
  } });
});
afterEach(cleanup);

describe('roster timing when entering a companion', () => {
  it('opens a healthy companion writable while a background roster refresh is still in flight', async () => {
    list.mockResolvedValueOnce([row('writer')]);
    await ensureBotProfilesLoaded();
    const refresh = deferred<unknown[]>();
    list.mockReturnValueOnce(refresh.promise);
    refreshBotProfiles(); // e.g. a message notification; this read stays pending
    get.mockResolvedValue(row('writer'));

    render(
      <MemoryRouter initialEntries={[{ pathname: '/bots/writer/session/writer-main', state: BOT_DIRECT_ENTRY_STATE }]}>
        <Routes><Route path="/bots/:botId/session/:sessionId" element={<BotSessionView />} /></Routes>
      </MemoryRouter>,
    );

    // The fresh Bot read still gates writing; only the in-flight list refresh is not awaited.
    await waitFor(() => expect(screen.getByTestId('chat').dataset.readonly).toBe('false'));
    expect(get).toHaveBeenCalledWith('writer');
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => { refresh.resolve([row('writer')]); await ensureBotProfilesLoaded(); });
  });

  it('keeps the recovery page until the refresh that brings the companion back, then enters only it', async () => {
    list.mockResolvedValueOnce([row('other')]);
    await ensureBotProfilesLoaded();
    setCloud({ enabled: true, selfDeviceId: 'home', humanActorId: 'human', demotedBotIds: ['writer'], actors: [
      { id: 'a-writer', externalId: 'writer', name: 'writer', avatar: null, homeDeviceId: 'home' }] });

    render(
      <MemoryRouter initialEntries={['/bots/remote/home/writer']}>
        <Routes>
          <Route path="/bots/remote/:deviceId/:botId" element={<RemoteBotSessionView />} />
          <Route path="/bots/:botId" element={<EnteredProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('recovery-view');

    // "Continue on this computer" finished: the recovery view re-reads the roster
    // (held back here) and the cloud clears the demotion.
    const refresh = deferred<unknown[]>();
    list.mockReturnValueOnce(refresh.promise);
    let reread!: Promise<unknown>;
    act(() => { reread = ensureBotProfilesLoaded(true); });
    act(() => setCloud({ ...h.cloud, demotedBotIds: [] }));
    expect(screen.getByText('recovery-view')).toBeTruthy();
    expect(screen.queryByTestId('entered')).toBeNull();

    await act(async () => { refresh.resolve([row('other'), row('writer')]); await reread; });
    expect((await screen.findByTestId('entered')).textContent).toBe('writer|other,writer');
  });
});
