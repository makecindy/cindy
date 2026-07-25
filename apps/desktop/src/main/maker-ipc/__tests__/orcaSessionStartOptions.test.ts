import { beforeEach, describe, expect, it, vi } from 'vitest';

import { knownNonOrcaSessionIds } from '../orcaMcpHydrationCache';
import { preparePersistedOrcaSessionStart } from '../orcaSessionStartOptions';
import type { MakerSessionCreateOpts } from '../sessionRequest';

function baseOpts(id: string): MakerSessionCreateOpts {
  return {
    id,
    agentKind: 'codex',
    workingDir: '/repo',
    model: 'gpt-5',
  };
}

describe('persisted Orca session start options', () => {
  beforeEach(() => {
    knownNonOrcaSessionIds.clear();
  });

  it('reconstructs persisted Lead vendor options and instructions', async () => {
    const opts = baseOpts('lead-session');
    const getWorkerLink = vi.fn();

    await expect(preparePersistedOrcaSessionStart('lead-session', opts, {
      getSessionRole: vi.fn().mockResolvedValue('lead'),
      getWorkerLink,
      warn: vi.fn(),
    })).resolves.toBe(true);

    expect(opts.orcaRole).toBe('lead');
    expect(opts.vendorOptions).toMatchObject({
      orcaRole: 'lead',
      orcaLeadSessionId: 'lead-session',
    });
    expect(opts.userPrompt).toEqual(expect.any(String));
    expect(opts.userPrompt).not.toHaveLength(0);
    expect(getWorkerLink).not.toHaveBeenCalled();
  });

  it('reconstructs persisted Worker link, vendor options, and instructions', async () => {
    const opts = baseOpts('worker-session');

    await expect(preparePersistedOrcaSessionStart('worker-session', opts, {
      getSessionRole: vi.fn().mockResolvedValue('worker'),
      getWorkerLink: vi.fn().mockResolvedValue({
        workerId: 'worker-1',
        teamId: 'team-1',
        leadSessionId: 'lead-session',
        idleSince: '2026-07-25T10:00:00.000Z',
      }),
      warn: vi.fn(),
    })).resolves.toBe(true);

    expect(opts.orcaRole).toBe('worker');
    expect(opts.vendorOptions).toMatchObject({
      orcaRole: 'worker',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'lead-session',
      orcaWorkerId: 'worker-1',
      orcaWorkerSessionId: 'worker-session',
      orcaRuntimeReleased: true,
    });
    expect(opts.userPrompt).toEqual(expect.any(String));
    expect(opts.userPrompt).not.toHaveLength(0);
  });

  it('refreshes the persisted runtime-release marker on an explicit Worker resume', async () => {
    const opts = {
      ...baseOpts('worker-session'),
      resumeSessionId: 'codex-thread-id',
      vendorOptions: {
        orcaRole: 'worker',
        orcaRuntimeReleased: false,
      },
    };
    const getWorkerLink = vi.fn().mockResolvedValue({
      workerId: 'worker-1',
      teamId: 'team-1',
      leadSessionId: 'lead-session',
      idleSince: '2026-07-25T10:00:00.000Z',
    });

    await preparePersistedOrcaSessionStart('worker-session', opts, {
      getSessionRole: vi.fn(),
      getWorkerLink,
      warn: vi.fn(),
    });

    expect(getWorkerLink).toHaveBeenCalledWith('worker-session');
    expect(opts.vendorOptions.orcaRuntimeReleased).toBe(true);
  });

  it('does not cache an explicit Orca role as non-Orca before its row is persisted', async () => {
    const opts = {
      ...baseOpts('worker-session'),
      orcaRole: 'worker' as const,
    };
    knownNonOrcaSessionIds.add('worker-session');
    const getSessionRole = vi.fn().mockResolvedValue(null);

    await expect(preparePersistedOrcaSessionStart('worker-session', opts, {
      getSessionRole,
      getWorkerLink: vi.fn(),
      warn: vi.fn(),
    })).resolves.toBe(false);

    expect(getSessionRole).toHaveBeenCalledWith('worker-session');
    expect(knownNonOrcaSessionIds.has('worker-session')).toBe(false);
  });

  it('does not duplicate instructions when project context follows the Orca prompt', async () => {
    const opts = baseOpts('lead-session');
    const deps = {
      getSessionRole: vi.fn().mockResolvedValue('lead' as const),
      getWorkerLink: vi.fn(),
      warn: vi.fn(),
    };

    await preparePersistedOrcaSessionStart('lead-session', opts, deps);
    opts.userPrompt = `${opts.userPrompt}\n\n<project-context-toc>project context</project-context-toc>`;
    const promptWithProjectContext = opts.userPrompt;
    await preparePersistedOrcaSessionStart('lead-session', opts, deps);

    expect(opts.userPrompt).toBe(promptWithProjectContext);
    expect(deps.getSessionRole).toHaveBeenCalledTimes(1);
  });
});
