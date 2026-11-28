import { AcpAgent, createConsoleLogger, LOCAL_AGENT_CLIENT, type AcpLineTransport } from '@cindy/maker-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { AgentInputCoordinator } from '../agent-input-coordinator';
import type { AgentInputCreateOpts } from '../../../shared/agentInputQueue';
import { knownNonOrcaSessionIds } from '../orcaMcpHydrationCache';
import { appendOrcaDiscoveryPrompt, applyLeadVendorOptions, createAcpLeadBriefingHandoff, createAcpOrcaDiscoveryHandoff, ORCA_DIRECT_TASK_CREATE, prepareAcpRoleBriefingForStart, preparePersistedOrcaSessionStart, renderOrcaRoleInstructions } from '../orcaSessionStartOptions';
import { beginAppSessionBoundary } from '../../appSessionState';
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

  // ACP harness §5, unit: the handoff used by the old and rebuilt runtimes
  // shares delivery, but neither a new owner nor an old team can reuse it.
  it.each(['undelivered', 'already sent', 'revoked', 'team replaced', 'owner changed'] as const)(
    'only gives the replacement runtime the current undelivered promotion (%s)', async state => {
      let owner = 'owner-1';
      let teamId = 'team-1';
      const handoff = createAcpLeadBriefingHandoff({
        currentOwner: () => owner,
        readActiveTeamId: async () => teamId,
        readRole: async () => 'lead',
      });
      const old = handoff.stage('lead', teamId, 'old runtime instructions')!;
      const oldRead = old()!;
      expect(oldRead.text).toBe('old runtime instructions');
      if (state === 'already sent') oldRead.onSent();
      if (state === 'revoked') handoff.revoke('lead');
      if (state === 'team replaced') teamId = 'team-2';
      if (state === 'owner changed') owner = 'owner-2';
      const next = await handoff.forStart('lead', 'instructions for the current Worker');
      const nextRead = next?.();
      expect(nextRead?.text).toBe(state === 'undelivered' ? 'instructions for the current Worker' : undefined);
      nextRead?.onSent();
      expect(old()).toBeUndefined();
      expect(await handoff.forStart('lead', 'must not repeat')).toBeUndefined();
    },
  );

  // Unit: the account boundary must prevent ACP promotion from staging an old
  // owner's briefing without changing the existing built-in handle update.
  it.each(['claude-code', 'codex', 'pi', 'acp live', 'acp cold'] as const)(
    'preserves built-in updates but blocks ACP promotion during an account switch (%s)', async (engine) => {
      const acp = engine.startsWith('acp');
      const handoff = createAcpLeadBriefingHandoff({
        currentOwner: () => 'owner', readActiveTeamId: async () => 'team', readRole: async () => 'lead',
      });
      const setVendorOptions = vi.fn(async () => {});
      const clearHydrated = vi.fn();
      const agentKind: MakerSessionCreateOpts['agentKind'] = engine === 'acp live' || engine === 'acp cold' ? 'acp' : engine;
      const live = engine === 'acp cold' ? undefined : { agentKind, workDir: '/repo', setVendorOptions };
      const input = { leadSessionId: 'lead', teamId: 'team', newTeam: true as const, admittedLeadAgentKind: agentKind };
      const endBoundary = beginAppSessionBoundary();
      try {
        await applyLeadVendorOptions(handoff, input, live, clearHydrated);
      } finally {
        endBoundary();
      }
      expect(handoff.hasPending('lead')).toBe(false);
      expect(clearHydrated).not.toHaveBeenCalled();
      if (acp) {
        expect(setVendorOptions).not.toHaveBeenCalled();
        await applyLeadVendorOptions(handoff, input, live, clearHydrated);
        expect(handoff.hasPending('lead')).toBe(true);
        expect(clearHydrated).toHaveBeenCalledExactlyOnceWith('lead');
      } else {
        expect(setVendorOptions).toHaveBeenCalledExactlyOnceWith({
          orcaRole: 'lead', orcaWorkflowId: 'team', orcaLeadSessionId: 'lead',
        });
      }
    },
  );

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

  // Unit (2026-11-27 discovery decision and review): production Desktop startup
  // policy -> AcpAgent.startSession -> wire prompts. Inspect the native ID and
  // actual writes across handle replacement, not just opts or send acceptance.
  it.each([
    'queued first composer message', 'native CLI slash', 'global disabled', 'project disabled', 'no HTTP', 'no bridge',
    'lead', 'worker', 'promoted before first prompt', 'isolated companion', 'native resume', 'remote hosted', 'review',
    'rebuild before sending', 'rebuild after CLI slash', 'rebuild after write failure',
    'rebuild after success', 'rebuild with global disabled',
    'rebuild with project disabled', 'rebuild without HTTP', 'rebuild after host restart', 'rebuild with failed row lookup',
  ] as const)('applies the ACP first-prompt Orca discovery policy: %s', async (scenario) => {
    const opts: MakerSessionCreateOpts = { ...baseOpts('acp-discovery'), agentKind: 'acp', model: '',
      providerId: 'acp-plugin:test:engine', userPrompt: 'My preferences' };
    const botPolicy = { mode: 'allowlist' as const, configured: [], catalog: [] };
    if (scenario === 'isolated companion') {
      opts.botProfilePrompt = 'Companion identity';
      opts.botRuntimeProfile = { botId: 'isolated', profileVersion: 1, projectContext: false,
        skillPolicy: botPolicy, mcpPolicy: botPolicy, toolsetPolicy: botPolicy };
    }
    if (scenario === 'native resume') opts.resumeSessionId = 'old-acp';
    if (scenario === 'review') {
      // Main now permits read-only ACP review when the transport supports the
      // per-turn permission gate. Verify that a real review prompt stays bare.
      const root = mkdtempSync(join(tmpdir(), 'orca-discovery-review-'));
      onTestFinished(() => rmSync(root, { recursive: true, force: true }));
      opts.workingDir = root;
      opts.reviewMode = true;
    }
    if (scenario === 'lead' || scenario === 'worker') {
      opts.orcaRole = scenario;
      opts.vendorOptions = { orcaRole: scenario, orcaWorkflowId: 'team',
        orcaLeadSessionId: 'lead', orcaWorkerId: 'worker', orcaWorkerSessionId: 'acp-discovery' };
    }
    if (scenario === 'remote hosted') {
      opts.deviceHosted = { workingDir: '/repo', platform: 'darwin', shell: 'bash', isGitRepo: false, extraDirs: [], writableDirs: [],
        tunnelUrl: 'http://127.0.0.1:9', tunnelToken: 'fixture', mcpServers: ['cindy_exec', 'cindy_orca'] };
    }
    let rebuilt = false;
    let canUseHttp = scenario !== 'no HTTP';
    const isEnabled = (_id: 'collab', dir?: string) => dir === undefined
      ? scenario !== 'global disabled' && !(rebuilt && scenario === 'rebuild with global disabled')
      : scenario !== 'project disabled' && !(rebuilt && scenario === 'rebuild with project disabled');
    const discoveryHandoff = createAcpOrcaDiscoveryHandoff(() => 'owner');
    if (scenario !== 'queued first composer message') {
      appendOrcaDiscoveryPrompt(opts, row, isEnabled, managed, opts.id, discoveryHandoff);
    }
    expect(opts.userPrompt).toBe('My preferences');
    const builtin = { ...baseOpts('builtin'), userPrompt: undefined as string | undefined };
    appendOrcaDiscoveryPrompt(builtin, row, () => true, managed);
    const sharedText = builtin.userPrompt!;
    if (opts.orcaRole) {
      await prepareAcpRoleBriefingForStart(opts, createAcpLeadBriefingHandoff({
        currentOwner: () => 'owner', readActiveTeamId: async () => 'team',
        readRole: async () => opts.orcaRole ?? null,
      }));
    }
    const prompts: Array<Array<{ type: string; text: string }>> = [];
    const methods: string[] = [];
    const startedNativeIds: Array<string | undefined> = [];
    let failNextWrite = false;
    let mcpNames: string[] = [];
    let onLine: ((line: string) => void) | undefined;
    const transport: AcpLineTransport = {
      write(line) {
        const { id, method, params } = JSON.parse(line);
        methods.push(method);
        let result: object = {};
        if (method === 'initialize') result = {
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: canUseHttp }, sessionCapabilities: { resume: {} } },
          ...(scenario === 'review' ? { _meta: { permissionGate: { supported: true } } } : {}),
        };
        if (method === 'session/new' || method === 'session/resume') {
          mcpNames = params.mcpServers.map(({ name }: { name: string }) => name);
          startedNativeIds.push(params.sessionId);
          result = { sessionId: 'new-acp' };
        }
        if (method === 'session/prompt') {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error('fixture: synchronous transport write failure');
          }
          prompts.push(params.prompt);
          result = { stopReason: 'end_turn' };
        }
        queueMicrotask(() => onLine?.(JSON.stringify({ jsonrpc: '2.0', id, result })));
      },
      onLine(listener) { onLine = listener; return () => { onLine = undefined; }; },
      onClose: () => () => {}, close: async () => {},
    };
    const engine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {}, binaryPath: '', logger: createConsoleLogger('acp-discovery-test'), clientInfo: { name: 'test', version: '1' },
      endpoints: { connect: async () => transport },
      preparePiExtraSpawnConfig: async () => scenario === 'no bridge' ? null : {
        mcpBridge: { token: 'fixture', servers: ['cindy_orca', 'orca_worker_bridge'].map(name =>
          ({ name, url: 'http://127.0.0.1:9/mcp/' + name })) },
      },
    });
    if (scenario === 'queued first composer message') {
      // Unit, sixth review: real enqueue touches the same task row the startup
      // policy reads. A static userSendAt:null fixture missed this dispatch order.
      const db = new DatabaseSync(':memory:');
      let handle: Awaited<ReturnType<AcpAgent['startSession']>> | undefined;
      const sessionId = opts.id!;
      db.exec('CREATE TABLE task (id TEXT PRIMARY KEY, userSendAt INTEGER, sdkSessionId TEXT)');
      db.prepare('INSERT INTO task (id) VALUES (?)').run(sessionId);
      const readRow = db.prepare('SELECT userSendAt, sdkSessionId FROM task WHERE id = ?');
      const touchRow = db.prepare('UPDATE task SET userSendAt = ? WHERE id = ?');
      const saveNativeId = db.prepare('UPDATE task SET sdkSessionId = ? WHERE id = ?');
      const text = 'ordinary request';
      let dispatched!: () => void;
      let dispatchFailed!: (error: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => { dispatched = resolve; dispatchFailed = reject; });
      const coordinator = new AgentInputCoordinator({
        async sendToAgent(id, message, createOpts) {
          try {
            const stored = readRow.get(id) as Pick<SessionRowSnapshot, 'userSendAt' | 'sdkSessionId'>;
            expect(stored.userSendAt).toBe(1234);
            expect(stored.sdkSessionId).toBeNull();
            expect(createOpts.agentKind).toBe('acp');
            const start = { ...opts, id, workingDir: createOpts.workingDir };
            appendOrcaDiscoveryPrompt(start, { ...row, ...stored }, isEnabled, managed, id, discoveryHandoff);
            handle = await engine.startSession(start);
            saveNativeId.run(handle.id, id);
            const content = typeof message === 'string' ? message : message.content;
            if (typeof content !== 'string') throw new Error('expected a plain composer message');
            await handle.send({ type: 'user', content });
            dispatched();
            return { kind: 'session-dispatch', source: 'fixture', dispatched: true };
          } catch (error) {
            dispatchFailed(error);
            throw error;
          }
        },
        steerToAgent: async () => { throw new Error('unexpected steer'); },
        abortSession: async () => {},
        isTurnRunning: () => false,
        hasPendingInteraction: () => false,
        getAgentKind: () => null,
        getSdkSessionId: async id => {
          const nativeId = readRow.get(id)?.sdkSessionId;
          return typeof nativeId === 'string' ? nativeId : undefined;
        },
        createUserMessage: async () => { throw new Error('unexpected separate user-row write'); },
        touchUserSend: async (id, at) => { touchRow.run(at ?? Date.now(), id); },
        emitProjection: () => {},
      });
      try {
        coordinator.enqueue(sessionId, {
          clientId: 'first-input', text, persistedContent: text, workingDir: '/repo',
          model: '', effort: 'medium', permissionMode: 'default',
          chatMessage: { clientId: 'first-input', role: 'user', content: text, isStreaming: false,
            createdAt: '2026-11-27T00:00:00.000Z' },
          // The persisted queue's old TS type still lists only the built-in
          // kinds; preserve the real ACP discriminator at the runtime boundary.
          createOpts: { agentKind: 'acp', workingDir: '/repo', model: '' } as unknown as AgentInputCreateOpts,
        }, { wasFirst: true, sendAtMs: 1234 });
        await completion;
        expect(mcpNames).toContain('cindy_orca');
        expect(prompts).toEqual([[{ type: 'text', text: sharedText }, { type: 'text', text }]]);
      } finally {
        coordinator.onSessionClosed(sessionId);
        await handle?.close();
        db.close();
      }
      return;
    }
    let session = await engine.startSession(opts);
    try {
      expect(mcpNames.includes('cindy_orca')).toBe(scenario !== 'no HTTP' && scenario !== 'no bridge' && scenario !== 'review');
      let roleText = opts.pluginEngineBriefing;
      if (scenario === 'promoted before first prompt') {
        const handoff = createAcpLeadBriefingHandoff({
          currentOwner: () => 'owner', readActiveTeamId: async () => 'team', readRole: async () => 'lead',
        });
        await applyLeadVendorOptions(handoff, { leadSessionId: 'acp-discovery', teamId: 'team', newTeam: true }, {
          agentKind: 'acp', workDir: '/repo', setVendorOptions: patch => session.setVendorOptions!(patch),
        }, () => {});
        roleText = renderOrcaRoleInstructions({ ...opts, vendorOptions: { orcaRole: 'lead' } })!;
      }
      const cliSlash = scenario === 'native CLI slash' || scenario === 'rebuild after CLI slash';
      if (cliSlash) {
        await session.send({ type: 'user', content: '/help do not consume the briefing' });
        expect(prompts[0]).toEqual([{ type: 'text', text: '/help do not consume the briefing' }]);
      }
      if (scenario.startsWith('rebuild ')) {
        if (scenario === 'rebuild after success') {
          await session.send({ type: 'user', content: 'before close' });
          expect(prompts[0]?.[0]?.text).toBe(sharedText);
        } else if (scenario === 'rebuild after write failure') {
          failNextWrite = true;
          await session.send({ type: 'user', content: 'failed write' });
          expect(failNextWrite).toBe(false);
          expect(prompts).toHaveLength(0);
        }
        const nativeId = session.id;
        await session.close();
        rebuilt = true;
        canUseHttp = scenario !== 'rebuild without HTTP';
        const next = { ...opts, resumeSessionId: nativeId };
        const startupRow = scenario === 'rebuild with failed row lookup' ? undefined : { ...row, sdkSessionId: nativeId };
        appendOrcaDiscoveryPrompt(next, startupRow, isEnabled, managed, next.id,
          scenario === 'rebuild after host restart' ? createAcpOrcaDiscoveryHandoff(() => 'owner') : discoveryHandoff);
        session = await engine.startSession(next);
        expect(session.id).toBe(nativeId);
        expect(startedNativeIds).toEqual([undefined, nativeId]);
        expect(mcpNames.includes('cindy_orca')).toBe(canUseHttp);
        if (scenario === 'rebuild with failed row lookup') {
          // An undefined row is what the real startup hook passes after a read error.
          await session.send({ type: 'user', content: 'first write while row unavailable' });
          expect(prompts[0]).toEqual([{ type: 'text', text: 'first write while row unavailable' }]);
          await session.close();
          appendOrcaDiscoveryPrompt(next, { ...row, sdkSessionId: nativeId }, isEnabled, managed, next.id, discoveryHandoff);
          session = await engine.startSession(next);
          expect(startedNativeIds).toEqual([undefined, nativeId, nativeId]);
        }
      }
      const ordinaryIndex = prompts.length;
      await session.send({ type: 'user', content: 'ordinary request' });
      await session.send({ type: 'user', content: 'next request' });
      const text = prompts.flat().map(block => block.text).join('\n');
      const wantsDiscovery = ['native CLI slash', 'rebuild before sending',
        'rebuild after CLI slash', 'rebuild after write failure'].includes(scenario);
      expect(text.split(sharedText)).toHaveLength(wantsDiscovery || scenario === 'rebuild after success' ? 2 : 1);
      const ordinary = prompts[ordinaryIndex];
      if (scenario === 'review') expect(ordinary).toEqual([{ type: 'text', text: 'ordinary request' }]);
      if (wantsDiscovery) expect(ordinary).toEqual([
        { type: 'text', text: sharedText }, { type: 'text', text: 'ordinary request' },
      ]);
      if (roleText) expect(ordinary?.[0]?.text).toBe(roleText);
      expect(prompts.at(-1)).toEqual([{ type: 'text', text: 'next request' }]);
    } finally {
      await session.close();
    }
  });
});
