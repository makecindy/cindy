import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import type { Session, SessionMeta } from '@cindy/maker-core';
import { getOrResumeHistorySession } from '../sessionHistoryResume.js';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function sourceBetween(startNeedle: string, endNeedle: string): string {
  const start = registerSource.indexOf(startNeedle);
  const end = registerSource.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return registerSource.slice(start, end);
}

describe('Pi session-tree lazy resume provider route', () => {
  it('refreshes shared global skills before Pi discovery', () => {
    const listSkills = sourceBetween(
      'MAKER_INVOKE.LIST_AGENT_SKILLS',
      'MAKER_INVOKE.SCAN_AT_RESOURCES',
    );
    const listCustomizations = sourceBetween(
      'MAKER_INVOKE.LIST_CUSTOMIZATIONS',
      '// ── Session 生命周期',
    );

    expect(listSkills).toContain('const kind = requireAgentKind(agentKind);');
    expect(listSkills).toContain('await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();');
    expect(
      listSkills.indexOf('await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();'),
    ).toBeLessThan(listSkills.indexOf('maker.listAgentSkills(kind, skillParams)'));

    expect(listCustomizations).toContain("else if (agentKind === 'pi') {");
    expect(listCustomizations).toContain(
      'await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();',
    );
    expect(
      listCustomizations.indexOf('await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();'),
    ).toBeLessThan(listCustomizations.indexOf('maker.listCustomizations(opts)'));
  });

  it('keeps the same three-state route contract across every persisted-session bootstrap', () => {
    const preHydrate = sourceBetween(
      'async function hydrateProviderIdBeforeSessionStart',
      'async function markOrcaRoleIfNeeded',
    );
    const reconcile = sourceBetween(
      'async function reconcileCreateOptsAgainstDb',
      'const agentSwitchDeps:',
    );
    const queued = sourceBetween(
      'async function buildCreateOptsForQueuedSession',
      'async function enqueueSendToSessionMessage',
    );

    expect(preHydrate).toContain('o.providerId = row.providerId?.trim() || null;');
    expect(reconcile).toContain('co.providerId = row.providerId;');
    expect(queued).toContain('providerId: row.providerId,');
    expect(registerSource).toContain('providerId: row?.providerId,');
    expect(registerSource).toContain('providerId: inherited.providerId,');
    expect(registerSource).not.toContain('co.providerId = row.providerId ?? undefined;');
    expect(registerSource).not.toContain('providerId: row.providerId ?? undefined,');
    expect(registerSource).not.toContain('providerId: row?.providerId ?? undefined,');
    expect(registerSource).not.toContain('providerId: inherited.providerId ?? undefined,');
  });
});

function historyHarness(agentKind: 'pi' | 'codex' | 'claude-code' = 'codex') {
  const meta: SessionMeta = {
    id: 'task', agentKind, sdkSessionId: 'native-thread', workDir: '/remote/repo',
    model: 'model', title: 'Existing task', createdAt: 1, updatedAt: 2,
  };
  const settings: NonNullable<Awaited<ReturnType<Parameters<typeof getOrResumeHistorySession>[2]['readSettings']>>> = {
    status: 'active', providerId: null, effort: 'high', fastMode: true,
    permissionMode: 'ask', planModeEnabled: true, codexHistoryHasProductPrompt: true,
    remoteHostId: 'ssh-host', orcaRole: null,
  };
  const send = vi.fn();
  const session = { sdkSessionId: meta.sdkSessionId, send } as unknown as Session;
  const deps = {
    maker: {
      getSession: vi.fn<() => Session | undefined>(() => undefined),
      getSessionMeta: vi.fn(async () => meta),
    },
    assertOwner: vi.fn(),
    readSettings: vi.fn(async () => settings),
    prepare: vi.fn<Parameters<typeof getOrResumeHistorySession>[2]['prepare']>(async () => true),
    bootstrap: vi.fn(async () => session),
  };
  return { meta, settings, session, send, deps };
}

describe('history restoration provider-group routing', () => {
  it.each([true, false])('keeps strict history on its saved route without enrolling in startup failover (strict=%s)', async (strict) => {
    const context = { overrideRoute: true, route: { agentDeviceId: 'another-computer', providerId: 'another-provider' } };
    const assignBeforeStart = vi.fn(async () => context);
    const query = { from: vi.fn(), where: vi.fn(), limit: vi.fn(async () => [{ id: 'task' }]) };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const deps = {
      providerGroupService: { assignBeforeStart },
      isProviderShareAgentDeviceId: () => false,
      listProviderGroups: () => ({ provider: {} }),
      readProviderGroupBinding: () => null,
      getDbClient: () => ({ drizzle: { select: () => query } }),
      sessions: { id: 'id' },
      eq: () => undefined,
    };
    const source = sourceBetween('async function applyProviderGroupAssignment(', 'async function bootstrapSession(');
    const apply = new Function(...Object.keys(deps), transpileModule(`${source}\nreturn applyProviderGroupAssignment;`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText)(...Object.values(deps));
    const options = {
      id: 'task', agentKind: 'codex', model: 'model', resumeSessionId: 'native-thread',
      agentDeviceId: 'original-computer', providerId: 'original-provider',
      vendorOptions: { requireExistingSession: strict },
    };
    const result = await apply(options);
    if (strict) {
      expect(result).toBeNull();
      expect(assignBeforeStart).not.toHaveBeenCalled();
      expect(options.agentDeviceId).toBe('original-computer');
      expect(options.providerId).toBe('original-provider');
    } else {
      expect(result).toBe(context);
      expect(assignBeforeStart).toHaveBeenCalledOnce();
      expect(options.agentDeviceId).toBe('another-computer');
    }
  });
});

describe('history-only lazy resume', () => {
  it.each(['codex', 'pi'] as const)('resumes %s with its persisted identity and route without sending input', async (kind) => {
    const { session, send, deps } = historyHarness(kind);
    await expect(getOrResumeHistorySession('task', kind === 'pi' ? 'pi-tree' : 'rewind', deps)).resolves.toBe(session);
    expect(deps.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task', agentKind: kind, resumeSessionId: 'native-thread',
      workingDir: '/remote/repo', remoteHostId: 'ssh-host', providerId: null,
      model: 'model', effort: 'high', fastMode: true, permissionMode: 'ask',
      ...(kind === 'codex' ? {
        planMode: true, codexHistoryHasProductPrompt: true,
        vendorOptions: { requireExistingSession: true },
      } : {}),
    }), deps.assertOwner);
    expect(deps.prepare.mock.invocationCallOrder[0]).toBeLessThan(deps.bootstrap.mock.invocationCallOrder[0]!);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['codex', 'pi', 'claude-code'] as const)('rewind restores inactive %s without a wake-up message', async (kind) => {
    const { session, send, deps } = historyHarness(kind);
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).resolves.toBe(session);
    expect(deps.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: kind, resumeSessionId: 'native-thread',
      vendorOptions: { requireExistingSession: true },
    }), deps.assertOwner);
    expect(send).not.toHaveBeenCalled();
  });

  it('reuses a live session without another bootstrap', async () => {
    const { session, deps } = historyHarness();
    deps.maker.getSession.mockReturnValue(session);
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).resolves.toBe(session);
    expect(deps.maker.getSessionMeta).not.toHaveBeenCalled();
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });

  it.each(['archived', 'deleted'] as const)('does not revive a %s task', async (status) => {
    const { settings, deps } = historyHarness();
    settings.status = status;
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).resolves.toBeNull();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });

  it('does not activate a different harness through the Pi tree', async () => {
    const { deps } = historyHarness('codex');
    await expect(getOrResumeHistorySession('task', 'pi-tree', deps)).resolves.toBeNull();
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });

  it.each([undefined, '<pending>'])('refuses a missing native thread (%s)', async (nativeId) => {
    const { meta, deps } = historyHarness();
    meta.sdkSessionId = nativeId;
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).rejects.toThrow('REWIND_UNSUPPORTED_HISTORY');
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });

  it('keeps directory grants and vendor options supplied by the normal preflight', async () => {
    const { deps } = historyHarness();
    deps.prepare.mockImplementation(async (options) => {
      Object.assign(options, { extraDirs: ['/remote/extra'], writableDirs: ['/remote/write'], vendorOptions: { orcaRole: 'worker' } });
      return true;
    });
    await getOrResumeHistorySession('task', 'rewind', deps);
    expect(deps.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      extraDirs: ['/remote/extra'], writableDirs: ['/remote/write'],
      vendorOptions: { orcaRole: 'worker', requireExistingSession: true },
    }), deps.assertOwner);
  });

  it('does not bootstrap after an unavailable workdir or failed remote preflight', async () => {
    const { deps } = historyHarness();
    deps.prepare.mockResolvedValueOnce(false);
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).resolves.toBeNull();
    deps.prepare.mockRejectedValueOnce(new Error('remote unavailable'));
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).rejects.toThrow('remote unavailable');
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });

  it('does not bootstrap if the owner changes during preflight', async () => {
    const { deps } = historyHarness();
    deps.prepare.mockImplementation(async () => {
      deps.assertOwner.mockImplementation(() => { throw new Error('owner changed'); });
      return true;
    });
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).rejects.toThrow('owner changed');
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });

  it.each(['codex', 'pi', 'claude-code'] as const)('rejects unexpected %s history identity', async (kind) => {
    const { session, deps } = historyHarness(kind);
    Object.defineProperty(session, 'sdkSessionId', { value: 'replacement' });
    await expect(getOrResumeHistorySession('task', 'rewind', deps)).rejects.toThrow('REWIND_UNSUPPORTED_HISTORY');
  });
});
