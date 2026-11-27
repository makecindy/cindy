import { LOCAL_AGENT_CLIENT } from '@cindy/maker-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { knownNonOrcaSessionIds } from '../orcaMcpHydrationCache';
import { appendOrcaDiscoveryPrompt, ORCA_DIRECT_TASK_CREATE, preparePersistedOrcaSessionStart } from '../orcaSessionStartOptions';
import type { SessionRowSnapshot } from '../../localDb/sessionDispatchSnapshot';
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

describe('ordinary Orca discovery at session startup', () => {
  // Unit: exercise the production startup injection. The existing role tests
  // cannot catch advertising unavailable tools to ordinary sessions.
  const row: SessionRowSnapshot = {
    status: 'idle', title: null, userSendAt: null, providerId: null,
    workingDir: '/repo', workspaceKind: 'project', source: 'desktop',
  };
  const managed = (dir: string) => dir === '/managed-dialogue';
  const hasDiscovery = (opts: MakerSessionCreateOpts) => opts.userPrompt?.includes('start_team on cindy_orca') ?? false;

  it.each(['claude-code', 'codex', 'pi'] as const)('appends a stable introduction for a fresh or restored %s ordinary task', async agentKind => {
    const start = async (resumed: boolean) => {
      knownNonOrcaSessionIds.clear();
      const opts = { ...baseOpts('ordinary'), agentKind, userPrompt: 'My preferences', ...(resumed ? { resumeSessionId: 'native-id' } : {}) };
      await preparePersistedOrcaSessionStart('ordinary', opts, {
        getSessionRole: async () => null, getWorkerLink: vi.fn(), warn: vi.fn(),
      });
      appendOrcaDiscoveryPrompt(opts, row, () => true, managed);
      return opts;
    };
    const fresh = await start(false);
    const resumed = await start(true);
    expect(hasDiscovery(fresh)).toBe(true);
    expect(fresh.userPrompt).toContain('My preferences\n\n');
    expect(fresh.userPrompt).toContain('native subagent capability');
    expect(resumed.userPrompt).toBe(fresh.userPrompt);
  });

  it.each([
    { name: 'global disabled', row: {}, opts: {}, global: false, project: undefined, expected: false },
    { name: 'ordinary side-chat', row: { source: 'side-chat' }, opts: {}, global: true, project: undefined, expected: true },
    { name: 'project disabled', row: {}, opts: {}, global: true, project: false, expected: false },
    { name: 'project enabled', row: {}, opts: {}, global: false, project: true, expected: true },
    { name: 'Pi project enabled but global disabled', row: {}, opts: { agentKind: 'pi' as const }, global: false, project: true, expected: false },
    ...(['claude-code', 'codex'] as const).flatMap(agentKind => [
      { name: `device-hosted ${agentKind} project enabled but global disabled`, row: {}, opts: { agentKind, agentDeviceId: 'other-computer' }, global: false, project: true, expected: false },
      { name: `device-hosted ${agentKind} project and global enabled`, row: {}, opts: { agentKind, agentDeviceId: 'other-computer' }, global: true, project: true, expected: true },
    ]),
    { name: 'managed dialogue ignores project override', row: { workspaceKind: 'dialogue', workingDir: '/managed-dialogue' }, opts: {}, global: true, project: false, expected: true },
    { name: 'managed dialogue respects global disabled', row: { workspaceKind: 'dialogue', workingDir: '/managed-dialogue' }, opts: {}, global: false, project: true, expected: false },
    { name: 'explicit dialogue directory respects project override', row: { workspaceKind: 'dialogue' }, opts: {}, global: true, project: false, expected: false },
    { name: 'SSH ignores local project override', row: { remoteHostId: 'ssh' }, opts: {}, global: true, project: false, expected: true },
    { name: 'SSH respects global disabled', row: { remoteHostId: 'ssh' }, opts: {}, global: false, project: true, expected: false },
  ])('$name', ({ row: patch, opts: optsPatch, global, project, expected }) => {
    const opts = { ...baseOpts('ordinary'), ...optsPatch };
    appendOrcaDiscoveryPrompt(opts, { ...row, ...patch }, (_id, dir) => dir ? project ?? global : global, managed);
    expect(hasDiscovery(opts)).toBe(expected);
  });

  it('introduces Orca for a new direct mobile/device-link task before its row exists, without assuming missing rows are ordinary', () => {
    const options = () => ({ ...baseOpts('direct'), workspaceKind: 'project' as const });
    const direct = { ...options(), [ORCA_DIRECT_TASK_CREATE]: true as const };
    appendOrcaDiscoveryPrompt(direct, null, () => true, managed);
    expect(hasDiscovery(direct)).toBe(true);

    for (const [opts, lookup] of [
      [options(), null],
      [{ ...options(), [ORCA_DIRECT_TASK_CREATE]: true as const }, undefined],
      [{ ...options(), [ORCA_DIRECT_TASK_CREATE]: true as const, resumeSessionId: 'native-id' }, null],
    ] as const) {
      appendOrcaDiscoveryPrompt(opts, lookup, () => true, managed);
      expect(hasDiscovery(opts)).toBe(false);
    }
  });

  it.each([
    { name: 'persisted lead', row: { orcaRole: 'lead' as const }, opts: {} },
    { name: 'persisted worker', row: { orcaRole: 'worker' as const }, opts: {} },
    { name: 'remote worker', row: { orcaRemoteLead: '{}' }, opts: {} },
    { name: 'runtime role', row: {}, opts: { vendorOptions: { orcaRole: 'lead' } } },
    { name: 'remote worker runtime marker', row: {}, opts: { vendorOptions: { orcaRemoteWorker: true } } },
    { name: 'review mode', row: {}, opts: { reviewMode: true as const } },
    { name: 'review source', row: { source: 'review' }, opts: {} },
    { name: 'bot source', row: { source: 'bot' }, opts: {} },
    { name: 'restricted local application', row: {}, opts: { [LOCAL_AGENT_CLIENT]: { url: 'http://localhost', token: 'fixture', hostToolsOnly: true } } },
    { name: 'plugin engine', row: {}, opts: { agentKind: 'acp' as const } },
    { name: 'unsupported workspace', row: { workspaceKind: null }, opts: {} },
    { name: 'missing working directory', row: { workingDir: '' }, opts: {} },
  ])('does not advertise Orca for $name', ({ row: patch, opts: optsPatch }) => {
    const opts = { ...baseOpts('ordinary'), ...optsPatch, userPrompt: 'My preferences' };
    appendOrcaDiscoveryPrompt(opts, { ...row, ...patch }, () => true, managed);
    expect(opts.userPrompt).toBe('My preferences');
  });
});
