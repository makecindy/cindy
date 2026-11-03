/**
 * backgroundTaskStop:后台任务管理入口的可见性判据 —— 本机与同账号远程会话有管理权,
 * 共享任务访客没有(房主保留后台任务管理权)。
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  devices: new Map<string, string>(),
}));

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (sessionId: string) => mocks.devices.get(sessionId),
}));
vi.mock('@/lib/makerTransport', () => ({
  stopAgentTaskFor: vi.fn(),
  stopSessionBackgroundTasksFor: vi.fn(),
}));

import { sharedTaskHostPeer } from '@cindy/device-link';

import { canManageBackgroundTasks } from '@/lib/backgroundTaskStop';

describe('canManageBackgroundTasks', () => {
  it('本机与同账号远程会话有管理权,共享任务访客没有', () => {
    mocks.devices = new Map([
      ['remote-s', 'own-device'],
      ['shared-s', sharedTaskHostPeer('m', 'desktop')],
    ]);
    expect(canManageBackgroundTasks('local-s')).toBe(true);
    expect(canManageBackgroundTasks('remote-s')).toBe(true);
    expect(canManageBackgroundTasks('shared-s')).toBe(false);
  });
});
