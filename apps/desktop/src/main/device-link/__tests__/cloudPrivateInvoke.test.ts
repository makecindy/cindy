/**
 * The private cloud channels (provider settings, prompt, IM settings) exist only when
 * a managed cloud runtime registers them, serve same-account computers only and keep their ordinary
 * behavior otherwise. The SSH access channel (device-link:ssh-access:v1) shares the same same-account admission and
 * is covered here so the heavy dispatcher graph loads once.
 */
import { SSH_ACCESS_CHANNEL, providerShareGuestPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  access: null as null | { shareId: string; memberId: string; providerId: string },
  settings: { remoteControlEnabled: true, keepAwake: false, revokedControllers: [] as string[], disabledControlDeviceIds: [] as string[] },
  sshTarget: null as null | { handleRemote: ReturnType<typeof vi.fn> },
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
  readDeviceLinkSettings: () => state.settings,
}));
vi.mock('../../ssh-access/sshAccessTarget.desktop', () => ({ currentSshAccessTarget: () => state.sshTarget }));

import {
  __testing,
  runInvoke,
  setCloudPrivateInvokeHandler,
  setProviderShareAccess,
} from '../dispatch.desktop';
import { clearControllerPlatforms, setControllerPlatform } from '../controllerPlatform';
import { SshAccessTargetError } from '../../ssh-access/sshAccessTargetCore';

const CHANNEL = 'cloud:provider-settings:v1';
const GUEST = providerShareGuestPeer('share-1', 'member-1', 'laptop');

beforeEach(() => {
  __testing.reset();
  clearControllerPlatforms();
  state.access = null;
  state.settings = { remoteControlEnabled: true, keepAwake: false, revokedControllers: [], disabledControlDeviceIds: [] };
  state.sshTarget = { handleRemote: vi.fn(async () => ({ version: 1, enabled: true })) };
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

// 测试价值
// - 生产入口与可观察结果：真实 dispatch 的 runInvoke 处理 device-link:ssh-access:v1：另一台电脑收到的回包，以及 SSH 访问
//   被控端（这里是替身，行为见 ssh-access/__tests__/sshAccessTargetCore.test.ts）是否被调用、以哪个设备 id 被调用。
// - Bug／规则依据：spec Protocol（只给同账号电脑、拒绝手机、沿用 REMOTE_DISABLED / ACCESS_REVOKED、被控端不在时
//   [SSH_ACCESS_UNAVAILABLE]）；engineering-conventions §2（只回协议错误码，不带路径）。
// - 现有覆盖缺口：新通道；上面的私有通道用例不覆盖手机、撤销与远控关。
// - 最小失败输入：供应商分享受邀者；platform=ios；撤销名单里的设备；远控关；被控端未创建；被控端抛出带路径的普通错误。
// - tier：unit（与本文件其它用例共用一次 dispatcher 加载）。
describe('SSH access channel admission', () => {
  const call = (src: string, request: unknown = { action: 'status' }) =>
    runInvoke(src, { channel: SSH_ACCESS_CHANNEL, args: [request] });

  it('passes a same-account desktop\'s request to the target under its own device id', async () => {
    setControllerPlatform('laptop', 'darwin');
    await expect(call('laptop', { action: 'withdraw', requestId: 'r-00000001' })).resolves.toEqual({ ok: true, result: { version: 1, enabled: true } });
    expect(state.sshTarget!.handleRemote).toHaveBeenCalledWith('laptop', { action: 'withdraw', requestId: 'r-00000001' });
  });

  it('refuses guests, phones, a disabled master switch and revoked devices before the target sees them', async () => {
    state.access = { shareId: 'share-1', memberId: 'member-1', providerId: 'anthropic' };
    await expect(call(GUEST)).resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
    setControllerPlatform('phone', 'ios');
    await expect(call('phone')).resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
    state.settings.revokedControllers = ['laptop'];
    await expect(call('laptop')).resolves.toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
    state.settings.remoteControlEnabled = false;
    await expect(call('studio')).resolves.toMatchObject({ ok: false, error: { code: 'REMOTE_DISABLED' } });
    expect(state.sshTarget!.handleRemote).not.toHaveBeenCalled();
  });

  it('answers SSH_ACCESS_UNAVAILABLE without a target and keeps only protocol codes from target errors', async () => {
    const target = state.sshTarget!;
    state.sshTarget = null;
    await expect(call('laptop')).resolves.toEqual({
      ok: false, error: { code: 'IPC_ERROR', message: '[SSH_ACCESS_UNAVAILABLE] ssh access is not available on this computer' },
    });
    state.sshTarget = target;
    target.handleRemote.mockRejectedValueOnce(new SshAccessTargetError('SSH_ACCESS_KEY_IN_USE', 'held by studio'));
    await expect(call('laptop')).resolves.toEqual({ ok: false, error: { code: 'IPC_ERROR', message: '[SSH_ACCESS_KEY_IN_USE] ssh access request failed' } });
    target.handleRemote.mockRejectedValueOnce(new Error('EACCES: /home/ubuntu/.ssh/authorized_keys'));
    await expect(call('laptop')).resolves.toEqual({ ok: false, error: { code: 'IPC_ERROR', message: '[SSH_ACCESS_UNAVAILABLE] ssh access request failed' } });
  });
});
