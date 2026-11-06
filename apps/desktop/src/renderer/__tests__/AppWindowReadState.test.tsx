// @vitest-environment jsdom
// Real full-window startup must hand imported positions to the remote host before
// list hydration can seed it with a newer timestamp.
import { useEffect } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BotReadStateRequest } from '../../shared/botReadStateStorage';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getBotLastReadAtMap, getBotReadStateSyncStatus, resetBotReadStateForTests,
  seedBotGroupReadState, seedMissingBotReadState } from '@/features/bots/botReadState';
import { botReadStateFixture } from '@/features/bots/__tests__/botReadStateFixture';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ canEnterApp: true, dataOwnerId: 'owner-1' }) }));
vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => true }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));
vi.mock('@/features/bots/botGroupOutbox', () => ({ startBotGroupOutbox: () => () => {} }));
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBotSync: () => {} }));
vi.mock('@/features/bots/useBotUnreadSync', () => ({ useBotUnreadSync: () => {
  useEffect(() => {
    seedMissingBotReadState(['existing', 'new'], 200);
    seedBotGroupReadState([{ id: 'existing', lastReplyAt: 200 }]);
  }, []);
} }));
vi.mock('../components/layout/AppBadgeAttentionSync', () => ({ AppBadgeAttentionSync: () => null }));
import { AppWindowSync } from '../components/layout/AppWindowSync';

afterEach(() => { cleanup(); resetBotReadStateForTests(); window.localStorage.clear(); });

it('waits for Main import before seeding the host, preserves historical unread and releases host subscriptions', async () => {
  window.localStorage.clear();
  const owner = { dataOwnerId: 'owner-1', generation: 1 };
  setDataOwnerGeneration(owner.dataOwnerId, owner.generation); resetBotReadStateForTests();
  window.localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ existing: 100, 'group:existing': 100 }));
  const fixture = botReadStateFixture();
  let release!: () => void;
  const importing = new Promise<void>(resolve => { release = resolve; });
  const positions: Record<string, number> = {};
  const unsubscribe = vi.fn();
  const update = vi.fn(async (body: { ownerId: string; seed?: Record<string, number> }) => {
    for (const [id, at] of Object.entries(body.seed ?? {})) if (!(id in positions)) positions[id] = at;
    return { ownerId: body.ownerId, positions: { ...positions }, acknowledgedPositions: {} };
  });
  window.electronAPI = { maker: { ...fixture.bridge, botReadState: async (request: BotReadStateRequest) => {
    await importing; return fixture.bridge.botReadState(request);
  } }, localDb: { bots: { readState: {
    get: async () => ({ ownerId: 'owner-1', positions: {}, acknowledgedPositions: {} }),
    update, onChanged: () => unsubscribe,
  } } } } as unknown as Window['electronAPI'];
  try {
    const view = render(<AppWindowSync />);
    expect(getBotReadStateSyncStatus().phase).toBe('loading');
    expect(update).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(getBotReadStateSyncStatus().phase).toBe('ready'));
    await vi.waitFor(() => expect(positions).toEqual({ existing: 100, 'group:existing': 100, new: 200 }));
    // A reply at 150 is still newer than the host position sent to remote consumers.
    expect(positions.existing).toBeLessThan(150);
    seedMissingBotReadState(['existing', 'new'], 500);
    seedBotGroupReadState([{ id: 'existing', lastReplyAt: 500 }]);
    expect(getBotLastReadAtMap()).toEqual(positions);
    expect(update.mock.calls.every(([body]) => Object.values(body.seed ?? {}).every(at => at <= 200))).toBe(true);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.listenerCount()).toBe(0);
  } finally {
    release(); cleanup();
    await fixture.bridge.botReadState({ owner, action: 'snapshot' });
    fixture.dispose();
  }
});
