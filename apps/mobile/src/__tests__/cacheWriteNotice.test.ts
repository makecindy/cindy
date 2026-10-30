import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ currentState: 'active', alert: vi.fn(), remove: vi.fn(), listener: undefined as undefined | ((state: string) => void) }));
vi.mock('react-native', () => ({
  Alert: { alert: state.alert },
  AppState: {
    get currentState() { return state.currentState; },
    addEventListener: (_: string, listener: (value: string) => void) => {
      state.listener = listener;
      return { remove: state.remove };
    },
  },
}));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); state.currentState = 'active'; state.listener = undefined; });
it('shows a save failure notice only once despite repeated streaming writes', async () => {
  const { notifyCacheWriteFailure } = await import('@/session/cacheWriteNotice');
  notifyCacheWriteFailure(); notifyCacheWriteFailure();
  expect(state.alert).toHaveBeenCalledTimes(1);
  expect(state.alert).toHaveBeenCalledWith('devices.list.alert.cacheSaveFailed', 'devices.list.alert.cacheSaveFailedDetail');
});
it('defers a background write failure until the user returns', async () => {
  state.currentState = 'background';
  const { notifyCacheWriteFailure } = await import('@/session/cacheWriteNotice');
  notifyCacheWriteFailure(); notifyCacheWriteFailure();
  expect(state.alert).not.toHaveBeenCalled();
  state.listener?.('inactive');
  expect(state.alert).not.toHaveBeenCalled();
  state.listener?.('active');
  expect(state.alert).toHaveBeenCalledTimes(1);
  expect(state.remove).toHaveBeenCalledTimes(1);
});
