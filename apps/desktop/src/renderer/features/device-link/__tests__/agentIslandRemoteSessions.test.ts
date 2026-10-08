import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import { buildAgentIslandRemoteSessionInputs } from '../agentIslandRemoteSessions';
import type { RemoteSessionActivity } from '../remoteSessionActivityStore';
import { MACHINE_ALL, MACHINE_LOCAL } from '../selectedMachineStore';

function remoteSession(id: string, deviceId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Task ${id}`,
    workingDir: '/Users/me/code/cindy',
    workspaceKind: 'project',
    agentKind: 'cc',
    deviceLinkDeviceId: deviceId,
    deviceLinkDeviceName: `Mac ${deviceId}`,
    deviceLinkConnectionStatus: 'connected',
    ...overrides,
  } as Session;
}

const activities = new Map<string, RemoteSessionActivity>([
  [
    'a-1',
    {
      sessionId: 'a-1',
      phase: 'running',
      compactDetail: 'Reading files',
      workingPhase: 'reading-file',
      attention: false,
    },
  ],
  [
    'b-1',
    {
      sessionId: 'b-1',
      phase: 'needs-interaction',
      compactDetail: '',
      interactionKind: 'permission',
      attention: true,
    },
  ],
  ['b-2', { sessionId: 'b-2', phase: 'completed', compactDetail: '', attention: true }],
]);
const readActivity = (sessionId: string): RemoteSessionActivity | undefined =>
  activities.get(sessionId);

describe('buildAgentIslandRemoteSessionInputs', () => {
  const sessions = [
    remoteSession('a-1', 'device-a'),
    remoteSession('a-idle', 'device-a'),
    remoteSession('b-1', 'device-b'),
    remoteSession('b-2', 'device-b', { title: '  ' }),
  ];

  it('includes every remote task with live activity under the "all" scope', () => {
    expect(buildAgentIslandRemoteSessionInputs(sessions, MACHINE_ALL, readActivity)).toEqual([
      {
        sessionId: 'a-1',
        deviceId: 'device-a',
        deviceName: 'Mac device-a',
        title: 'Task a-1',
        workingDir: '/Users/me/code/cindy',
        workspaceKind: 'project',
        agentKind: 'cc',
        phase: 'running',
        detail: 'Reading files',
        workingPhase: 'reading-file',
      },
      expect.objectContaining({
        sessionId: 'b-1',
        phase: 'needs-interaction',
        interactionKind: 'permission',
      }),
      expect.objectContaining({ sessionId: 'b-2', phase: 'completed', title: null }),
    ]);
  });

  it('follows the sidebar task scope', () => {
    expect(
      buildAgentIslandRemoteSessionInputs(sessions, ['device-b'], readActivity).map(
        (input) => input.sessionId,
      ),
    ).toEqual(['b-1', 'b-2']);
    expect(buildAgentIslandRemoteSessionInputs(sessions, [MACHINE_LOCAL], readActivity)).toEqual(
      [],
    );
  });

  it('skips Bot tasks and disconnected devices', () => {
    expect(
      buildAgentIslandRemoteSessionInputs(
        [
          remoteSession('a-1', 'device-a', { source: 'bot' }),
          remoteSession('b-1', 'device-b', { deviceLinkConnectionStatus: 'disconnected' }),
        ],
        MACHINE_ALL,
        readActivity,
      ),
    ).toEqual([]);
  });
});
