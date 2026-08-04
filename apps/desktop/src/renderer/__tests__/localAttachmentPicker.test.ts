import { describe, expect, it } from 'vitest';

import { canUseLocalAttachmentPicker } from '../components/new-chat/localAttachmentPicker';

describe('canUseLocalAttachmentPicker', () => {
  it('allows a local new-chat draft before a session exists', () => {
    expect(canUseLocalAttachmentPicker({})).toBe(true);
  });

  it('waits for an existing session identity before exposing controller-local files', () => {
    expect(
      canUseLocalAttachmentPicker({
        sessionId: 'session-loading',
        runtimeAgentKind: null,
      }),
    ).toBe(false);
  });

  it('allows an existing session after its local runtime identity resolves', () => {
    expect(
      canUseLocalAttachmentPicker({
        sessionId: 'session-local',
        runtimeAgentKind: 'claude-code',
      }),
    ).toBe(true);
  });

  it('rejects SSH and device-link execution contexts', () => {
    expect(
      canUseLocalAttachmentPicker({
        sessionId: 'session-ssh',
        runtimeAgentKind: 'claude-code',
        remoteHostId: 'ssh-host',
      }),
    ).toBe(false);
    expect(
      canUseLocalAttachmentPicker({
        runtimeAgentKind: 'codex',
        deviceLinkDeviceId: 'remote-device',
      }),
    ).toBe(false);
  });
});
