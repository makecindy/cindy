import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreparationCache } from '../preparation-cache.js';

const state = vi.hoisted(() => ({
  owner: { dataOwnerId: 'a', generation: 1, mode: 'cloud' },
  boundary: false,
  bridge: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: true }, safeStorage: {} }));
vi.mock('@cindy/maker-core', () => ({}));
vi.mock('../../appSessionState.js', async (original) => ({
  ...await original<typeof import('../../appSessionState.js')>(),
  getActiveAppSession: () => ({ ...state.owner }),
  isAppSessionBoundaryPending: () => state.boundary,
}));
vi.mock('../codex-global-plugins.js', () => ({ prepareCodexGlobalPluginsBridge: state.bridge }));

import { DesktopClaudeAuthAdapter, DesktopCodexAuthAdapter } from '../auth-adapters.js';

beforeEach(() => {
  state.owner = { dataOwnerId: 'a', generation: 1, mode: 'cloud' };
  state.boundary = false;
  state.bridge.mockReset().mockResolvedValue({ warnings: [], routingFailures: [] });
});

describe('asset preparation boundaries', () => {
  it('rechecks plugin capability revocation even while successful Skill preparation is cached', async () => {
    const skills = vi.fn(async () => true);
    // Avoid constructor credential reconciliation; exercise the real preparation entry points.
    const adapter = Object.assign(Object.create(DesktopCodexAuthAdapter.prototype), {
      pendingAssetsPrep: new PreparationCache(0),
      skillAssetsPrep: new PreparationCache(30_000), runEnsureGlobalCodexSkills: skills,
    }) as DesktopCodexAuthAdapter;
    Object.defineProperty(adapter, 'codexHome', { value: 'unused-test-home' });
    await adapter.ensureGlobalCodexAssets();
    state.bridge.mockResolvedValueOnce({ warnings: [], routingFailures: ['revoked'] });
    await expect(adapter.ensureGlobalCodexAssets()).rejects.toThrow('Cannot start Codex safely');
    expect(skills).toHaveBeenCalledTimes(1);
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
});
