import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  on: new Map<string, Function>(),
  handle: new Map<string, Function>(),
  owner: 'a',
  trusted: true,
  remote: true,
}));
vi.mock('electron', () => ({
  ipcMain: {
    on: (key: string, fn: Function) => h.on.set(key, fn),
    handle: (key: string, fn: Function) => h.handle.set(key, fn),
  },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) throw new Error('untrusted');
  },
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: h.owner, ownerGeneration: 1 }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../device-link/invoke-context.js', () => ({ isDeviceLinkInvoke: () => h.remote }));
import { registerModelFavoritesSync } from '../modelFavoritesSync';
import { MODEL_FAVORITES_APPLY, MODEL_FAVORITES_GET } from '@cindy/device-link';
import {
  FAVORITE_HOST_READY,
  FAVORITE_HOST_REPLY,
  FAVORITE_HOST_CHANGED,
} from '../../../shared/modelFavoritesSync';
const item = { uid: 'fav-1', providerId: 'account', modelId: 'model', agent: 'codex' };
let host: any, broadcast: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.on.clear();
  h.handle.clear();
  h.owner = 'a';
  h.trusted = true;
  h.remote = true;
  vi.useFakeTimers();
  broadcast = vi.fn();
  registerModelFavoritesSync(broadcast);
  host = { id: 1, once: vi.fn(), isDestroyed: () => false, send: vi.fn() };
  h.on.get(FAVORITE_HOST_READY)!({ sender: host });
});
afterEach(() => vi.useRealTimers());
it('waits for the selected host persistence acknowledgement, ignoring another renderer', async () => {
  const result = h.handle.get(MODEL_FAVORITES_APPLY)!({}, { kind: 'add', item });
  const request = host.send.mock.calls[0][1];
  let done = false;
  void result.then(() => {
    done = true;
  });
  h.on.get(FAVORITE_HOST_REPLY)!(
    { sender: { id: 2 } },
    { requestId: request.requestId, items: [item] },
  );
  await Promise.resolve();
  expect(done).toBe(false);
  h.on.get(FAVORITE_HOST_REPLY)!({ sender: host }, { requestId: request.requestId, items: [item] });
  expect(await result).toEqual([item]);
});
it('rejects late acknowledgements across owner changes', async () => {
  const result = h.handle.get(MODEL_FAVORITES_GET)!({});
  const rejected = expect(result).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  h.owner = 'b';
  h.on.get(FAVORITE_HOST_REPLY)!(
    { sender: host },
    { requestId: host.send.mock.calls[0][1].requestId, items: [item] },
  );
  await rejected;
});
it('times out without replaying a mutation', async () => {
  const result = h.handle.get(MODEL_FAVORITES_APPLY)!({}, { kind: 'add', item });
  const rejected = expect(result).rejects.toMatchObject({ code: 'DEVICE_LINK_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(8000);
  await rejected;
  expect(host.send).toHaveBeenCalledTimes(1);
});
it('rejects untrusted local invocations and stale-owner invalidations', () => {
  h.remote = false;
  h.trusted = false;
  expect(() => h.handle.get(MODEL_FAVORITES_GET)!({})).toThrow('untrusted');
  h.trusted = true;
  h.on.get(FAVORITE_HOST_CHANGED)!({ sender: host }, { dataOwnerId: 'b', ownerGeneration: 1 });
  expect(broadcast).not.toHaveBeenCalled();
});
it('codes invalid input and missing hosts without dispatching mutations', async () => {
  await expect(h.handle.get(MODEL_FAVORITES_APPLY)!({}, { kind: 'invalid' }))
    .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(host.send).not.toHaveBeenCalled();
  host.isDestroyed = () => true;
  await expect(h.handle.get(MODEL_FAVORITES_GET)!({}))
    .rejects.toMatchObject({ code: 'DEVICE_LINK_UNAVAILABLE' });
});
it.each([true, false])('codes host rejection or malformed reply (rejected=%s)', async failed => {
  const result = h.handle.get(MODEL_FAVORITES_GET)!({});
  const checked = expect(result).rejects.toMatchObject({ code: failed ? 'PRECONDITION_FAILED' : 'INTERNAL' });
  h.on.get(FAVORITE_HOST_REPLY)!({ sender: host }, {
    requestId: host.send.mock.calls[0][1].requestId, failed, items: 'invalid',
  });
  await checked;
});
