import { describe, expect, it } from 'vitest';

import { buildWorkLouderCodexPublishedTasks } from '../workLouderCodexTaskPublish';

describe('buildWorkLouderCodexPublishedTasks', () => {
  it('attaches connected remote phases with a device-scoped identity', () => {
    const activity = new Map([
      ['device-a:same-session', { phase: 'running' as const, attention: false }],
      ['device-b:same-session', { phase: 'error' as const, attention: true }],
      ['device-offline:same-session', { phase: 'completed' as const, attention: true }],
    ]);
    const tasks = buildWorkLouderCodexPublishedTasks(
      [
        {
          id: 'same-session',
          title: 'Local',
          pinnedAt: null,
          userSendAt: null,
          status: 'active',
        },
        {
          id: 'same-session',
          title: 'Device A',
          pinnedAt: null,
          userSendAt: null,
          status: 'active',
          deviceLinkDeviceId: 'device-a',
          deviceLinkConnectionStatus: 'connected',
        },
        {
          id: 'same-session',
          title: 'Device B',
          pinnedAt: null,
          userSendAt: null,
          status: 'active',
          deviceLinkDeviceId: 'device-b',
          deviceLinkConnectionStatus: 'connected',
        },
        {
          id: 'same-session',
          title: 'Offline',
          pinnedAt: null,
          userSendAt: null,
          status: 'active',
          deviceLinkDeviceId: 'device-offline',
          deviceLinkConnectionStatus: 'disconnected',
        },
      ],
      new Map<string, number>([['same-session', 0]]),
      (sessionId, deviceId) => activity.get(`${deviceId}:${sessionId}`),
    );

    expect(tasks[0]).not.toHaveProperty('deviceLinkDeviceId');
    expect(tasks[0]).not.toHaveProperty('remoteActivity');
    expect(tasks[1]).toMatchObject({
      deviceLinkDeviceId: 'device-a',
      remoteActivity: { phase: 'running', attention: false },
    });
    expect(tasks[2]).toMatchObject({
      deviceLinkDeviceId: 'device-b',
      remoteActivity: { phase: 'error', attention: true },
    });
    expect(tasks[3]).toMatchObject({ deviceLinkDeviceId: 'device-offline' });
    expect(tasks[3]).not.toHaveProperty('remoteActivity');
  });

  it('changes the publish payload when only a remote phase changes', () => {
    const session = {
      id: 'remote-session',
      title: 'Remote',
      pinnedAt: null,
      userSendAt: null,
      status: 'active',
      deviceLinkDeviceId: 'device-a',
      deviceLinkConnectionStatus: 'connected' as const,
    };
    const running = buildWorkLouderCodexPublishedTasks([session], new Map(), () => ({
      phase: 'running',
      attention: false,
    }));
    const completed = buildWorkLouderCodexPublishedTasks([session], new Map(), () => ({
      phase: 'completed',
      attention: true,
    }));

    expect(JSON.stringify(running)).not.toBe(JSON.stringify(completed));
    expect(completed[0]?.remoteActivity).toEqual({ phase: 'completed', attention: true });
  });
});
