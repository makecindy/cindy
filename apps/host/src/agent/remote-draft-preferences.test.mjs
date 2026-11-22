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
import { applyNewMakerWorktreeBranchPreference, getNewMakerWorktreeBranchPreference } from './worktree-branch-preferences.ts';
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
 * - Tier: unit; no renderer, network or account; a temporary profile directory holds the file.
 */
test('draft preferences update the shared defaults reader and preserve later choices', async t => {
  await resetHostDraftPreferencesForTest();
  t.after(async () => { await resetHostDraftPreferencesForTest(); fs.rmSync(profile, { recursive: true, force: true }); });

  const selected = await applyHostNewMakerDraftPref({
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

  const worktree = await applyHostNewMakerWorktreePref({ worktreeEnabled: true });
  assert.equal(worktree.pi.worktreeEnabled, true);

  const later = await applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'inferx', modelId: 'deepseek-flash', active: false, effort: 'low',
  });
  assert.equal(later.model, 'kimi-k3.1-pro', 'a memory-only update must not replace the selection');
  assert.equal(later.providerModelMemory['pi:*'].effortByModel['deepseek-flash'], 'low');
  assert.equal(getRemoteNewMakerDefaults('pi').worktreeEnabled, true);
});

test('the first read after a restart reloads persisted model and worktree preferences', async t => {
  await resetHostDraftPreferencesForTest();
  t.after(() => resetHostDraftPreferencesForTest());
  await applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'inferx', modelId: 'kimi-k3.1-pro', active: true,
    markModelChoice: true, selectDraftAgent: true, effort: 'max', fast: true, thinking: false,
  });
  await applyHostNewMakerWorktreePref({ worktreeEnabled: true });

  // Same profile, different account: switching back must recover the first owner's choices.
  configureHostOwner({ userDataDir: profile, ownerId: 'second-owner' });
  try {
    const other = await getHostNewMakerDefaults('pi');
    assert.equal(other.model, undefined);
    assert.equal(other.providerModelMemory?.['pi:*'], undefined);
    await applyHostNewMakerWorktreePref({ worktreeEnabled: false });
  } finally {
    configureHostOwner({ userDataDir: profile, ownerId: 'draft-preferences-test' });
  }
  // Clear both the Host snapshot and the shared Desktop-style in-memory mirror,
  // but keep host-new-maker-defaults.json, exactly as a process restart would.
  resetHostDraftPreferencesReadCacheForTest();
  const selected = await getHostNewMakerDefaults('pi');
  assert.equal(selected.model, 'kimi-k3.1-pro');
  assert.equal(selected.providerId, 'inferx');
  assert.equal(selected.effort, 'max');
  assert.equal(selected.fastMode, true);
  assert.equal(selected.worktreeEnabled, true);
  assert.equal(selected.selectedAgentKind, 'pi');
  assert.equal(selected.providerModelMemory['pi:*'].thinkingByModel['kimi-k3.1-pro'], false);
});

test('draft preference validation rejects unsupported agents and missing model IDs', async t => {
  await resetHostDraftPreferencesForTest();
  t.after(() => resetHostDraftPreferencesForTest());
  await assert.rejects(applyHostNewMakerDraftPref({ agent: 'other', modelId: 'm' }), /INVALID_PARAMS/);
  await assert.rejects(applyHostNewMakerDraftPref({ agent: 'pi', modelId: '' }), /INVALID_PARAMS/);
  await assert.rejects(applyHostNewMakerWorktreePref({ worktreeEnabled: 'yes' }), /INVALID_PARAMS/);
});

/*
 * Test value (engineering-conventions §3.2)
 * - Production entry and observable result: applyHostNewMakerDraftPref, the Host handler of
 *   maker:apply-new-maker-draft-pref; the defaults a controller reads back keep the user's choice.
 * - Bug/rule basis (Greptile P1 on #12125): an effort or Fast change on the draft arrives as
 *   active=true, markModelChoice=false. The desktop draft (newMakerDraft.ts patchVendorPrefsInternal)
 *   keeps an existing choice mark and never replaces that model or source; the Host cleared the mark.
 * - Existing coverage gap: only marking writes and memory-only writes were covered.
 * - Minimal failing input: choose kimi on inferx, then send effort=low with markModelChoice=false;
 *   before the fix modelChosenByUser became false, and another model's write replaced the choice.
 * - Tier: unit; a temporary profile directory holds the file.
 */
test('a draft write that does not mark a choice keeps the model the user chose', async t => {
  await resetHostDraftPreferencesForTest();
  t.after(() => resetHostDraftPreferencesForTest());
  await applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'inferx', modelId: 'kimi-k3.1-pro', active: true, markModelChoice: true, effort: 'max',
  });
  const sameModel = await applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'inferx', modelId: 'kimi-k3.1-pro', active: true, markModelChoice: false, effort: 'low',
  });
  assert.equal(sameModel.modelChosenByUser, true, 'the choice mark survives an effort change');
  assert.equal(sameModel.model, 'kimi-k3.1-pro');
  assert.equal(sameModel.effort, 'low', 'an effort change on the chosen model applies');
  const otherModel = await applyHostNewMakerDraftPref({
    agent: 'pi', providerId: 'llmhub', modelId: 'deepseek-flash', active: true, markModelChoice: false, effort: 'high',
  });
  assert.equal(otherModel.modelChosenByUser, true);
  assert.equal(otherModel.model, 'kimi-k3.1-pro', 'an unmarked write never replaces the chosen model');
  assert.equal(otherModel.providerId, 'inferx', 'or its source');
  assert.equal(otherModel.effort, 'low', 'and the other model effort does not land on the chosen one');
});

/*
 * Test value (engineering-conventions §3.2)
 * - Production entry and observable result: the Host draft and branch preference writes, as the
 *   Device Link handlers call them; every overlapping write is kept and revisions never repeat.
 * - Bug/rule basis (Greptile P2 on #12125, engineering-conventions §8.5): these handlers wrote with
 *   writeFileSync + renameSync on the Host event loop; the asynchronous store must still apply
 *   overlapping writes in order instead of letting one overwrite another.
 * - Existing coverage gap: writes were only issued one at a time.
 * - Minimal failing input: draft, worktree and two branch writes started together; an unordered
 *   asynchronous read-modify-write loses one of them and repeats a revision.
 * - Tier: unit; a temporary profile directory holds the files.
 */
test('overlapping preference writes are all kept, in order', async t => {
  await resetHostDraftPreferencesForTest();
  t.after(() => resetHostDraftPreferencesForTest());
  await Promise.all([
    applyHostNewMakerDraftPref({ agent: 'pi', providerId: 'inferx', modelId: 'a', active: false, effort: 'low' }),
    applyHostNewMakerDraftPref({ agent: 'pi', providerId: 'inferx', modelId: 'b', active: false, effort: 'max' }),
    applyHostNewMakerWorktreePref({ worktreeEnabled: true }),
  ]);
  const persisted = JSON.parse(fs.readFileSync(ownerScopedPath('host-new-maker-defaults.json'), 'utf8'));
  assert.deepEqual(persisted.effortByModel, { a: 'low', b: 'max' });
  assert.equal(persisted.worktreeEnabled, true);

  const repo = path.join(profile, 'branch-repo');
  const before = (await getNewMakerWorktreeBranchPreference(repo))?.revision ?? 0;
  const [first, second] = await Promise.all([
    applyNewMakerWorktreeBranchPreference({ baseRepo: repo, sourceBranch: 'main' }),
    applyNewMakerWorktreeBranchPreference({ baseRepo: repo, sourceBranch: 'dev' }),
  ]);
  assert.deepEqual([first.revision, second.revision], [before + 1, before + 2]);
  assert.equal((await getNewMakerWorktreeBranchPreference(repo)).sourceBranch, 'dev');
});
