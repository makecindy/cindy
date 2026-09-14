import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SKILL_LIST_FAILURE_MESSAGE,
  assertAgentSkillListIpcCaller,
  toAgentSkillListFailure,
} from '../agentSkillListIpcBoundary.js';

function createDeps(deviceLink: boolean) {
  return {
    isDeviceLinkInvoke: vi.fn(() => deviceLink),
    assertTrustedSender: vi.fn(),
    reportError: vi.fn(),
  };
}

describe('agent skill list IPC boundary', () => {
  it('requires a trusted registered app Renderer for local invokes', () => {
    const deps = createDeps(false);
    const event = { sender: 'app-window' };

    assertAgentSkillListIpcCaller(event, deps);
    expect(deps.assertTrustedSender).toHaveBeenCalledWith(event);
  });

  it('rejects an untrusted local sender before package inspection or session reads start', () => {
    const deps = createDeps(false);
    const denied = new Error('[PERMISSION_DENIED] untrusted auxiliary window');
    deps.assertTrustedSender.mockImplementation(() => {
      throw denied;
    });

    expect(() => assertAgentSkillListIpcCaller({}, deps)).toThrow(denied);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it('accepts the authenticated Main-owned device-link dispatch context without an Electron sender', () => {
    const deps = createDeps(true);

    assertAgentSkillListIpcCaller({}, deps);
    expect(deps.assertTrustedSender).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'logs the original %s-source failure locally but returns one stable redacted contract',
    (deviceLink) => {
      const deps = createDeps(deviceLink);
      const sensitive = new Error(
        'SQLITE_IOERR opening /Users/chris/Library/Application Support/Cindy/private.db',
      );

      const result = toAgentSkillListFailure(sensitive, deps);

      expect(deps.reportError).toHaveBeenCalledWith(sensitive);
      expect(result).toEqual({
        success: false,
        error: AGENT_SKILL_LIST_FAILURE_MESSAGE,
        skills: [],
      });
      expect(JSON.stringify(result)).not.toContain('/Users/chris');
      expect(JSON.stringify(result)).not.toContain('SQLITE_IOERR');
    },
  );
});
