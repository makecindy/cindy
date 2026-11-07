// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IncomingShareBridge } from '@/session/IncomingShareBridge';

const mock = vi.hoisted(() => ({
  linkReceived: undefined as ((event: { url: string }) => void) | undefined,
  foreground: undefined as ((state: string) => void) | undefined,
  cleanup: vi.fn(), receive: vi.fn(), stop: vi.fn(),
  ownerChanged: undefined as (() => void) | undefined,
  switching: false, appState: 'active', unsubscribe: vi.fn(),
  batch: null as { id: string; destination?: string } | null,
  segments: [] as string[], navigate: vi.fn(),
  auth: { initialized: true, isAuthenticated: true },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    get currentState() { return mock.appState; },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mock.foreground = listener; return { remove: vi.fn() };
    },
  },
  Linking: { addEventListener: (_event: string, listener: (event: { url: string }) => void) => {
    mock.linkReceived = listener; return { remove: vi.fn() };
  } },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: mock.navigate }), useSegments: () => mock.segments }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => mock.auth }));
vi.mock('@/auth/authOwnerGeneration', () => ({
  getMobileAuthOwner: () => ({ switching: mock.switching }),
  subscribeMobileAuthOwner: (listener: () => void) => { mock.ownerChanged = listener; return mock.unsubscribe; },
}));
vi.mock('@/session/incomingShare', () => ({
  receiveIncomingShare: mock.receive, useIncomingShareBatch: () => mock.batch,
  watchIncomingShareAccount: () => mock.stop,
}));
vi.mock('@/session/incomingShareNative', () => ({}));
vi.mock('@/session/incomingShareCleanup', () => ({ cleanupExpiredIncomingShares: mock.cleanup }));

let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.clearAllMocks();
  mock.ownerChanged = undefined; mock.linkReceived = undefined; mock.foreground = undefined;
  mock.batch = null; mock.segments = [];
  mock.auth = { initialized: true, isAuthenticated: true };
  mock.switching = false; mock.appState = 'active';
  mock.cleanup.mockReset().mockResolvedValue(undefined);
  mock.receive.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); mounted = true;
});
afterEach(async () => {
  if (mounted) await act(() => root.unmount());
  container.remove();
});
async function render() {
  await act(async () => { root.render(createElement(IncomingShareBridge)); await vi.dynamicImportSettled(); });
}
async function flush() { await act(async () => { await vi.dynamicImportSettled(); }); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Bug: foreground and the delayed URL event reset the chosen share target.
// Exercise real React effects through the production bridge, at native/router boundaries.
it('does not reopen the chooser when the share URL arrives after selecting a target', async () => {
  mock.batch = { id: 'shared' };
  await render();
  expect(mock.navigate).toHaveBeenCalledExactlyOnceWith('/incoming-share');
  mock.segments = ['incoming-share']; await render();
  mock.batch = { id: 'shared', destination: 'companion' };
  mock.segments = ['sessions', '[sessionId]']; await render();
  mock.foreground!('active');
  mock.linkReceived!({ url: 'cindy://expo-sharing' });
  await flush(); await render();
  expect(mock.receive.mock.calls.length).toBeGreaterThan(1);
  expect(mock.navigate).toHaveBeenCalledTimes(1);
});

it('leaves a retained batch alone and opens the chooser for a new share', async () => {
  mock.batch = { id: 'first' }; await render();
  mock.segments = ['incoming-share']; await render();
  mock.segments = []; await render();
  mock.linkReceived!({ url: 'cindy://expo-sharing' }); await flush(); await render();
  expect(mock.navigate).toHaveBeenCalledTimes(1);
  mock.batch = { id: 'second' }; await render();
  expect(mock.navigate).toHaveBeenCalledTimes(2);
});

it('does not mark a batch presented until authentication is ready', async () => {
  mock.batch = { id: 'pending-login' }; mock.auth.initialized = false;
  mock.segments = ['incoming-share']; await render();
  expect(mock.navigate).not.toHaveBeenCalled();
  mock.segments = []; mock.auth.initialized = true; await render();
  expect(mock.navigate).toHaveBeenCalledExactlyOnceWith('/incoming-share');
});

it('serializes overlapping foreground and URL reads after expiry cleanup', async () => {
  const cleanup = deferred(); const read = deferred();
  mock.cleanup.mockReturnValueOnce(cleanup.promise);
  mock.receive.mockReturnValueOnce(read.promise);
  await render();
  mock.foreground!('active'); mock.linkReceived!({ url: 'cindy://expo-sharing' });
  expect(mock.cleanup).toHaveBeenCalledOnce(); expect(mock.receive).not.toHaveBeenCalled();
  cleanup.resolve(); await flush();
  expect(mock.receive).toHaveBeenCalledOnce();
  mock.foreground!('active'); await flush();
  expect(mock.receive).toHaveBeenCalledOnce();
  read.resolve(); await flush();
  expect(mock.receive).toHaveBeenCalledTimes(2);
  expect(mock.cleanup).toHaveBeenCalledTimes(2);
});

it('does not stage after the bridge unmounts during cleanup', async () => {
  const cleanup = deferred(); mock.cleanup.mockReturnValueOnce(cleanup.promise);
  await render();
  await act(() => root.unmount()); mounted = false;
  cleanup.resolve(); await flush();
  expect(mock.receive).not.toHaveBeenCalled();
  expect(mock.stop).toHaveBeenCalledOnce();
  expect(mock.unsubscribe).toHaveBeenCalledOnce();
});

it('keeps receiving if cleanup is unavailable in an older binary', async () => {
  mock.cleanup.mockRejectedValue(new Error('unavailable'));
  await render();
  expect(mock.receive).toHaveBeenCalledOnce();
});

it('refreshes only when an account switch settles in foreground', async () => {
  await render();
  mock.switching = true; mock.ownerChanged!(); await flush();
  expect(mock.cleanup).toHaveBeenCalledOnce();
  mock.switching = false; mock.appState = 'background'; mock.ownerChanged!(); await flush();
  expect(mock.cleanup).toHaveBeenCalledOnce();
  mock.appState = 'active'; mock.ownerChanged!(); await flush();
  expect(mock.receive).toHaveBeenCalledTimes(2);
});

it('ignores unrelated links and retries a native read on a later share notification', async () => {
  mock.receive.mockRejectedValueOnce(new Error('temporarily unavailable'));
  await render();
  mock.linkReceived!({ url: 'cindy://auth?code=example' }); await flush();
  expect(mock.receive).toHaveBeenCalledOnce();
  mock.linkReceived!({ url: 'cindy://expo-sharing' }); await flush();
  expect(mock.receive).toHaveBeenCalledTimes(2);
});
