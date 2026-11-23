// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resetDeviceModelGroupsForTests, useDeviceModelGroups } from '@/features/model-groups/remoteModelGroups';

const routes = [{ id: 'daily', name: 'Daily coding', strategy: 'order', candidates: [] }];

let invoke: ReturnType<typeof vi.fn>;
let linkReset: ((event: { deviceId: string }) => void) | undefined;
let presence: ((snap: { deviceId: string; online: boolean }) => void) | undefined;

beforeEach(() => {
  resetDeviceModelGroupsForTests();
  setDataOwnerGeneration('owner', 1);
  invoke = vi.fn();
  linkReset = undefined;
  presence = undefined;
  Object.assign(window, { electronAPI: { deviceLink: {
    invoke,
    onPeerLinkReset: (cb: typeof linkReset) => { linkReset = cb; return () => {}; },
    onPresenceChanged: (cb: typeof presence) => { presence = cb; return () => {}; },
  } } });
});

afterEach(() => {
  setDataOwnerGeneration(null, 0);
  Reflect.deleteProperty(window, 'electronAPI');
});

// model-groups.md §6.3 and the protocol record: an old computer answers CHANNEL_NOT_ALLOWED and
// is remembered as unsupported so pickers stop asking. Coverage gap: nothing ever forgot that
// answer, so after the computer was upgraded its modes never appeared until this app restarted.
// Minimal input: one computer, first read rejected as not allowed, then it reconnects (link reset;
// separately, offline then online) on a version that answers. Tier: unit, real cache and hook.
it('asks an upgraded computer again after it reconnects', async () => {
  invoke.mockRejectedValueOnce(new Error('DEVICE_LINK_CHANNEL_NOT_ALLOWED'));
  const { result } = renderHook(() => useDeviceModelGroups('desk-2', true));
  await waitFor(() => expect(result.current.unsupported).toBe(true));
  // Still unsupported: opening the picker again does not ask.
  act(() => result.current.read());
  expect(invoke).toHaveBeenCalledTimes(1);

  invoke.mockResolvedValue({ routes });
  act(() => linkReset?.({ deviceId: 'desk-2' }));
  act(() => result.current.read());
  await waitFor(() => expect(result.current.config?.routes.map((route) => route.id)).toEqual(['daily']));
  expect(invoke).toHaveBeenLastCalledWith('desk-2', 'model-groups:get', []);

  // Repeated "online" pushes do not clear the answer; going offline does.
  act(() => presence?.({ deviceId: 'desk-2', online: true }));
  act(() => presence?.({ deviceId: 'desk-2', online: true }));
  expect(result.current.config).not.toBeNull();
  act(() => presence?.({ deviceId: 'desk-2', online: false }));
  expect(result.current.config).toBeNull();
});
