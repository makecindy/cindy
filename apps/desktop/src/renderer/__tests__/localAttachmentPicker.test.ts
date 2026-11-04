import { describe, expect, it } from 'vitest';

import { canUseLocalAttachmentPicker } from '../components/new-chat/localAttachmentPicker';

describe('canUseLocalAttachmentPicker', () => {
  // ZCode's native adapter currently accepts text only, including through
  // device-link. Do not offer a file picker that its send contract rejects.
  it('hides attachments for a text-only ZCode task on either execution surface', () => {
    expect(canUseLocalAttachmentPicker({ runtimeAgentKind: 'zcode' })).toBe(false);
    expect(canUseLocalAttachmentPicker({ runtimeAgentKind: 'zcode', deviceLinkDeviceId: 'host' })).toBe(false);
  });
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

  it('keeps SSH excluded and allows device-link uploads', () => {
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
    ).toBe(true);
  });
});
