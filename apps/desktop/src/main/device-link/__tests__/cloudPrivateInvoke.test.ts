/**
 * The private cloud channels (provider settings, prompt, IM settings) exist only when
 * a managed cloud runtime registers them, serve same-account computers only and keep their ordinary
 * behavior otherwise.
 */
import { providerShareGuestPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  access: null as null | { shareId: string; memberId: string; providerId: string },
}));

vi.mock('electron-store', () => ({ default: class {} }));
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/cindy-test/app',
    getPath: () => '/tmp/cindy-test',
    getVersion: () => '0.0.0-test',
  },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../settings-store.desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-store.desktop')>()),
  readDeviceLinkSettings: () => ({
    remoteControlEnabled: true,
    keepAwake: false,
    revokedControllers: [],
    disabledControlDeviceIds: [],
  }),
}));

import {
  __testing,
  runInvoke,
  setCloudPrivateInvokeHandler,
  setProviderShareAccess,
} from '../dispatch.desktop';

const CHANNEL = 'cloud:provider-settings:v1';
const GUEST = providerShareGuestPeer('share-1', 'member-1', 'laptop');

beforeEach(() => {
  __testing.reset();
  state.access = null;
  setProviderShareAccess({
    guestAccess: () => state.access,
    ensureKnown: async () => undefined,
    hasShares: () => false,
  });
});
afterEach(() => {
  __testing.reset();
  setProviderShareAccess(null);
});

describe('cloud private invoke channel', () => {
  it('is not allowed when no cloud runtime registered it', async () => {
    await expect(
      runInvoke('same-account-mac', { channel: CHANNEL, args: [{ op: 'list' }] }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
  });

  it('serves same-account computers only', async () => {
    const handle = vi.fn(async () => ({ version: 1 }));
    setCloudPrivateInvokeHandler({ channel: CHANNEL, handle });
    await expect(
      runInvoke('same-account-mac', { channel: CHANNEL, args: [{ op: 'list' }] }),
    ).resolves.toEqual({ ok: true, result: { version: 1 } });
    expect(handle).toHaveBeenCalledWith('same-account-mac', { op: 'list' });

    state.access = { shareId: 'share-1', memberId: 'member-1', providerId: 'anthropic' };
    handle.mockClear();
    await expect(
      runInvoke(GUEST, { channel: CHANNEL, args: [{ op: 'list' }] }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it('keeps coded errors and hides others', async () => {
    setCloudPrivateInvokeHandler({
      channel: CHANNEL,
      handle: async () => {
        throw new Error('[OWNER_CHANGED] refresh');
      },
    });
    await expect(runInvoke('same-account-mac', { channel: CHANNEL, args: [{}] })).resolves.toEqual({
      ok: false,
      error: { code: 'IPC_ERROR', message: '[OWNER_CHANGED] refresh' },
    });
    setCloudPrivateInvokeHandler({
      channel: CHANNEL,
      handle: async () => {
        throw new Error('/private/path leaked');
      },
    });
    await expect(runInvoke('same-account-mac', { channel: CHANNEL, args: [{}] })).resolves.toEqual({
      ok: false,
      error: { code: 'IPC_ERROR', message: '[INTERNAL] cloud request failed' },
    });
  });

  it('routes each registered channel to its own handler and clears them together', async () => {
    const providers = vi.fn(async () => 'providers');
    const prompt = vi.fn(async () => 'prompt');
    setCloudPrivateInvokeHandler({ channel: CHANNEL, handle: providers });
    setCloudPrivateInvokeHandler({ channel: 'cloud:personalization:v1', handle: prompt });
    await expect(
      runInvoke('same-account-mac', { channel: 'cloud:personalization:v1', args: [{ op: 'read' }] }),
    ).resolves.toEqual({ ok: true, result: 'prompt' });
    await expect(
      runInvoke('same-account-mac', { channel: CHANNEL, args: [{ op: 'list' }] }),
    ).resolves.toEqual({ ok: true, result: 'providers' });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(providers).toHaveBeenCalledTimes(1);
    setCloudPrivateInvokeHandler(null);
    for (const channel of [CHANNEL, 'cloud:personalization:v1'])
      await expect(runInvoke('same-account-mac', { channel, args: [{}] })).resolves.toMatchObject({
        ok: false,
        error: { code: 'CHANNEL_NOT_ALLOWED' },
      });
  });

  it('does not open any other unlisted channel', async () => {
    setCloudPrivateInvokeHandler({ channel: CHANNEL, handle: vi.fn() });
    await expect(
      runInvoke('same-account-mac', { channel: 'cloud:other', args: [] }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
  });
});
