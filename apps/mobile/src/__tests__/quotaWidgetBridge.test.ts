import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuotaWidgetBridge } from '../widgets/QuotaWidgetBridge';

const mock = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | void>,
  state: { ready: true, deviceId: 'desktop' }, appState: 'active', status: 'online',
  change: undefined as undefined | ((state: string) => void),
  refresh: vi.fn(async () => {}), offline: vi.fn(), suspend: vi.fn(), remove: vi.fn(),
}));
vi.mock('react', () => ({
  useEffect: (effect: () => void) => mock.effects.push(effect),
  useSyncExternalStore: () => mock.state,
}));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return mock.appState; },
  addEventListener: (_: string, fn: (state: string) => void) => { mock.change = fn; return { remove: mock.remove }; },
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: 'en' } }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ preference: 'system' }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({
  status: mock.status, getPresenceAvailability: () => true, connectionEpoch: 1, presenceVersion: 1,
}) }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({}), isMobileAuthOwnerCurrent: () => true }));
vi.mock('../widgets/quotaWidgetStore', () => ({
  nativeQuotaWidget: { setPresentation: vi.fn() },
  quotaWidgetStore: { subscribe: vi.fn(), getSnapshot: () => mock.state, refresh: mock.refresh, offline: mock.offline, suspend: mock.suspend },
}));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mock.effects = []; mock.appState = 'active'; mock.status = 'online'; });
afterEach(() => { vi.useRealTimers(); });

it('pauses in the background without marking the source offline; resumes with a fresh read', async () => {
  QuotaWidgetBridge(); const cleanup = mock.effects[1]();
  expect(mock.refresh).toHaveBeenCalledOnce();
  mock.appState = 'background'; mock.change!('background');
  mock.status = 'offline';
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mock.suspend).toHaveBeenCalledOnce();
  expect(mock.offline).not.toHaveBeenCalled();
  expect(mock.refresh).toHaveBeenCalledOnce();
  mock.appState = 'active'; mock.change!('active');
  expect(mock.refresh).toHaveBeenCalledTimes(2);
  cleanup?.(); expect(mock.remove).toHaveBeenCalledOnce();
});

it('marks an actually unavailable foreground link offline instead of querying it', () => {
  mock.status = 'offline'; QuotaWidgetBridge(); const cleanup = mock.effects[1]();
  expect(mock.offline).toHaveBeenCalledOnce(); expect(mock.refresh).not.toHaveBeenCalled();
  cleanup?.();
});
