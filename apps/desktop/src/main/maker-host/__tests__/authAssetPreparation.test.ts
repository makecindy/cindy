import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreparationCache } from '../preparation-cache.js';

const state = vi.hoisted(() => ({
  owner: { dataOwnerId: 'a', generation: 1, mode: 'cloud' },
  boundary: false,
  bridge: vi.fn(),
  links: vi.fn(),
  fingerprint: 'fp-1',
  logs: [] as Array<{ level: string; scope: string; warning?: unknown }>,
}));
vi.mock('electron', () => ({ app: { getPath: () => '', getAppPath: () => '', isPackaged: true }, safeStorage: {} }));
vi.mock('@cindy/maker-core', () => ({}));
vi.mock('../../appSessionState.js', async (original) => ({
  ...await original<typeof import('../../appSessionState.js')>(),
  getActiveAppSession: () => ({ ...state.owner }),
  isAppSessionBoundaryPending: () => state.boundary,
}));
vi.mock('../codex-global-plugins.js', () => ({ prepareCodexGlobalPluginsBridge: state.bridge }));
vi.mock('../shared-global-skills.js', async (original) => ({
  ...await original<typeof import('../shared-global-skills.js')>(),
  prepareSharedGlobalSkillLinks: state.links,
  sharedGlobalSkillLinksFingerprint: async () => state.fingerprint,
}));
vi.mock('../built-in-skills.js', async (original) => ({
  ...await original<typeof import('../built-in-skills.js')>(),
  resolveBundledSystemSkillsRoot: () => 'unused-bundle',
  prepareBuiltInSkills: async () => ({ descriptors: [], projectionSafe: false, warnings: [] }),
}));
vi.mock('../../authBoundaryQuarantine.js', async (original) => ({
  ...await original<typeof import('../../authBoundaryQuarantine.js')>(),
  withSharedGlobalSkillProjectionMutation: (_owner: unknown, run: () => unknown) => run(),
}));
vi.mock('../../logger.js', async (original) => {
  const record = (scope: string, level: string) => (_msg: string, meta?: { warning?: unknown }) => {
    state.logs.push({ level, scope, warning: meta?.warning });
  };
  return {
    ...await original<typeof import('../../logger.js')>(),
    createLogger: (scope: string) => Object.fromEntries(
      ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => [level, record(scope, level)]),
    ),
  };
});

import { DesktopClaudeAuthAdapter, DesktopCodexAuthAdapter } from '../auth-adapters.js';
import { SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE } from '../shared-global-skills.js';

beforeEach(() => {
  state.owner = { dataOwnerId: 'a', generation: 1, mode: 'cloud' };
  state.boundary = false;
  state.bridge.mockReset().mockResolvedValue({ warnings: [], routingFailures: [] });
  state.links.mockReset();
  state.fingerprint = 'fp-1';
  state.logs = [];
});

describe('asset preparation boundaries', () => {
  it('rechecks plugin capability revocation and Skill projections at each launch', async () => {
    const skills = vi.fn(async () => true);
    // Avoid constructor credential reconciliation; exercise the real preparation entry points.
    const adapter = Object.assign(Object.create(DesktopCodexAuthAdapter.prototype), {
      pendingAssetsPrep: new PreparationCache(0),
      runEnsureGlobalCodexSkills: skills,
    }) as DesktopCodexAuthAdapter;
    Object.defineProperty(adapter, 'codexHome', { value: 'unused-test-home' });
    await adapter.ensureGlobalCodexAssets();
    state.bridge.mockResolvedValueOnce({ warnings: [], routingFailures: ['revoked'] });
    await expect(adapter.ensureGlobalCodexAssets()).rejects.toThrow('Cannot start Codex safely');
    expect(skills).toHaveBeenCalledTimes(2);
    expect(state.bridge).toHaveBeenCalledTimes(2);
    state.bridge.mockRejectedValueOnce(new Error('unreadable'));
    await expect(adapter.ensureGlobalCodexAssets()).rejects.toThrow('unreadable');
  });

  it('does not reuse a completion across owner generations or an in-progress boundary', async () => {
    const prepare = vi.fn(async () => true);
    const adapter = Object.assign(Object.create(DesktopClaudeAuthAdapter.prototype), {
      sharedSkillsPreparation: new PreparationCache(30_000), runEnsureSharedGlobalSkills: prepare,
    }) as DesktopClaudeAuthAdapter;
    await adapter.ensureSharedGlobalSkills();
    await adapter.ensureSharedGlobalSkills();
    expect(prepare).toHaveBeenCalledTimes(1);
    state.boundary = true;
    await adapter.ensureSharedGlobalSkills();
    await adapter.ensureSharedGlobalSkills();
    expect(prepare).toHaveBeenCalledTimes(3);
    state.boundary = false; state.owner.generation++;
    await adapter.ensureSharedGlobalSkills();
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  // Regression (idle CPU): the default sync opt-out and user-owned conflicting paths were
  // returned as warnings, so the 30s completion cache never held and every agent env build
  // re-ran the whole projection and re-logged the same lines. Unit tier, in-process fakes.
  it('caches past persistent projection warnings, reports them once, and reruns on input changes', async () => {
    const conflict = 'cannot link skill x from a to b: path exists and is not a managed symlink/junction';
    const persistent = [SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE, conflict];
    state.links.mockResolvedValue({ warnings: persistent, persistentWarnings: persistent });
    const adapter = new DesktopClaudeAuthAdapter();
    await adapter.ensureSharedGlobalSkills();
    await adapter.ensureSharedGlobalSkills();
    expect(state.links).toHaveBeenCalledTimes(1);
    const reported = () => state.logs.filter((entry) => entry.scope === 'auth-adapters:asset-prep');
    expect(reported()).toEqual([
      { level: 'info', scope: 'auth-adapters:asset-prep', warning: SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE },
      { level: 'warn', scope: 'auth-adapters:asset-prep', warning: conflict },
    ]);

    // A settings toggle or root listing change must not be hidden by the cache;
    // the unchanged persistent set is not reported again.
    state.fingerprint = 'fp-2';
    await adapter.ensureSharedGlobalSkills();
    expect(state.links).toHaveBeenCalledTimes(2);
    expect(reported()).toHaveLength(2);

    // A retryable failure still defeats the cache and is reported every run.
    state.fingerprint = 'fp-3';
    state.links.mockResolvedValue({ warnings: ['cannot link skill y: EACCES'], persistentWarnings: [] });
    await adapter.ensureSharedGlobalSkills();
    await adapter.ensureSharedGlobalSkills();
    expect(state.links).toHaveBeenCalledTimes(4);
    expect(reported().slice(2).map((entry) => entry.warning)).toEqual([
      'cannot link skill y: EACCES',
      'cannot link skill y: EACCES',
    ]);
  });
});
