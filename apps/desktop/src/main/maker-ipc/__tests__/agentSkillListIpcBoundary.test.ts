import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SKILL_LIST_FAILURE_MESSAGE,
  assertAgentSkillListIpcCaller,
  toAgentSkillListFailure,
  createProjectSkillPreparation,
} from '../agentSkillListIpcBoundary.js';

function createDeps(deviceLink: boolean) {
  return {
    isDeviceLinkInvoke: vi.fn(() => deviceLink),
    assertTrustedSender: vi.fn(),
    reportError: vi.fn(),
  };
}

describe('agent skill list IPC boundary', () => {
  // Unit: palette queries must share only same-owner, same-directory in-flight
  // preparation; completed or failed work is not a cache. Earlier tests covered
  // caller authorization only. Minimum input: two overlapping palette reads.
  it('shares preparation while pending and permits fresh attempts after success or failure', async () => {
    let finish!: (value: boolean) => void;
    const prepare = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const run = createProjectSkillPreparation(prepare);
    const a = run('owner:1', '/project');
    const b = run('owner:1', '/project');
    finish(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await expect(run('owner:1', '/project')).rejects.toThrow('temporarily unavailable');
    prepare.mockResolvedValueOnce(false);
    await expect(run('owner:1', '/project')).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledTimes(3);
  });
  it('does not share preparation across owner generations or working directories', async () => {
    const prepare = vi.fn(async () => false);
    const run = createProjectSkillPreparation(prepare);
    await Promise.all([run('owner:1', '/one'), run('owner:2', '/one'), run('owner:1', '/two')]);
    expect(prepare).toHaveBeenCalledTimes(3);
  });
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
