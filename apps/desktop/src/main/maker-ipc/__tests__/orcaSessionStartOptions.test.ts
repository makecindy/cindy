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

  // The execution device has no local team/role row. Its persisted origin must enable
  // the bridge across fresh/resumed starts without turning it into a nested local Worker.
  it.each(['codex', 'claude-code', 'pi'] as const)('enables the remote bridge for %s without a local role', async agentKind => {
    const lead = { leadDeviceId: 'pc', leadDeviceName: 'PC', leadSessionId: 'lead-1', leadTitle: 'Lead', workerLabel: 'tester' };
    const opts = { ...baseOpts('remote-session'), agentKind };
    await preparePersistedOrcaSessionStart('remote-session', opts, {
      getSessionRole: async () => null, getWorkerLink: vi.fn(),
      getRemoteLead: async () => lead, warn: vi.fn(),
    });
    expect(opts.vendorOptions).toMatchObject({ orcaRemoteWorker: true, orcaRemoteLead: lead });
    expect(opts.orcaRole).toBeUndefined();
    expect(opts.userPrompt).toBeUndefined();
    expect(knownNonOrcaSessionIds.has('remote-session')).toBe(false);
  });

  it('reconstructs persisted Lead vendor options and instructions', async () => {
    const opts = baseOpts('lead-session');
    const getWorkerLink = vi.fn();
    const reviewer = { id: 'worker-1', sessionId: 'review-session', role: 'reviewer', teamId: 'team-1' };

    await expect(preparePersistedOrcaSessionStart('lead-session', opts, {
      getSessionRole: vi.fn().mockResolvedValue('lead'),
      getWorkerLink,
      listWorkersByLead: async () => [reviewer],
      warn: vi.fn(),
    })).resolves.toBe(true);

    expect(opts.orcaRole).toBe('lead');
    expect(opts.vendorOptions).toMatchObject({
      orcaRole: 'lead',
      orcaLeadSessionId: 'lead-session',
    });
    expect(opts.vendorOptions?.initialWorker).toEqual({ workerId: reviewer.id, sessionId: reviewer.sessionId });
    expect(opts.userPrompt).not.toContain('role=reviewer');
    expect(opts.userPrompt).toContain('target_session_id=review-session');
    expect(getWorkerLink).not.toHaveBeenCalled();
  });

  // A cold Lead used to discover even its sole visible Worker through model calls. Give it a route
  // only when the active team justifies it, including when a saved initial Worker has gone away.
  it('falls back to discovery for ambiguous or stale routes and keeps custom role text out of instructions', async () => {
    const reviewer = { id: 'worker-1', sessionId: 'review-session', role: 'reviewer', teamId: 'team-1' };
    const other = { ...reviewer, id: 'worker-2', sessionId: 'other-session' };
    const initialWorker = { workerId: reviewer.id, sessionId: reviewer.sessionId, role: 'reviewer' };
    const start = async (workers: typeof reviewer[], vendor: Record<string, unknown> = {}) => {
      const opts: MakerSessionCreateOpts = {
        ...baseOpts('lead-session'), agentKind: 'pi',
        vendorOptions: { orcaRole: 'lead', orcaLeadSessionId: 'lead-session', ...vendor },
      };
      await preparePersistedOrcaSessionStart('lead-session', opts, {
        getSessionRole: vi.fn(), getWorkerLink: vi.fn(), listWorkersByLead: async () => workers, warn: vi.fn(),
      });
      return opts.userPrompt;
    };
    expect(await start([reviewer, other])).not.toContain('target_session_id=');
    const selected = await start([reviewer, other], { initialWorker });
    expect(selected).toContain('target_session_id=review-session');
    expect(selected).not.toContain('role=reviewer');
    const renamed = await start([{ ...reviewer, role: 'developer' }], { initialWorker });
    expect(renamed).toContain('target_session_id=review-session');
    expect(renamed).not.toMatch(/role=(?:reviewer|developer)/);
    expect(await start([other], { initialWorker })).not.toContain('target_session_id=');
    expect(await start([reviewer], { orcaWorkflowId: 'different-team' })).not.toContain('target_session_id=');
    const custom = await start([{ ...reviewer, role: 'custom role text' }]);
    expect(custom).toContain('target_session_id=review-session');
    expect(custom).toContain('using both server and tool');
    expect(custom).not.toContain('custom role text');
  });

  it('reconstructs persisted Worker link, vendor options, and instructions', async () => {
    const opts = baseOpts('worker-session');

    await expect(preparePersistedOrcaSessionStart('worker-session', opts, {
      getSessionRole: vi.fn().mockResolvedValue('worker'),
      getWorkerLink: vi.fn().mockResolvedValue({
        workerId: 'worker-1',
        teamId: 'team-1',
        leadSessionId: 'lead-session',
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
    });
    expect(opts.userPrompt).toEqual(expect.any(String));
    expect(opts.userPrompt).not.toHaveLength(0);
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
      listWorkersByLead: vi.fn().mockResolvedValue([{ id: 'w', sessionId: 's', role: 'tester', teamId: 'team' }]),
      warn: vi.fn(),
    };

    await preparePersistedOrcaSessionStart('lead-session', opts, deps);
    opts.userPrompt = `${opts.userPrompt}\n\n<project-context-toc>project context</project-context-toc>`;
    const promptWithProjectContext = opts.userPrompt;
    await preparePersistedOrcaSessionStart('lead-session', opts, deps);

    expect(opts.userPrompt).toBe(promptWithProjectContext);
    expect(deps.getSessionRole).toHaveBeenCalledTimes(1);
    expect(deps.listWorkersByLead).toHaveBeenCalledTimes(1);
  });
});
