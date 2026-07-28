import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, PROTOCOL_VERSION, type Envelope } from '@cindy/device-link';
import {
  applyAccessRevokedFrame,
  isAccessRevokedError,
  withAccessRevokedHandling,
} from '@/device-link/accessRevoked';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { PendingInteraction, RemoteMessage, RemoteSession } from '@/session/types';

function session(id: string): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: id,
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function message(id: string, sessionId: string): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId,
    role: 'assistant',
    content: 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function pending(id: string): PendingInteraction {
  return { request: { kind: 'permission', requestId: id } };
}

describe('mobile device-link access revocation', () => {
  beforeEach(() => {
    remoteSessionStore.clear();
    revokedDevicesStore.clearAll();
  });

  it('recognizes protocol and desktop IPC revoked errors', () => {
    expect(isAccessRevokedError(new DeviceLinkError('ACCESS_REVOKED', 'revoked'))).toBe(true);
    expect(isAccessRevokedError({ code: 'ACCESS_REVOKED' })).toBe(true);
    expect(isAccessRevokedError(new Error('[DEVICE_LINK_ACCESS_REVOKED] revoked'))).toBe(true);
    expect(isAccessRevokedError(new DeviceLinkError('REMOTE_DISABLED', 'disabled'))).toBe(false);
  });

  it('marks the device revoked and removes mirrored sessions from link-close(revoked)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.mergeMessages('s1', [message('m1', 's1')]);
    remoteSessionStore.setPendingInteractions('s1', [pending('req-1')]);

    const env: Envelope = {
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-1',
      payload: { reason: 'revoked' },
    };

    expect(applyAccessRevokedFrame(env)).toBe(true);
    expect(revokedDevicesStore.has('dev-1')).toBe(true);
    expect(remoteSessionStore.getSessions()).toEqual([]);
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);
  });

  it('updates revoked mirror state around guarded operations', async () => {
    await expect(
      withAccessRevokedHandling('dev-1', async () => {
        throw new DeviceLinkError('ACCESS_REVOKED', 'revoked');
      }),
    ).rejects.toThrow('revoked');

    expect(revokedDevicesStore.has('dev-1')).toBe(true);

    await expect(withAccessRevokedHandling('dev-1', vi.fn(async () => 'ok'))).resolves.toBe('ok');
    expect(revokedDevicesStore.has('dev-1')).toBe(false);
  });
});

describe('撤权与「设备无响应」熔断的竞态(review P1)', () => {
  it('markDeviceAccessRevoked 清掉该设备的熔断状态与 UI 镜像', async () => {
    const { acquireDeviceSendSlot, settleDeviceSend, unresponsiveDevicesStore } =
      await import('@/device-link/unresponsiveDevicesStore');
    const { markDeviceAccessRevoked, clearDeviceAccessRevoked } =
      await import('@/device-link/accessRevoked');
    const dev = 'revoke-breaker-dev';
    clearDeviceAccessRevoked(dev);
    for (let i = 0; i < 3; i++) {
      const probe = acquireDeviceSendSlot(dev);
      settleDeviceSend(dev, probe, 'timeout');
    }
    expect(unresponsiveDevicesStore.has(dev)).toBe(true);

    markDeviceAccessRevoked(dev);
    expect(unresponsiveDevicesStore.has(dev)).toBe(false);
    clearDeviceAccessRevoked(dev);
  });

  it('已撤权设备的在途超时降级为不定论,不再把熔断重新打开', async () => {
    const { acquireDeviceSendSlot, settleDeviceSend, unresponsiveDevicesStore } =
      await import('@/device-link/unresponsiveDevicesStore');
    const { markDeviceAccessRevoked, clearDeviceAccessRevoked } =
      await import('@/device-link/accessRevoked');
    const dev = 'revoke-race-dev';
    clearDeviceAccessRevoked(dev);
    markDeviceAccessRevoked(dev);
    // link-close(revoked) 后,撤权前发出的在途请求陆续超时——不应计入熔断
    for (let i = 0; i < 5; i++) {
      const probe = acquireDeviceSendSlot(dev);
      settleDeviceSend(dev, probe, 'timeout');
    }
    expect(unresponsiveDevicesStore.has(dev)).toBe(false);
    clearDeviceAccessRevoked(dev);
  });
});
