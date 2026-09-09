import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_COMMAND_LIST_FAILURE_MESSAGE,
  assertAgentCommandListIpcCaller,
  toAgentCommandListFailure,
} from '../agentCommandListIpcBoundary.js';

function createDeps(deviceLink: boolean) {
  return {
    isDeviceLinkInvoke: vi.fn(() => deviceLink),
    assertTrustedSender: vi.fn(),
    reportError: vi.fn(),
  };
}

describe('agent command list IPC boundary', () => {
  it('requires a trusted registered app Renderer for local invokes', async () => {
    const deps = createDeps(false);
    const event = { sender: 'app-window' };

    assertAgentCommandListIpcCaller(event, deps);
    expect(deps.assertTrustedSender).toHaveBeenCalledWith(event);
  });

  it('rejects an untrusted local sender before package inspection or Pi work starts', async () => {
    const deps = createDeps(false);
    const denied = new Error('[PERMISSION_DENIED] untrusted auxiliary window');
    deps.assertTrustedSender.mockImplementation(() => {
      throw denied;
    });
    expect(() => assertAgentCommandListIpcCaller({}, deps)).toThrow(denied);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it('accepts the authenticated Main-owned device-link dispatch context without an Electron sender', async () => {
    const deps = createDeps(true);

    assertAgentCommandListIpcCaller({}, deps);
    expect(deps.assertTrustedSender).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'logs the original %s-source failure locally but returns one stable redacted contract',
    async (deviceLink) => {
      const deps = createDeps(deviceLink);
      const sensitive = new Error(
        'SQLITE_IOERR opening /Users/chris/Library/Application Support/Cindy/private.db',
      );

      const result = toAgentCommandListFailure(sensitive, deps);

      expect(deps.reportError).toHaveBeenCalledWith(sensitive);
      expect(result).toEqual({
        success: false,
        error: AGENT_COMMAND_LIST_FAILURE_MESSAGE,
        commands: [],
      });
      expect(JSON.stringify(result)).not.toContain('/Users/chris');
      expect(JSON.stringify(result)).not.toContain('SQLITE_IOERR');
    },
  );
});
