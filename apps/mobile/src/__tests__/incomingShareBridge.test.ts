import { beforeEach, expect, it, vi } from 'vitest';
import { IncomingShareBridge } from '@/session/IncomingShareBridge';

const mock = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | void>,
  cleanup: vi.fn(), receive: vi.fn(), stop: vi.fn(),
  ownerChanged: undefined as (() => void) | undefined,
  switching: false, appState: 'active', unsubscribe: vi.fn(),
  presented: { current: null as string | null },
  batch: null as { id: string } | null,
  segments: [] as string[], navigate: vi.fn(),
  auth: { initialized: true, isAuthenticated: true },
}));
vi.mock('react', () => ({
  useEffect: (effect: () => void) => mock.effects.push(effect),
  useRef: () => mock.presented,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { get currentState() { return mock.appState; }, addEventListener: () => ({ remove: vi.fn() }) },
  Linking: { addEventListener: () => ({ remove: vi.fn() }) },
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

beforeEach(() => {
  mock.effects.length = 0; mock.ownerChanged = undefined;
  mock.presented.current = null; mock.batch = null; mock.segments = [];
  mock.auth = { initialized: true, isAuthenticated: true };
  mock.switching = false; mock.appState = 'active'; vi.clearAllMocks();
});

function navigatePendingShare() {
  mock.effects.length = 0;
  IncomingShareBridge();
  mock.effects[1]!();
}

it('lets users leave a failed handoff and navigates again for a fresh share', () => {
  mock.batch = { id: 'first' };
  navigatePendingShare();
  expect(mock.navigate).toHaveBeenCalledExactlyOnceWith('/sessions/new');
  mock.segments = ['sessions', 'new'];
  navigatePendingShare();
  mock.segments = [];
  navigatePendingShare();
  expect(mock.navigate).toHaveBeenCalledTimes(1);
  mock.batch = { id: 'second' };
  navigatePendingShare();
  expect(mock.navigate).toHaveBeenCalledTimes(2);
});

it('does not mark a batch presented until authentication is ready', () => {
  mock.batch = { id: 'pending-login' };
  mock.auth.initialized = false;
  mock.segments = ['sessions', 'new'];
  navigatePendingShare();
  mock.segments = [];
  mock.auth.initialized = true;
  navigatePendingShare();
  expect(mock.navigate).toHaveBeenCalledExactlyOnceWith('/sessions/new');
});

it('finishes expiry before reading the native slot', async () => {
  let finish!: () => void;
  mock.cleanup.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  IncomingShareBridge();
  const unmount = mock.effects[0]!();
  await vi.waitFor(() => expect(mock.cleanup).toHaveBeenCalledOnce());
  expect(mock.receive).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(mock.receive).toHaveBeenCalledOnce());
  unmount?.();
});

it('does not stage after the bridge unmounts during cleanup', async () => {
  let finish!: () => void;
  mock.cleanup.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  IncomingShareBridge();
  const unmount = mock.effects[0]!();
  await vi.waitFor(() => expect(mock.cleanup).toHaveBeenCalledOnce());
  unmount?.();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mock.receive).not.toHaveBeenCalled();
  expect(mock.stop).toHaveBeenCalledOnce();
});

it('keeps receiving if cleanup is unavailable in an older binary', async () => {
  mock.cleanup.mockRejectedValue(new Error('unavailable'));
  IncomingShareBridge();
  const unmount = mock.effects[0]!();
  await vi.waitFor(() => expect(mock.receive).toHaveBeenCalledOnce());
  unmount?.();
});

it('refreshes shares when a switch settles in foreground, and unsubscribes on unmount', async () => {
  mock.cleanup.mockResolvedValue(undefined);
  IncomingShareBridge();
  const unmount = mock.effects[0]!();
  await vi.waitFor(() => expect(mock.receive).toHaveBeenCalledOnce());
  mock.switching = true;
  mock.ownerChanged!();
  expect(mock.cleanup).toHaveBeenCalledOnce();
  mock.switching = false;
  mock.appState = 'background';
  mock.ownerChanged!();
  expect(mock.cleanup).toHaveBeenCalledOnce();
  mock.appState = 'active';
  mock.ownerChanged!();
  await vi.waitFor(() => expect(mock.receive).toHaveBeenCalledTimes(2));
  unmount?.();
  expect(mock.unsubscribe).toHaveBeenCalledOnce();
});
