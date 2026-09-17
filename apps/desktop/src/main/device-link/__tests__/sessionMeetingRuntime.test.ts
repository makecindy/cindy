import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HostRecord = {
  options: { creationState: unknown; isCurrent(): boolean; revoke(meetingId: string, memberId?: string): void };
  restore: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  closeLocallyForBoundary: ReturnType<typeof vi.fn>;
};
const state = vi.hoisted(() => ({
  accountId: 'owner', region: 'global', authenticated: true,
  session: { mode: 'cloud', dataOwnerId: 'owner', generation: 1 }, boundary: false,
  db: { client: { query: vi.fn() }, clientEpoch: 1 },
  hosts: [] as HostRecord[], dispatch: vi.fn(),
  captureClose: vi.fn(), close: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.db }));
vi.mock('../../localDb/sessionMeetings.js', () => ({ createSessionMeetingJournal: () => ({}) }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => [state.session.mode, state.session.dataOwnerId, state.session.generation].join(':'),
  getActiveAppSession: () => ({ ...state.session }), isAppSessionBoundaryPending: () => state.boundary,
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ isAuthenticated: state.authenticated }), getCurrentUserId: () => state.accountId,
  getDeviceId: () => 'host-device', getActiveAuthRealm: () => state.region,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('../sessionMeetingApi.js', () => ({ sessionMeetingApi: {}, captureSessionMeetingBoundaryClose: state.captureClose }));
vi.mock('../sessionMeetingDispatch.js', () => ({ setSessionMeetingDispatchHost: state.dispatch }));
vi.mock('../sessionMeetingHost.js', () => ({
  SessionMeetingHost: class {
    restore = vi.fn(async () => undefined);
    closeLocallyForBoundary = vi.fn(async () => ['meeting-a', 'meeting-b']);
    // The real Host disposes each existing grant through this callback.
    dispose = vi.fn(async () => { this.options.revoke('meeting-a'); });
    constructor(readonly options: HostRecord['options']) { state.hosts.push(this); }
  },
}));

import { closeSessionMeetingsBeforeLogout, requireSessionMeetingHost, startSessionMeetingRuntime, stopSessionMeetingRuntime } from '../sessionMeetingRuntime';

function start() {
  const client = { hasServerCapability: () => true, getStatus: () => 'online', start: vi.fn(), stop: vi.fn(), revoke: vi.fn() };
  startSessionMeetingRuntime({ client: client as never, revoke: client.revoke, changed: vi.fn() });
  return client;
}

beforeEach(async () => {
  await stopSessionMeetingRuntime();
  vi.useFakeTimers();
  state.accountId = 'owner'; state.region = 'global'; state.authenticated = true; state.boundary = false;
  state.session = { mode: 'cloud', dataOwnerId: 'owner', generation: 1 };
  state.db = { client: { query: vi.fn() }, clientEpoch: 1 };
  state.hosts.length = 0; state.dispatch.mockClear();
  state.captureClose.mockReset().mockReturnValue(state.close);
  state.close.mockReset().mockResolvedValue({ status: 'closed' });
});
afterEach(async () => {
  await stopSessionMeetingRuntime();
  vi.useRealTimers();
});

describe('shared runtime stable owner recommit', () => {
  it('preserves creation cleanup across same-profile rebind but not database replacement', () => {
    start();
    const original = state.hosts[0].options.creationState;
    state.session.generation++;
    requireSessionMeetingHost();
    expect(state.hosts[1].options.creationState).toBe(original);
    state.db = { client: { query: vi.fn() }, clientEpoch: 2 };
    start();
    expect(state.hosts[2].options.creationState).not.toBe(original);
  });
  it('persists the outgoing journal before closing all shares with captured old identity', async () => {
    start();
    const outgoing = state.hosts[0];
    let finish!: () => void;
    outgoing.closeLocallyForBoundary.mockImplementation(() => new Promise<string[]>((resolve) => {
      finish = () => resolve(['meeting-a', 'meeting-b']);
    }));
    state.boundary = true;
    const closing = closeSessionMeetingsBeforeLogout();
    expect(state.captureClose).toHaveBeenCalledExactlyOnceWith('owner', 'global');
    expect(state.close).not.toHaveBeenCalled();
    // Another binding cannot change which host/journal this cleanup stops.
    finish();
    await closing;
    expect(outgoing.dispose).toHaveBeenCalledOnce();
    expect(state.close.mock.calls).toEqual([['meeting-a'], ['meeting-b']]);
  });
  it('keeps durable cleanup when offline or credentials are already cleared', async () => {
    start();
    state.close.mockRejectedValue(new Error('offline'));
    await expect(closeSessionMeetingsBeforeLogout()).resolves.toBeUndefined();
    expect(state.hosts[0].closeLocallyForBoundary).toHaveBeenCalledOnce();
    state.captureClose.mockReturnValue(null);
    state.close.mockClear();
    await closeSessionMeetingsBeforeLogout();
    expect(state.close).not.toHaveBeenCalled();
  });
  it('does not report logout complete or send closure before the journal is durable', async () => {
    start();
    state.hosts[0].closeLocallyForBoundary.mockRejectedValue(new Error('disk failed'));
    await expect(closeSessionMeetingsBeforeLogout()).rejects.toThrow('disk failed');
    expect(state.close).not.toHaveBeenCalled();
    expect(state.hosts[0].dispose).not.toHaveBeenCalled();
  });
  it('rebinds on the existing refresh tick without restarting relay or reviving old captures', async () => {
    const relay = start();
    const original = state.hosts[0];
    const oldCapture = original.options.isCurrent;
    expect(oldCapture()).toBe(true);
    state.session.generation++;
    expect(oldCapture()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.hosts).toHaveLength(2);
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(state.hosts[1].restore).toHaveBeenCalledOnce();
    expect(requireSessionMeetingHost()).toBe(state.hosts[1]);
    expect(oldCapture()).toBe(false);
    expect(relay.start).not.toHaveBeenCalled();
    expect(relay.stop).not.toHaveBeenCalled();
    expect(relay.revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.hosts).toHaveLength(2);
  });

  it('rebinds on demand before the next tick and restores authority into a new Host', () => {
    start();
    const original = requireSessionMeetingHost();
    state.session.generation++;
    const replacement = requireSessionMeetingHost();
    expect(replacement).not.toBe(original);
    expect(replacement).toBe(state.hosts[1]);
    expect(state.hosts[1].restore).toHaveBeenCalledOnce();
  });

  it.each(['boundary', 'account', 'stable-owner', 'region', 'database', 'database-epoch', 'signed-out', 'local'])(
    'never rebinds across an unresolved %s boundary', async (change) => {
      start(); state.session.generation++;
      if (change === 'boundary') state.boundary = true;
      if (change === 'account') state.accountId = 'other';
      if (change === 'stable-owner') state.session.dataOwnerId = 'other';
      if (change === 'region') state.region = 'cn';
      if (change === 'database') state.db = { ...state.db, client: { query: vi.fn() } };
      if (change === 'database-epoch') state.db = { ...state.db, clientEpoch: state.db.clientEpoch + 1 };
      if (change === 'signed-out') state.authenticated = false;
      if (change === 'local') state.session.mode = 'local';
      expect(() => requireSessionMeetingHost()).toThrow('PRECONDITION_FAILED');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.hosts).toHaveLength(1);
    },
  );

  it('waits for a stable same-owner boundary to finish, then rebinds', async () => {
    start(); state.session.generation++; state.boundary = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.hosts).toHaveLength(1);
    state.boundary = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.hosts).toHaveLength(2);
  });

  it('never reacquires a stopped relay owner on demand or by timer', async () => {
    const relay = start();
    await stopSessionMeetingRuntime();
    expect(relay.revoke).toHaveBeenCalledWith('meeting-a', undefined);
    state.session.generation++;
    expect(() => requireSessionMeetingHost()).toThrow('PRECONDITION_FAILED');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.hosts).toHaveLength(1);
  });
});
