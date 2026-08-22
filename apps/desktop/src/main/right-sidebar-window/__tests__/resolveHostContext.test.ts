import { describe, expect, it } from 'vitest';

import {
  contextFromDeviceLinkMirror,
  contextFromLocalSessionRow,
} from '../resolveHostContext.js';

describe('resolveHostContext mappers', () => {
  it('marks a local session row as confirmed non-device-link', () => {
    expect(
      contextFromLocalSessionRow({
        id: 'local-1',
        workingDir: '/repo',
        remoteHostId: 'ssh-1',
        agentKind: 'pi',
      }),
    ).toEqual({
      sessionId: 'local-1',
      workdir: '/repo',
      remoteHostId: 'ssh-1',
      deviceLinkDeviceId: null,
      available: true,
      subagentsAvailable: true,
    });
  });

  it('fills device-link context from the main mirror list', () => {
    expect(
      contextFromDeviceLinkMirror('device-9', {
        id: 'remote-1',
        workingDir: '/remote/app',
        agentKind: 'pi',
      }),
    ).toEqual({
      sessionId: 'remote-1',
      workdir: '/remote/app',
      remoteHostId: null,
      deviceLinkDeviceId: 'device-9',
      available: true,
      subagentsAvailable: true,
    });
  });
});
