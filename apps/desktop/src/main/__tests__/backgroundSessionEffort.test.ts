import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { findCatalogModel } from '@cindy/model-providers';
const auth = vi.hoisted(() => ({ codexOAuth: true }));
vi.mock('../maker-host/auth-adapters.js', () => ({ readClaudeApiKey: () => null,
  desktopCodexAuthAdapter: { hasCodexOAuthLoginReadOnly: () => auth.codexOAuth } }));
vi.mock('../maker-host/claude-credentials-store.js', () => ({ hasClaudeAiOAuth: () => false }));
vi.mock('../maker-host/provider-route.js', () => ({ gatewayDefaultRouteDecision: () => null }));
vi.mock('../maker-host/model-context-limit-store.js', () => ({ readModelContextLimit: () => null }));
import { resolveDesktopModelContextProviderId } from '../maker-host/model-context-settings.js';
import { resolveCompatibleSessionRuntimeEffort } from '../maker-ipc/sessionRuntimeControl.js';

// Execute the real cold-dispatch option assembly and DB reconciliation without
// booting Electron or touching the user's database/native model account.
const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
function between(start: string, end: string, from = 0) {
  const a = source.indexOf(start, from);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('cold dispatch source boundary changed');
  return source.slice(a, b);
}
const reconcile = between('  async function reconcileCreateOptsAgainstDb(', '  async function rehydrateColdPiRuntimeForWindowVerification(');
const cold = between('        const createOpts = buildCreateOptsWithStderr({',
  '        const { session } = await bootstrapSession(createOpts);',
  source.indexOf("lockStage = 'lazy-resume-bootstrap'"));
// Run every production statement up to and including the actual native create
// call. The stub stops execution there, before post-create hydration can hide a bug.
const bootstrap = between('    if (o.id && o.workingDir',
  '    await markProjectContextIfNeeded(', source.indexOf('  async function bootstrapSession('));
const compiled = transpileModule(`${reconcile}\nasync function bootstrapSession(o, assertAccess) { ${bootstrap} }\nreturn async () => { ${cold}\nawait bootstrapSession(createOpts); };`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

function harness(effort: string | null, runtimeOverride: Record<string, unknown> | null = null, efforts = ['medium', 'high'], providerId: string | null = 'openai', remoteHostId: string | null = null, supportsFastMode = true) {
  const row = { agentKind: 'codex', model: 'gpt-6-astra', providerId,
    sdkSessionId: 'native-child', effort, fastMode: true, remoteHostId };
  const read = vi.fn(async () => [row]);
  // SSH connectivity is outside this bootstrap test; model its DB host hydration.
  const remoteReady = vi.fn(async (input: { createOpts: Record<string, unknown> }) => {
    if (remoteHostId) input.createOpts.remoteHostId = remoteHostId;
  });
  const boundary = new Error('native creation boundary');
  const createSession = vi.fn(async (_opts: unknown) => { throw boundary; });
  const deps = {
    targetSessionId: 'child', dbRow: row,
    meta: { agentKind: 'codex', model: row.model, workDir: 'child-workdir', sdkSessionId: row.sdkSessionId },
    buildCreateOptsWithStderr: (opts: unknown) => opts,
    getDbClient: () => ({ drizzle: { select: () => ({ from: () => ({ where: () => ({ limit: read }) }) }) } }),
    sessions: {}, eq: vi.fn(), dbToMakerAgentKind: (kind: string) => kind,
    synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => undefined),
    readSessionExtraDirsFromDb: async () => [], extraDirsForRuntime: (x: unknown) => x,
    readSessionWritableDirsFromDb: async () => [], ensureRemoteReadyForSessionStart: remoteReady,
    getSessionRuntimeControlSnapshot: () => ({ effectiveOverride: runtimeOverride }),
    workingDirectoryRecovery: { resolve: (_id: string, dir: string) => dir,
      observe: async () => undefined, isFallback: () => false },
    options: { waitForAccountProviderModelsReady: async () => undefined },
    applyPersistedReviewMode: async () => undefined,
    applyPersistedCindyMakeMarker: async () => undefined, readSessionSource: vi.fn(),
    applyOrcaInstructions: () => false, applyProjectContextInjection: async () => false,
    prepareDirectoryGrantsForBootstrap: async () => undefined,
    statWorkingDirectory: vi.fn(), realpathWorkingDirectory: vi.fn(), persistSessionFields: vi.fn(),
    hydrateProviderIdBeforeSessionStart: async () => undefined,
    ensureManagedOllamaReadyForSession: async () => undefined, app: { getPath: () => 'test-data' },
    assertModelRouteUsable: async () => null, shouldApplyExclusiveProviderRerouteLive: () => false,
    pinExclusiveSessionProvider: async () => null,
    getActiveCatalog: () => ({ providers: ['openai', 'xd', 'custom'].map(id => ({
      id, routing: { codex: {} }, models: { codex: [{ id: runtimeOverride?.model ?? row.model, supportsFastMode,
        efforts: id === 'xd' ? ['low'] : efforts, defaultEffort: id === 'xd' ? 'low' : efforts[0] }] },
    })) }),
    findCatalogModel, resolveDesktopModelContextProviderId,
    resolveCompatibleSessionRuntimeEffort, maker: { createSession },
    log: { warn: vi.fn() },
  };
  const run = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as () => Promise<Record<string, unknown>>;
  const capture = async () => {
    try { await run(); } catch (err) { if (err !== boundary) throw err; }
    expect(createSession).toHaveBeenCalledTimes(1);
    return createSession.mock.calls[0][0] as Record<string, unknown>;
  };
  return { run: capture, read, remoteReady, createSession };
}

describe('background child first native creation options', () => {
  it.each(['medium', 'high'])('preserves saved %s and Fast before native bootstrap', async effort => {
    const h = harness(effort);
    expect(await h.run()).toMatchObject({ id: 'child', agentKind: 'codex', model: 'gpt-6-astra',
      effort, fastMode: true, providerId: 'openai', resumeSessionId: 'native-child',
      workingDir: 'child-workdir', permissionMode: 'bypassPermissions' });
    expect(h.remoteReady).toHaveBeenCalledWith({ createOpts: expect.objectContaining({ effort, fastMode: true }) });
  });

  it('keeps an effective runtime override above the persisted baseline', async () => {
    const override = { agentKind: 'codex', model: 'gpt-6-astra', providerId: 'custom', effort: 'high', fastMode: false };
    expect(await harness('medium', override).run()).toMatchObject(override);
  });

  it('does not invent an effort when the persisted value is absent', async () => {
    expect((await harness(null).run()).effort).toBeUndefined();
  });

  it('drops a historical effort for a fixed-effort model at native creation', async () => {
    expect((await harness('high', null, []).run()).effort).toBeUndefined();
  });

  it('maps a historical effort to the current model supported levels', async () => {
    expect((await harness('high', null, ['low', 'medium']).run()).effort).toBe('low');
  });

  it('normalizes the effective override too when its model has fixed effort', async () => {
    expect((await harness('medium', { agentKind: 'codex', model: 'fixed',
      providerId: 'custom', effort: 'high', fastMode: false }, []).run()).effort).toBeUndefined();
  });

  it.each([true, false])('normalizes the actual implicit route (subscription=%s)', async loggedIn => {
    auth.codexOAuth = loggedIn;
    try {
      const opts = await harness('high', null, [], null).run();
      expect(opts.effort).toBe(loggedIn ? undefined : 'low');
      expect(opts.providerId).toBeNull(); // Lookup must not pin or rewrite the saved route.
    } finally { auth.codexOAuth = true; }
  });

  it.each([true, false])('preserves SSH effort independently of local subscription=%s', async loggedIn => {
    auth.codexOAuth = loggedIn;
    try {
      const opts = await harness('high', null, [], null, 'ssh-host').run();
      expect(opts).toMatchObject({ remoteHostId: 'ssh-host', providerId: null, effort: 'high' });
    } finally { auth.codexOAuth = true; }
  });

  it.each([null, 'high'])('drops unsupported Fast regardless of persisted effort=%s', async effort => {
    const opts = await harness(effort, null, ['medium', 'high'], null, null, false).run();
    expect(opts.fastMode).toBe(false);
  });

  it('normalizes Fast after a runtime model override', async () => {
    const opts = await harness('medium', { agentKind: 'codex', model: 'no-fast',
      providerId: 'custom', effort: null, fastMode: true }, ['medium'], 'openai', null, false).run();
    expect(opts.fastMode).toBe(false);
  });

  it('preserves SSH Fast when the controller model has no Fast capability', async () => {
    const opts = await harness(null, null, [], null, 'ssh-host', false).run();
    expect(opts.fastMode).toBe(true);
  });

  it('refuses native startup if persisted configuration cannot be read', async () => {
    const h = harness('medium');
    h.read.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(h.run()).rejects.toThrow('DB unavailable');
    expect(h.remoteReady).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });
});
