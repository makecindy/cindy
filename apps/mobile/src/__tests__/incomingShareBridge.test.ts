import { beforeEach, expect, it, vi } from 'vitest';
import { IncomingShareBridge } from '@/session/IncomingShareBridge';

const mock = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | void>,
  cleanup: vi.fn(), receive: vi.fn(), stop: vi.fn(),
  ownerChanged: undefined as (() => void) | undefined,
  switching: false, appState: 'active', unsubscribe: vi.fn(),
}));
vi.mock('react', () => ({ useEffect: (effect: () => void) => mock.effects.push(effect) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { get currentState() { return mock.appState; }, addEventListener: () => ({ remove: vi.fn() }) },
  Linking: { addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({}), useSegments: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('@/auth/authOwnerGeneration', () => ({
  getMobileAuthOwner: () => ({ switching: mock.switching }),
  subscribeMobileAuthOwner: (listener: () => void) => { mock.ownerChanged = listener; return mock.unsubscribe; },
}));
vi.mock('@/session/incomingShare', () => ({
  receiveIncomingShare: mock.receive, useIncomingShareBatch: () => null,
  watchIncomingShareAccount: () => mock.stop,
}));
vi.mock('@/session/incomingShareNative', () => ({}));
vi.mock('@/session/incomingShareCleanup', () => ({ cleanupExpiredIncomingShares: mock.cleanup }));

beforeEach(() => {
  mock.effects.length = 0; mock.ownerChanged = undefined;
  mock.switching = false; mock.appState = 'active'; vi.clearAllMocks();
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
