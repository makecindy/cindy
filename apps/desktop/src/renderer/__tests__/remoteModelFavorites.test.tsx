// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useRemoteModelFavorites, __resetRemoteModelFavoritesCacheForTest } from '@/state/useRemoteModelFavorites';
const item = {
  uid: 'fav-2',
  providerId: 'remote-account',
  modelId: 'model',
  agent: 'codex' as const,
  effort: 'high' as const,
};
let root: ReturnType<typeof createRoot>, view: ReturnType<typeof useRemoteModelFavorites>;
let invoke: ReturnType<typeof vi.fn>, push: (event: any) => void;
let statusChanged: () => void, peerReset: (event: any) => void, responsive: (event: any) => void;
function Probe({ device = 'a' }: { device?: string }) {
  view = useRemoteModelFavorites(device);
  return null;
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  invoke = vi.fn(async () => [item]);
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        invoke,
        onRemotePush: (fn: any) => {
          push = fn;
          return vi.fn();
        },
        onStatusChanged: (fn: any) => { statusChanged = fn; return vi.fn(); },
        onPeerLinkReset: (fn: any) => { peerReset = fn; return vi.fn(); },
        onResponsivenessChanged: (fn: any) => { responsive = fn; return vi.fn(); },
      },
    },
  });
  __resetRemoteModelFavoritesCacheForTest();
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));
// 回归:远控时模型面板每次打开都重新挂载，收藏从空列表开始、等读回来才出现。
// 重新挂载先显示上次读到的收藏，后台读到新的再替换。
it('a freshly mounted panel shows the last favorites while the fresh read is in flight', async () => {
  await act(async () => root.render(createElement(Probe, {})));
  act(() => root.unmount());
  root = createRoot(document.createElement('div'));
  let resolve!: (v: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  await act(async () => root.render(createElement(Probe, {})));
  expect(view.items).toEqual([item]);
  await act(async () => resolve([{ ...item, effort: 'low' }]));
  expect(view.items[0]?.effort).toBe('low');
});
it('does not refresh for an opened or administratively cleared breaker', async () => {
  await act(async () => root.render(createElement(Probe, {})));
  invoke.mockClear();
  await act(async () => {
    responsive({ deviceId: 'a', unresponsive: true, recovered: false });
    responsive({ deviceId: 'a', unresponsive: false, recovered: false });
  });
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => responsive({ deviceId: 'a', unresponsive: false, recovered: true }));
  expect(invoke).toHaveBeenCalledTimes(1);
});
it.each(['status', 'peer', 'responsive'])('retains keyed favorites on failed %s refresh and replaces only on success', async event => {
  await act(async () => root.render(createElement(Probe, {})));
  const refresh = () => event === 'status' ? statusChanged()
    : event === 'peer' ? peerReset({ deviceId: 'a' }) : responsive({ deviceId: 'a' });
  invoke.mockRejectedValueOnce(new Error('offline'));
  await act(async () => refresh());
  expect(view.items).toEqual([item]);
  expect(view.error).toBe(true);
  invoke.mockResolvedValue([]);
  await act(async () => refresh());
  expect(view.items).toEqual([]);
  expect(view.error).toBe(false);
});
it('records DEVICE_LINK connection error codes and clears them after a successful refresh', async () => {
  await act(async () => root.render(createElement(Probe, {})));
  invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_NOT_CONNECTED] offline'));
  await act(async () => statusChanged());
  expect(view.error).toBe(true);
  expect(view.errorCode).toBe('DEVICE_LINK_NOT_CONNECTED');
  invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old host'));
  await act(async () => statusChanged());
  expect(view.errorCode).toBe('DEVICE_LINK_CHANNEL_NOT_ALLOWED');
  invoke.mockResolvedValue([]);
  await act(async () => statusChanged());
  expect(view.error).toBe(false);
  expect(view.errorCode).toBeNull();
});
it('remote favorite add/update/remove use remote operations, never browser storage', async () => {
  const local = vi.spyOn(Storage.prototype, 'setItem');
  await act(async () => root.render(createElement(Probe, {})));
  expect(view.items).toEqual([item]);
  await act(async () => view.store.update(item.uid, { effort: 'low' }));
  expect(invoke).toHaveBeenCalledWith('a', 'maker:model-favorites:apply', [
    { kind: 'update', expected: item, item: { ...item, effort: 'low', fast: undefined } },
  ]);
  await act(async () => view.store.remove(item.uid));
  expect(invoke).toHaveBeenCalledWith('a', 'maker:model-favorites:apply', [
    { kind: 'remove', expected: item },
  ]);
  await act(async () => view.store.add(item));
  expect(invoke).toHaveBeenCalledWith('a', 'maker:model-favorites:apply', [{ kind: 'add', item }]);
  expect(local).not.toHaveBeenCalled();
  local.mockRestore();
});
it('refreshes only matching remote invalidations and ignores late reads from another device', async () => {
  let resolve!: (v: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await act(async () => root.render(createElement(Probe, {})));
  invoke.mockResolvedValue([{ ...item, providerId: 'device-b' }]);
  await act(async () => root.render(createElement(Probe, { device: 'b' })));
  await act(async () => resolve([item]));
  expect(view.items[0]?.providerId).toBe('device-b');
  const count = invoke.mock.calls.length;
  await act(async () => push({ deviceId: 'a', channel: 'maker:model-favorites:changed' }));
  expect(invoke).toHaveBeenCalledTimes(count);
  invoke.mockResolvedValue([]);
  await act(async () => push({ deviceId: 'b', channel: 'maker:model-favorites:changed' }));
  expect(view.items).toEqual([]);
});
it('does not resolve a favorite write until the host acknowledges it', async () => {
  await act(async () => root.render(createElement(Probe, {})));
  let reject!: (error: Error) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((_r, j) => {
        reject = j;
      }),
  );
  let saved = false;
  const request = view.store.remove(item.uid) as Promise<void>;
  const checked = expect(
    request.then(() => {
      saved = true;
    }),
  ).rejects.toThrow('offline');
  await act(async () => {
    reject(new Error('offline'));
    await checked;
  });
  expect(saved).toBe(false);
  expect(view.error).toBe(true);
});
