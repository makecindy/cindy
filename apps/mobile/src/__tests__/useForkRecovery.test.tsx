// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { useForkRecovery } from '@/session/useForkRecovery';

const { alert, storage } = vi.hoisted(() => ({ alert: vi.fn(), storage: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
  removeItem: async (key: string) => { storage.delete(key); },
} }));
vi.mock('react-native', () => ({ Alert: { alert } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: (error: unknown) => String(error) }));

const capabilities = vi.fn();
const requestFork = vi.fn();
const legacyFork = vi.fn();
const complete = vi.fn();
const picker = vi.fn();
const onError = vi.fn();
function input(scope = 'owner/device/source/generation') {
  return { scope, sessionId: 'source', maker: { getForkCapabilities: capabilities, requestFork, fork: legacyFork } as unknown as MobileMakerTransport,
    storageScope: 'device/source',
    setPickerOpen: picker, onBusy: vi.fn(), onError, onComplete: complete };
}
const press = async (key: string) => {
  const buttons = alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
  await act(async () => { buttons.find(button => button.text === key)!.onPress!(); });
};

// The production hook drives the phone's actual Alert callbacks and the existing
// model sheet. Earlier page-only fork code could not recover a lost reply or
// choose a new target. Unit tier: no native renderer, network, accounts or sleeps.
describe('phone fork recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks(); requestFork.mockReset();
    storage.clear();
    capabilities.mockResolvedValue({ forkRequestVersion: 1, historyHandoff: true });
  });
  it('finds a lost reply through status with the same request ID', async () => {
    requestFork.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ state: 'complete', session: { id: 'child' }, outcome: 'native' });
    const { result } = renderHook(() => useForkRecovery(input()));
    await act(async () => result.current.run('anchor'));
    const [create, lookup] = requestFork.mock.calls.map(call => call[0]);
    expect(lookup).toEqual({ ...create, action: 'status' });
    expect(complete).toHaveBeenCalledExactlyOnceWith({ id: 'child' }, undefined, 'native');
    expect(legacyFork).not.toHaveBeenCalled();
  });
  it('shows a direct provider picker after an offline native history, then confirms the handoff', async () => {
    requestFork.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ state: 'failed' })
      .mockResolvedValueOnce({ state: 'complete', session: { id: 'handoff' }, outcome: 'history-handoff' });
    const { result } = renderHook(() => useForkRecovery(input()));
    await act(async () => result.current.run('anchor'));
    await press('session.forkRecovery.choose');
    expect(picker).toHaveBeenCalledWith(true);
    const target = { agentKind: 'pi' as const, model: 'chosen', providerId: 'provider', agentDeviceId: null };
    act(() => { expect(result.current.pick(target)).toBe(true); });
    expect(requestFork).toHaveBeenCalledTimes(2);
    act(() => result.current.pickerClosed());
    await press('session.forkRecovery.continue');
    expect(requestFork.mock.calls[2]![0].target).toEqual(target);
    expect(requestFork.mock.calls[2]![0].requestId).not.toBe(requestFork.mock.calls[0]![0].requestId);
    expect(complete).toHaveBeenCalledWith({ id: 'handoff' }, undefined, 'history-handoff');
  });
  it('checks an unknown result without replaying the native write', async () => {
    requestFork.mockResolvedValueOnce({ state: 'unknown' }).mockResolvedValueOnce({ state: 'complete', session: { id: 'found' }, outcome: 'native' });
    const { result } = renderHook(() => useForkRecovery(input()));
    await act(async () => result.current.run('anchor'));
    await press('session.forkRecovery.check');
    expect(requestFork.mock.calls[1]![0]).toEqual({ ...requestFork.mock.calls[0]![0], action: 'status' });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('keeps the request ID after reopening the source task', async () => {
    requestFork.mockResolvedValueOnce({ state: 'unknown' }).mockResolvedValueOnce({ state: 'complete', session: { id: 'found' } });
    const first = renderHook(() => useForkRecovery(input()));
    await act(async () => first.result.current.run('anchor'));
    const initial = requestFork.mock.calls[0]![0];
    first.unmount();
    const reopened = renderHook(() => useForkRecovery(input()));
    await act(async () => reopened.result.current.run('anchor'));
    expect(requestFork.mock.calls[1]![0].requestId).toBe(initial.requestId);
    expect(complete).toHaveBeenCalledExactlyOnceWith({ id: 'found' }, undefined, undefined);
  });
  it('keeps old-host choices explicit and never sends an ignored target', async () => {
    capabilities.mockRejectedValue(new Error('[INVALID_PARAMS] old host'));
    legacyFork.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useForkRecovery(input()));
    await act(async () => result.current.run('anchor'));
    await press('session.forkRecovery.update');
    expect(onError).toHaveBeenCalledWith('session.forkRecovery.update');
    expect(requestFork).not.toHaveBeenCalled(); expect(picker).not.toHaveBeenCalled();
  });
  it.each(['owner/other-device/source', 'owner/device/other-source', 'owner/device/source/new-generation'])('discards a late result after scope changes to %s', async scope => {
    let finish!: (value: unknown) => void;
    requestFork.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({ scope }) => useForkRecovery(input(scope)), { initialProps: { scope: 'original' } });
    let running!: Promise<void>;
    await act(async () => { running = result.current.run('anchor'); });
    rerender({ scope });
    await act(async () => { finish({ state: 'complete', session: { id: 'stale' } }); await running; });
    expect(complete).not.toHaveBeenCalled(); expect(alert).not.toHaveBeenCalled();
  });
  it('coalesces a duplicate tap and suppresses navigation after leaving the page', async () => {
    let finish!: (value: unknown) => void;
    requestFork.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useForkRecovery(input()));
    let running!: Promise<void>;
    await act(async () => { running = result.current.run('anchor'); await result.current.run('anchor'); });
    expect(requestFork).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { finish({ state: 'complete', session: { id: 'stale' } }); await running; });
    expect(complete).not.toHaveBeenCalled();
  });
});
