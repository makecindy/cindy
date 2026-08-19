import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import { buildNewMakerSessionSeed } from '@/features/cc-agent/lib/newMakerSessionSeed';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    title: 'Source task',
    workingDir: '/Users/demo/project',
    workspaceKind: 'project',
    model: 'model-x',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: true,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    status: 'active',
    agentKind: 'codex',
    extraDirs: ['/Users/demo/secrets'],
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    providerId: 'openai',
    planModeEnabled: true,
    ...overrides,
  } as Session;
}

describe('buildNewMakerSessionSeed', () => {
  it('seeds a generic project task with its current runtime and SSH target', () => {
    expect(
      buildNewMakerSessionSeed(
        makeSession({ remoteHostId: 'remote-host' }),
        { mode: 'generic' },
      ),
    ).toEqual({
      target: {
        deviceId: null,
        deviceName: null,
        workingDir: '/Users/demo/project',
        remoteHostId: 'remote-host',
      },
      runtime: {
        vendor: 'codex',
        model: 'model-x',
        effort: 'high',
        providerId: 'openai',
        permissionMode: 'bypassPermissions',
        planMode: true,
        fastMode: true,
      },
    });
  });

  it('keeps dialogue workspace clean while preserving runtime from the same device', () => {
    expect(
      buildNewMakerSessionSeed(
        makeSession({
          deviceLinkDeviceId: 'device-a',
          deviceLinkDeviceName: 'Device A',
          remoteHostId: 'remote-host',
        }),
        {
          mode: 'dialogue',
          dialogueTarget: { deviceId: 'device-a', deviceName: 'Device A' },
        },
      ),
    ).toMatchObject({
      target: {
        deviceId: 'device-a',
        deviceName: 'Device A',
        workingDir: null,
        remoteHostId: null,
      },
      runtime: { vendor: 'codex', model: 'model-x' },
    });
  });

  it('does not turn a dialogue task internal directory into a new project target', () => {
    expect(
      buildNewMakerSessionSeed(
        makeSession({
          workspaceKind: 'dialogue',
          workingDir: '/internal/dialogue/dir',
          remoteHostId: 'remote-host',
        }),
        { mode: 'generic' },
      ).target,
    ).toMatchObject({
      deviceId: null,
      workingDir: null,
      remoteHostId: null,
    });
  });

  it('does not treat a nested device-link SSH directory as a local device path', () => {
    expect(
      buildNewMakerSessionSeed(
        makeSession({
          deviceLinkDeviceId: 'device-a',
          deviceLinkDeviceName: 'Device A',
          remoteHostId: 'nested-ssh-host',
        }),
        { mode: 'generic' },
      ).target,
    ).toMatchObject({
      deviceId: 'device-a',
      deviceName: 'Device A',
      workingDir: null,
      remoteHostId: null,
    });
  });

  it('normalizes legacy remote task fields before building route state', () => {
    const legacySession = {
      ...makeSession(),
      workspaceKind: undefined,
      effort: null,
      permissionMode: null,
    } as unknown as Session;

    expect(
      buildNewMakerSessionSeed(legacySession, { mode: 'generic' }).runtime,
    ).toMatchObject({
      vendor: 'codex',
      model: 'model-x',
      effort: 'high',
      permissionMode: 'auto',
    });
  });

  it('keeps a legacy remote project directory when workspaceKind is missing', () => {
    const legacySession = {
      ...makeSession(),
      workspaceKind: undefined,
    } as unknown as Session;

    expect(
      buildNewMakerSessionSeed(legacySession, { mode: 'generic' }).target,
    ).toMatchObject({
      deviceId: null,
      workingDir: '/Users/demo/project',
      remoteHostId: null,
    });
  });

  it('falls back to the current-engine defaults for legacy Claude runtime fields', () => {
    const legacySession = {
      ...makeSession({ agentKind: 'cc' }),
      effort: null,
      permissionMode: null,
    } as unknown as Session;

    expect(buildNewMakerSessionSeed(legacySession, { mode: 'generic' }).runtime)
      .toMatchObject({ effort: 'medium', permissionMode: 'auto' });
  });
});
