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
        remoteHostId: null,
        agentKind: 'pi',
      }),
    ).toEqual({
      sessionId: 'local-1',
      workdir: '/repo',
      remoteHostId: null,
      deviceLinkDeviceId: null,
      available: true,
      subagentsAvailable: true,
    });
  });

  it('does not enable Subagents for an SSH-hosted Pi session', () => {
    expect(
      contextFromLocalSessionRow({
        id: 'ssh-1',
        workingDir: '/remote/repo',
        remoteHostId: 'host-1',
        agentKind: 'pi',
      }).subagentsAvailable,
    ).toBe(false);
  });

  it('passes a linked Bot owner for pinned local sessions without exposing profiles', () => {
    expect(contextFromLocalSessionRow({
      id: 'bot-main', workingDir: '/repo', remoteHostId: null, agentKind: 'codex',
      botId: 'bot-1', botRole: 'canonical',
    }).botOwner).toEqual({ botId: 'bot-1', canonical: true });
    expect(contextFromLocalSessionRow({
      id: 'bot-history', workingDir: '/repo', remoteHostId: null, agentKind: 'codex',
      botId: 'bot-1', botRole: 'history',
    }).botOwner).toEqual({ botId: 'bot-1', canonical: false });
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
      subagentsAvailable: false,
    });
  });

  it('does not advertise Subagents for a mirrored Pi session', () => {
    expect(
      contextFromDeviceLinkMirror('device-9', {
        id: 'remote-ssh',
        workingDir: '/remote/app',
        agentKind: 'pi',
      })?.subagentsAvailable,
    ).toBe(false);
  });

  it('leaves a truncated device-link workdir unresolved', () => {
    expect(
      contextFromDeviceLinkMirror('device-9', {
        id: 'remote-1',
        workingDir: `/${'a'.repeat(239)}`,
        agentKind: 'pi',
      })?.workdir,
    ).toBeNull();
    expect(
      contextFromDeviceLinkMirror('device-9', {
        id: 'remote-1',
        worktreePath: `/${'b'.repeat(239)}`,
        agentKind: 'codex',
      })?.workdir,
    ).toBeNull();
  });
});
