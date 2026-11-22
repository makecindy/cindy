import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureUserDataDir, configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { ownerScopedPath } from '../../../desktop/src/main/ownerContext.ts';
import { configureHostOwner } from './claude-auth.mjs';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-draft-preferences-'));
configureUserDataDir(profile);
configureAppDataDir(profile);
configureHostOwner({ userDataDir: profile, ownerId: 'draft-preferences-test' });
import {
  applyHostNewMakerDraftPref,
  applyHostNewMakerWorktreePref,
  getHostNewMakerDefaults,
  resetHostDraftPreferencesForTest,
  resetHostDraftPreferencesReadCacheForTest,
} from './remote-draft-preferences.ts';
import { getRemoteNewMakerDefaults } from '../../../desktop/src/main/maker-host/newMakerDefaultsCache.ts';

/*
 * Test value (engineering-conventions §3.2)
 * - Production entry and observable result: controller writes are readable through
 *   getRemoteNewMakerDefaults, the same reader used by the Device Link channel.
 * - Bug/rule basis: a Host has no renderer mirror; acknowledging a preference write
 *   without storing it would lose the user's model and worktree choices.
 * - Existing coverage gap: defaults reads were covered, but writes and read-back were not.
 * - Minimal failing input: select one model and worktree=true, then read them back;
 *   an empty or no-op implementation returns defaults instead of these values.
 * - Tier: unit; no renderer, network, account or real filesystem involved.
 */
test('draft preferences update the shared defaults reader and preserve later choices', t => {
  resetHostDraftPreferencesForTest();
  t.after(() => { resetHostDraftPreferencesForTest(); fs.rmSync(profile, { recursive: true, force: true }); });

  const selected = applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'inferx', modelId: 'kimi-k3.1-pro', active: true,
    markModelChoice: true, selectDraftAgent: true, effort: 'max', fast: true, thinking: false,
  });
  assert.equal(selected.model, 'kimi-k3.1-pro');
  assert.equal(selected.providerId, 'inferx');
  assert.equal(selected.effort, 'max');
  assert.equal(selected.fastMode, true);
  assert.equal(selected.modelChosenByUser, true);
  assert.equal(selected.selectedAgentKind, 'pi');
  assert.equal(selected.providerModelMemory['pi:*'].effortByModel['kimi-k3.1-pro'], 'max');
  assert.equal(selected.providerModelMemory['pi:*'].thinkingByModel['kimi-k3.1-pro'], false);
  const persisted = JSON.parse(fs.readFileSync(ownerScopedPath('host-new-maker-defaults.json'), 'utf8'));
  assert.equal(persisted.lastByVendor.pi.model, 'kimi-k3.1-pro');
  assert.equal(persisted.providerModelMemory['pi:*'].effortByModel['kimi-k3.1-pro'], 'max');

  const worktree = applyHostNewMakerWorktreePref({ worktreeEnabled: true });
  assert.equal(worktree.pi.worktreeEnabled, true);

  const later = applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'inferx', modelId: 'deepseek-flash', active: false, effort: 'low',
  });
  assert.equal(later.model, 'kimi-k3.1-pro', 'a memory-only update must not replace the selection');
  assert.equal(later.providerModelMemory['pi:*'].effortByModel['deepseek-flash'], 'low');
  assert.equal(getRemoteNewMakerDefaults('pi').worktreeEnabled, true);
});

test('the first read after a restart reloads persisted model and worktree preferences', t => {
  resetHostDraftPreferencesForTest();
  t.after(() => resetHostDraftPreferencesForTest());
  applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'inferx', modelId: 'kimi-k3.1-pro', active: true,
    markModelChoice: true, selectDraftAgent: true, effort: 'max', fast: true, thinking: false,
  });
  applyHostNewMakerWorktreePref({ worktreeEnabled: true });

  // Same profile, different account: switching back must recover the first owner's choices.
  configureHostOwner({ userDataDir: profile, ownerId: 'second-owner' });
  try {
    const other = getHostNewMakerDefaults('pi');
    assert.equal(other.model, undefined);
    assert.equal(other.providerModelMemory?.['pi:*'], undefined);
    applyHostNewMakerWorktreePref({ worktreeEnabled: false });
  } finally {
    configureHostOwner({ userDataDir: profile, ownerId: 'draft-preferences-test' });
  }
  // Clear both the Host snapshot and the shared Desktop-style in-memory mirror,
  // but keep host-new-maker-defaults.json, exactly as a process restart would.
  resetHostDraftPreferencesReadCacheForTest();
  const selected = getHostNewMakerDefaults('pi');
  assert.equal(selected.model, 'kimi-k3.1-pro');
  assert.equal(selected.providerId, 'inferx');
  assert.equal(selected.effort, 'max');
  assert.equal(selected.fastMode, true);
  assert.equal(selected.worktreeEnabled, true);
  assert.equal(selected.selectedAgentKind, 'pi');
  assert.equal(selected.providerModelMemory['pi:*'].thinkingByModel['kimi-k3.1-pro'], false);
});

test('draft preference validation rejects unsupported agents and missing model IDs', t => {
  resetHostDraftPreferencesForTest();
  t.after(() => resetHostDraftPreferencesForTest());
  assert.throws(() => applyHostNewMakerDraftPref({ agent: 'other', modelId: 'm' }), /INVALID_PARAMS/);
  assert.throws(() => applyHostNewMakerDraftPref({ agent: 'pi', modelId: '' }), /INVALID_PARAMS/);
  assert.throws(() => applyHostNewMakerWorktreePref({ worktreeEnabled: 'yes' }), /INVALID_PARAMS/);
});
