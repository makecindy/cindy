// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudInstanceView } from '../../../../shared/cloudInstanceControl';
import { useCloudInstances, type CloudInstancesApi } from '../useCloudInstances';

// Unit: claims, sign-ins and sleep/wake requests are sent at most once; unknown results are read back.
const confirmation = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => confirmation }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const target: CloudInstanceView = {
  instanceId: 'example-instance',
  deviceId: 'example-device',
  name: 'Cloud A',
  nameSequence: 1,
  ordinal: null,
  desiredState: 'running',
  runtimeState: 'missing',
  ready: false,
  loginRequired: true,
  version: '1.0.0',
  imageId: null,
  latestVersion: '1.0.0',
  updateAvailable: false,
  upgradeState: 'idle',
  observedAtMs: null,
  maintenance: null,
};
const running: CloudInstanceView = { ...target, loginRequired: false, ready: true, runtimeState: 'running' };
const sleeping: CloudInstanceView = { ...running, desiredState: 'stopped', runtimeState: 'stopped', ready: false };

async function setup(items: CloudInstanceView[]) {
  let complete = () => {};
  const unsubscribe = vi.fn();
  const api = {
    instanceList: vi.fn<CloudInstancesApi['instanceList']>().mockResolvedValue(items),
    instanceClaim: vi.fn<CloudInstancesApi['instanceClaim']>().mockResolvedValue([target]),
    instanceInitialize: vi.fn<CloudInstancesApi['instanceInitialize']>().mockResolvedValue(),
    instancePower: vi.fn<CloudInstancesApi['instancePower']>().mockResolvedValue(),
    onLoginCompleted: (cb: () => void) => ((complete = cb), unsubscribe),
  };
  const onOpen = vi.fn();
  const hook = renderHook(() => useCloudInstances(api, onOpen));
  await waitFor(() => expect(hook.result.current.instances).toEqual(items));
  return { api, onOpen, unsubscribe, complete: () => complete(), ...hook };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  confirmation.confirm.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Unit: a minimised window keeps document.visibilityState visible when background throttling is
// off; the host's hidden mark alone stops the list polls, and coming back reads it once.
it('reads nothing while the host has hidden the window, then reads once when it is shown', async () => {
  const f = await setup([running]);
  f.api.instanceList.mockClear();
  document.documentElement.setAttribute('data-app-hidden', '');
  try {
    expect(document.visibilityState).not.toBe('hidden');
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(f.api.instanceList).not.toHaveBeenCalled();
  } finally {
    await act(async () => { document.documentElement.removeAttribute('data-app-hidden'); });
  }
  await waitFor(() => expect(f.api.instanceList).toHaveBeenCalledTimes(1));
});

// Unit: a throttled list read waits for the service's time; polls and reloads in between send
// nothing, and the next read goes out once the wait is over.
it('waits out a throttled list read before reading the list again', async () => {
  const f = await setup([running]);
  f.api.instanceList.mockClear();
  f.api.instanceList.mockRejectedValueOnce(new Error('[CLOUD_SETTINGS_BUSY] CLOUD_SETTINGS_BUSY retryAfterMs=90000'));
  await act(async () => { await f.result.current.load(true); });
  expect(f.api.instanceList).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  await act(async () => { await f.result.current.load(true); });
  expect(f.api.instanceList).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  await act(async () => { await f.result.current.load(true); });
  expect(f.api.instanceList.mock.calls.length).toBeGreaterThan(1);
});

it('reading the list claims, signs in and wakes nothing', async () => {
  const f = await setup([target, sleeping]);
  expect(f.api.instanceClaim).not.toHaveBeenCalled();
  expect(f.api.instanceInitialize).not.toHaveBeenCalled();
  expect(f.api.instancePower).not.toHaveBeenCalled();
});

it('a claim asked twice is sent once and signs in only the returned instance', async () => {
  const f = await setup([]);
  await act(async () => {
    await Promise.all([f.result.current.act(true), f.result.current.act(true)]);
  });
  expect(f.api.instanceClaim).toHaveBeenCalledTimes(1);
  expect(f.api.instanceInitialize).toHaveBeenCalledExactlyOnceWith({ deviceId: target.deviceId });
  expect(f.onOpen).not.toHaveBeenCalled();
});

it('an unknown claim is read back from the list and never claimed again', async () => {
  const f = await setup([]);
  f.api.instanceClaim.mockRejectedValue(Error('unknown'));
  await act(() => f.result.current.act(true));
  expect(f.result.current.claim).toBe('checking');
  await act(() => f.result.current.act(true));
  f.api.instanceList.mockResolvedValue([target]);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(f.result.current.claim).toBeUndefined();
  expect(f.api.instanceClaim).toHaveBeenCalledTimes(1);
  expect(f.api.instanceInitialize).not.toHaveBeenCalled();
});

it('a refused claim says why and is not read back', async () => {
  const f = await setup([]);
  f.api.instanceClaim.mockRejectedValue(Error('[CLOUD_SETTINGS_ADMISSION_NOT_LISTED] refused'));
  await act(() => f.result.current.act(true));
  expect(f.result.current.error).toContain('CLOUD_SETTINGS_ADMISSION_NOT_LISTED');
  expect(f.result.current.claim).toBeUndefined();
});

it('a claim answered after leaving signs in nothing', async () => {
  const f = await setup([]);
  let resolve!: (value: CloudInstanceView[]) => void;
  f.api.instanceClaim.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const claiming = f.result.current.act(true);
  f.unmount();
  resolve([target]);
  await claiming;
  expect(f.api.instanceInitialize).not.toHaveBeenCalled();
});

it.each(['declined', 'left'])('sleep sends nothing when the confirmation is %s', async (how) => {
  let finish!: (value: boolean) => void;
  confirmation.confirm.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
  const f = await setup([running]);
  const asked = f.result.current.power(running, 'Cloud A');
  if (how === 'left') f.unmount();
  await act(async () => {
    finish(how === 'left');
    await asked;
  });
  expect(f.api.instancePower).not.toHaveBeenCalled();
});

it('an unknown wake is read back, never sent again, and read once more on request', async () => {
  const f = await setup([sleeping]);
  f.api.instancePower.mockRejectedValueOnce(Error('unconfirmed'));
  f.api.instanceList.mockRejectedValue(Error('offline'));
  await act(() => f.result.current.power(sleeping, 'Cloud A'));
  await act(() => f.result.current.power(sleeping, 'Cloud A'));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(f.result.current.powerNote(sleeping.deviceId)?.kind).toBe('unreadable');
  f.api.instanceList.mockResolvedValue([running]);
  await act(async () => f.result.current.reloadPower(sleeping.deviceId));
  await waitFor(() => expect(f.result.current.powerNote(sleeping.deviceId)).toBeUndefined());
  expect(f.api.instancePower).toHaveBeenCalledTimes(1);
});

it('a finished sign-in refreshes the list without navigating, and stops listening on leave', async () => {
  const f = await setup([target]);
  await act(() => f.result.current.act(false, target.deviceId));
  f.api.instanceList.mockResolvedValue([running]);
  await act(async () => f.complete());
  await waitFor(() => expect(f.result.current.instances).toEqual([running]));
  expect(f.onOpen).not.toHaveBeenCalled();
  f.unmount();
  expect(f.unsubscribe).toHaveBeenCalled();
});
