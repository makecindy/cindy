import syncFs from 'node:fs';
import os from 'node:os';
import type { AgentDeps } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCrossProcessLock } from '../../device-link/crossProcessLock.js';
import { requirementsOrigin } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';
import { normalizeRuleGroup } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize.js';
import { readClaudeLiveUserRules, readClaudePersonalRules, readClaudeLiveSourceContents } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/readers/claude-code.js';
import type { NativeSourceRegistration } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/readers/registration.js';
import type { RuleScope, UnifiedRule } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/types.js';
import { createApprovalRuleStore, type ApprovalRuleRefreshInput } from '../approval-rule-store.js';
import { createClaudeLiveUserRulesImporter, createCodexUserRuleContentImporter, readRegisteredApprovalRuleFiles } from '../approval-rule-sources.js';

// Unit value: owner isolation, source preservation and saved/published/applied
// are observable store outcomes. Prior tests cover none of this new boundary.
// Minimal failures: invalid source beside a valid one, project overlay, old IDs.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const scope = (projectId = '/project/A'): RuleScope => ({ ownerId: 'A', executionHostId: 'host', projectId, harnesses: ['claude-code'] });
const native = (decision: 'allow' | 'deny', layer: 'user' | 'project' = 'user', projectId?: string): UnifiedRule =>
  normalizeRuleGroup({ harness: 'claude-code', layer, locator: '/trusted/settings.json',
    sourceId: 'cc:' + layer + ':/trusted/settings.json', dialectVersion: 'permissions-v1', decisionDomain: 'personal-approval' },
  { ...scope(projectId), projectId: layer === 'user' ? undefined : projectId },
  [{ id: 'native', original: 'Bash(git push:*)', decision,
    matcher: { kind: 'cc-command', pattern: 'git push', mode: 'prefix' } }]);
const available = (group: UnifiedRule) => ({ kind: 'available' as const, group });
const managed = (sourceId: string, projectId?: string, executionHostId = 'host'): UnifiedRule =>
  normalizeRuleGroup({ harness: 'cindy', layer: projectId ? 'project' : 'user',
    locator: 'cindy:managed:' + sourceId, sourceId, dialectVersion: 'managed-v1',
    decisionDomain: 'personal-approval' },
  { ownerId: 'A', executionHostId, projectId, harnesses: ['claude-code'] },
  [{ id: 'deny', original: 'Bash(git push)', decision: 'deny',
    matcher: { kind: 'cc-command', pattern: 'git push', mode: 'exact' } }]);
async function setup(ownerId = 'A') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-rule-store-'));
  roots.push(root);
  let current = ownerId;
  const ownerDataDir = path.join(root, 'owners', ownerId);
  const store = createApprovalRuleStore({ ownerId, ownerDataDir, assertCurrent: () => {
    if (current !== ownerId) throw new Error('Owner changed');
  } });
  return { ownerDataDir, store, assertCurrent: () => { if (current !== ownerId) throw new Error('Owner changed'); },
    switchOwner: (id: string) => { current = id; } };
}

describe('owner approval rule store', () => {
  // Unit: exact UTF-8 aggregate limits are checked independently in draft and
  // effective groups, before any writes. Reference copies/tombstones do not
  // consume the budget. Prior exact rules have no requirements size contract.
  it.each((['claude-code', 'pi', 'codex'] as const).flatMap(harness => (['draft', 'effective'] as const).map(view => ({ harness, view }))))(
    'rejects only bytes above 64 KiB in the $harness $view requirements view', async ({ harness, view }) => {
    const h = await setup(); const ownScope = { ...scope(), projectId: undefined, harnesses: [harness] };
    const tool = harness === 'pi' ? 'bash' as const : harness === 'codex' ? 'exec' as const : 'Bash' as const;
    const requirement = (key: string, text: string) => normalizeRuleGroup(requirementsOrigin(key), ownScope,
      [{ id: 'requirement', original: text, decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec', name: tool } }]);
    const large = requirement('large', '🧪'.repeat(16383)); // 65532 UTF-8 bytes.
    const small = requirement('small', 'é');
    small.clauses.push({ id: 'known', original: 'é', decision: 'allow', tool: { domain: 'exec', name: tool },
      matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' } }); // 4 more bytes total.
    expect([...large.clauses, ...small.clauses].reduce((n, c) => n + Buffer.byteLength(c.original, 'utf8'), 0)).toBe(65536);
    let saved = await h.store.applyManagedEdit(0, ownScope, [large, small], [], undefined, view === 'effective');
    if (view === 'effective') saved = await h.store.applyManagedEdit(saved.revision, ownScope, [], [large.id]);
    // The effective overflow cannot be hidden by the unrelated draft removal.
    const draftFile = path.join(h.ownerDataDir, 'command-approval-rules.json');
    const beforeDraft = await fs.readFile(draftFile), beforeMarker = h.store.getAppliedState();
    const revisions = path.join(h.ownerDataDir, 'command-approval-runtime', 'revisions');
    const beforeArtifacts = syncFs.existsSync(revisions) ? await fs.readdir(revisions) : [];
    const tooLarge = structuredClone(small); tooLarge.clauses[1]!.original += 'x';
    await expect(h.store.applyManagedEdit(saved.revision, ownScope, [tooLarge], [], undefined, view === 'effective')).rejects.toThrow('64 KiB');
    expect(await fs.readFile(draftFile)).toEqual(beforeDraft); expect(h.store.getAppliedState()).toEqual(beforeMarker);
    expect(syncFs.existsSync(revisions) ? await fs.readdir(revisions) : []).toEqual(beforeArtifacts);
    // A separate project has its own budget. Its shadow baseline is a reference,
    // so the large personal original is not counted a second time in the project.
    const projectScope = { ...ownScope, projectId: '/project/B' };
    const project = normalizeRuleGroup(large.origin, projectScope, large.clauses);
    const accepted = await h.store.applyManagedEdit(saved.revision, projectScope, [project]);
    expect(accepted.groups.find(group => group.id === project.id)?.clauses[0]?.original).toBe(large.clauses[0]!.original);
    const deletion = await h.store.applyManagedEdit(accepted.revision, projectScope, [], [project.id]);
    expect(deletion.groups.some(group => group.id === project.id)).toBe(false);
  });

  // Real lock/write/reopen behavior: a batch cannot partially activate, reuse
  // an orphan revision, or pull an unrelated draft into the effective artifact.
  it.each(['artifact', 'draft', 'marker'] as const)('recovers an explicit three-target batch after %s failure without mutating old artifacts', async failure => {
    const { store, ownerDataDir } = await setup();
    const batchScope: RuleScope = { ...scope(), projectId: undefined, harnesses: ['claude-code', 'pi', 'codex'] };
    const edits = (decision: 'deny' | 'allow') => (['claude-code', 'pi', 'codex'] as const).map(harness => {
      const source = harness === 'codex' ? 'exact-codex-command:fixture' : 'exact-bash:fixture';
      return normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: source,
        locator: 'cindy://personal-approval/' + source, dialectVersion: '1', decisionDomain: 'personal-approval' },
      { ...batchScope, harnesses: [harness] }, [{ id: 'fixture', original: 'git push', decision,
        tool: { domain: 'exec', name: harness === 'claude-code' ? 'Bash' : harness === 'pi' ? 'bash' : 'exec' },
        matcher: { kind: 'cc-command', pattern: 'git push', mode: 'exact' } }]);
    });
    const nativeGroup = native('deny');
    await store.applySourceRefresh(0, [available(nativeGroup)]); await store.publish(1);
    let saved = await store.applyManagedEdit(1, batchScope, edits('deny'), [], undefined, true, true);
    const unrelated = managed('unselected-draft');
    saved = await store.applyManagedEdit(saved.revision, unrelated.scope, [unrelated]);
    const runtime = path.join(ownerDataDir, 'command-approval-runtime');
    const marker = path.join(runtime, 'publish-state.json');
    const markerBytes = await fs.readFile(marker);
    await expect(store.applyManagedEdit(saved.revision - 1, batchScope, edits('allow'), [], undefined, true, true)).rejects.toThrow('revision changed');
    expect(await fs.readFile(marker)).toEqual(markerBytes);
    const artifact = (revision: number) => path.join(runtime, 'revisions', String(revision), 'snapshot.json');
    const originals = await Promise.all([1, 2].map(async revision => [revision, await fs.readFile(artifact(revision))] as const));
    const rename = syncFs.renameSync;
    const fault = vi.spyOn(syncFs, 'renameSync').mockImplementation((from, to) => {
      const target = String(to);
      if ((failure === 'marker' && target === marker)
        || (failure === 'draft' && target.endsWith('/command-approval-rules.json'))
        || (failure === 'artifact' && target.endsWith('/snapshot.json')))
        throw Object.assign(new Error('batch fixture write failure'), { code: 'EIO' });
      return rename(from, to);
    });
    try { await expect(store.applyManagedEdit(saved.revision, batchScope, edits('allow'), [], undefined, true, true)).rejects.toThrow('batch fixture write failure'); }
    finally { fault.mockRestore(); }
    expect(await fs.readFile(marker)).toEqual(markerBytes);
    const oldEffective = JSON.parse(await fs.readFile(artifact(2), 'utf8'));
    expect(oldEffective.groups.filter((group: UnifiedRule) => group.origin.harness === 'cindy').map((group: UnifiedRule) => group.clauses[0]?.decision)).toEqual(['deny', 'deny', 'deny']);
    const orphaned = await Promise.all((await fs.readdir(path.join(runtime, 'revisions'))).map(async revision => {
      try { return [Number(revision), await fs.readFile(artifact(Number(revision)))] as const; } catch { return null; }
    }));
    const fresh = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent: () => {} });
    saved = await fresh.readSnapshot(batchScope);
    const retried = await fresh.applyManagedEdit(saved.revision, batchScope, edits('allow'), [], undefined, true, true);
    expect(retried.revision).toBeGreaterThan(Math.max(...orphaned.flatMap(entry => entry ? [entry[0]] : [])));
    const effective = JSON.parse(await fs.readFile(artifact(retried.revision), 'utf8'));
    expect(effective.groups.some((group: UnifiedRule) => group.id === unrelated.id)).toBe(false);
    expect(effective.groups.find((group: UnifiedRule) => group.id === nativeGroup.id)).toEqual(oldEffective.groups.find((group: UnifiedRule) => group.id === nativeGroup.id));
    expect(effective.groups.filter((group: UnifiedRule) => group.origin.harness === 'cindy').map((group: UnifiedRule) => group.clauses[0]?.decision)).toEqual(['allow', 'allow', 'allow']);
    await fresh.publish(retried.revision);
    expect(fresh.getAppliedState().generatedRevision).toBeGreaterThan(retried.revision);
    for (const entry of [...originals, ...orphaned.filter(entry => entry !== null)])
      expect(await fs.readFile(artifact(entry[0]))).toEqual(entry[1]);
  });

  // Actual draft/artifact separation: reference maintenance cannot activate an unrelated project draft.
  it('reconciles project references against draft and effective policy independently', async () => {
    const { store, ownerDataDir } = await setup();
    const userScope = { ...scope(), projectId: undefined };
    const origin = { harness: 'cindy' as const, layer: 'user' as const, sourceId: 'exact-bash:push',
      locator: 'cindy://personal-approval/exact-bash/push', dialectVersion: '1', decisionDomain: 'personal-approval' as const };
    const clauses = [{ id: 'push', original: 'Bash(git push)', decision: 'deny' as const,
      matcher: { kind: 'cc-command' as const, mode: 'exact' as const, pattern: 'git push' },
      tool: { domain: 'exec' as const, name: 'Bash' } }];
    const user = normalizeRuleGroup(origin, userScope, clauses);
    const project = normalizeRuleGroup(origin, scope(), clauses.map(clause => ({ ...clause, decision: 'ask' as const })));
    let saved = await store.applyManagedEdit(0, project.scope, [project]);
    saved = await store.applyManagedEdit(saved.revision, user.scope, [user], [], undefined, true);
    const fresh = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent: () => {},
      resolveManagedConsumer: () => ({ scope: scope(), sessionId: 'task', sessionInstanceId: 'instance' }) });
    let active = await fresh.readPublishedManagedSnapshot();
    expect(active.kind === 'published-managed' && active.groups.map(group => group.clauses[0]?.decision)).toEqual(['deny']);
    saved = await store.applyManagedEdit(saved.revision, project.scope, [project], [], undefined, true);
    const draftAllow = normalizeRuleGroup(origin, project.scope, clauses.map(clause => ({ ...clause, decision: 'allow' as const })));
    saved = await store.applyManagedEdit(saved.revision, project.scope, [draftAllow]);
    saved = await store.applyManagedEdit(saved.revision, user.scope, [user], [], undefined, true);
    active = await fresh.readPublishedManagedSnapshot();
    expect(active.kind === 'published-managed' && active.groups.map(group => group.clauses[0]?.decision)).toEqual(['ask']);
    expect((await store.readSnapshot(scope())).groups[0]?.clauses[0]?.decision).toBe('allow');
    // A failed removal has changed draft only. Its detached references must not poison the active project.
    const marker = path.join(ownerDataDir, 'command-approval-runtime', 'publish-state.json');
    const oldMarker = await fs.readFile(marker);
    const originalRename = syncFs.renameSync;
    const fault = vi.spyOn(syncFs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === marker) throw Object.assign(new Error('marker failure'), { code: 'EIO' });
      return originalRename(from, to);
    });
    try { await expect(store.applyManagedEdit(saved.revision, user.scope, [], [user.id], undefined, true)).rejects.toThrow(); }
    finally { fault.mockRestore(); }
    expect(await fs.readFile(marker)).toEqual(oldMarker);
    active = await fresh.readPublishedManagedSnapshot();
    expect(active.kind === 'published-managed' && active.groups.map(group => group.clauses[0]?.decision)).toEqual(['ask']);
    const failedDraft = await store.readSnapshot(userScope);
    await store.applyManagedEdit(failedDraft.revision, user.scope, [user], [], undefined, true);
    active = await fresh.readPublishedManagedSnapshot();
    expect(active.kind === 'published-managed' && active.groups.map(group => group.clauses[0]?.decision)).toEqual(['ask']);
  });
  // Unit regression: changing the production host identity used to hide a
  // published local exact-bash deny. Save/publish must preserve every byte;
  // consumption must name the conflict instead of returning an empty policy.
  it.each(['save', 'publish', 'consume'] as const)(
    'reports an old command host during %s without changing saved or published bytes', async operation => {
      const { ownerDataDir, store, assertCurrent } = await setup();
      const base = managed('exact-bash:old', undefined, 'old-relay-id');
      const old = normalizeRuleGroup({ ...base.origin,
        locator: 'cindy://personal-approval/exact-bash/old', dialectVersion: '1' }, base.scope, base.clauses);
      await store.applyManagedEdit(0, old.scope, [old]);
      await store.publish(1);
      const files = ['command-approval-rules.json', 'command-approval-runtime/publish-state.json',
        'command-approval-runtime/revisions/1/snapshot.json'];
      const before = await Promise.all(files.map(file => fs.readFile(path.join(ownerDataDir, file))));
      const guarded = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent,
        localManagedCommandHostId: 'host', resolveManagedConsumer: () => ({
          scope: scope(), sessionId: 'session', sessionInstanceId: 'instance' }) });
      if (operation === 'save') await expect(guarded.applyManagedEdit(1, managed('new').scope, [managed('new')]))
        .rejects.toMatchObject({ code: 'host-identity-conflict' });
      if (operation === 'publish') await expect(guarded.publish(1))
        .rejects.toMatchObject({ code: 'host-identity-conflict' });
      if (operation === 'consume') expect(await guarded.readPublishedManagedSnapshot())
        .toMatchObject({ kind: 'unavailable', reason: 'host-identity-conflict' });
      expect(await Promise.all(files.map(file => fs.readFile(path.join(ownerDataDir, file))))).toEqual(before);
    });

  // User edits immediately activate only the explicit CC delta; legacy draft
  // publication cannot rewrite its immutable artifact under the same revision.
  it('activates only the edited group and never overwrites an existing artifact', async () => {
    const { store, ownerDataDir } = await setup();
    const unrelated = managed('unpublished');
    const edited = managed('edited');
    await store.applyManagedEdit(0, unrelated.scope, [unrelated]);
    await store.applyManagedEdit(1, edited.scope, [edited], [], undefined, true);
    const active = await store.readPublishedSnapshot(scope(), { qualifiedSourceIds: [] });
    expect(active.kind).toBe('published');
    if (active.kind !== 'published') return;
    expect(active.snapshot.groups.map(g => g.id)).toEqual([edited.id]);
    const artifact = path.join(ownerDataDir, 'command-approval-runtime/revisions', String(active.snapshot.revision), 'snapshot.json');
    const bytes = await fs.readFile(artifact);
    await store.publish(2);
    expect(await fs.readFile(artifact)).toEqual(bytes);
    expect(store.getAppliedState().generatedRevision).toBeGreaterThan(active.snapshot.revision);
  });

  it.each((['claude-code', 'pi', 'codex'] as const).flatMap(harness =>
    (['artifact', 'draft', 'marker'] as const).map(failure => ({ harness, failure }))))(
    'retains the effective $harness deny when immediate $failure writing fails', async ({ harness, failure }) => {
    const { store, ownerDataDir } = await setup();
    const base = managed('edited');
    const denied = normalizeRuleGroup(base.origin, { ...base.scope, harnesses: [harness] },
      base.clauses.map(clause => {
        if (clause.decision === 'requirement') throw new Error('Expected existing deciding-rule fixture');
        return { ...clause, tool: { domain: 'exec', name: harness === 'pi' ? 'bash' : 'Bash' } };
      }));
    await store.applyManagedEdit(0, denied.scope, [denied], [], undefined, true);
    const before = store.getAppliedState();
    const artifact = path.join(ownerDataDir, 'command-approval-runtime/revisions', String(before.generatedRevision), 'snapshot.json');
    const bytes = await fs.readFile(artifact);
    const rename = syncFs.renameSync;
    const spy = vi.spyOn(syncFs, 'renameSync').mockImplementation((from, to) => {
      const target = String(to);
      if ((failure === 'marker' && target.endsWith('/publish-state.json'))
        || (failure === 'draft' && target.endsWith('/command-approval-rules.json'))
        || (failure === 'artifact' && target.endsWith('/snapshot.json')))
        throw Object.assign(new Error('fixture write failure'), { code: 'EIO' });
      return rename(from, to);
    });
    try {
      await expect(store.applyManagedEdit(1, denied.scope,
        [{ ...denied, clauses: [{ ...denied.clauses[0]!, decision: 'allow' }] }], [], undefined, true)).rejects.toThrow('fixture write failure');
    } finally { spy.mockRestore(); }
    expect(store.getAppliedState()).toEqual(before);
    expect(await fs.readFile(artifact)).toEqual(bytes);
    const effective = await store.readPublishedSnapshot({ ...scope(), harnesses: [harness] }, { qualifiedSourceIds: [] });
    expect(effective.kind === 'published' && effective.snapshot.groups[0]?.clauses[0]?.decision).toBe('deny');
  });

  // Restart regression: an orphan artifact and an unrelated draft deletion must
  // neither replace effective policy nor make a revision reusable.
  it('recovers after restart without activating unrelated draft tombstones or rewriting orphan artifacts', async () => {
    const { store, ownerDataDir, assertCurrent } = await setup();
    const edited = managed('restart-edited');
    const unrelated = managed('restart-unrelated');
    await store.applyManagedEdit(0, edited.scope, [edited, unrelated], [], undefined, true);
    const artifact = (revision: number) => path.join(ownerDataDir,
      'command-approval-runtime/revisions', String(revision), 'snapshot.json');
    const firstBytes = await fs.readFile(artifact(1));
    const rename = syncFs.renameSync;
    const spy = vi.spyOn(syncFs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('/publish-state.json'))
        throw Object.assign(new Error('marker failure'), { code: 'EIO' });
      return rename(from, to);
    });
    try {
      await expect(store.applyManagedEdit(1, edited.scope,
        [{ ...edited, clauses: [{ ...edited.clauses[0]!, decision: 'allow' }] }],
        [], undefined, true)).rejects.toThrow('marker failure');
    } finally { spy.mockRestore(); }
    const orphanBytes = await fs.readFile(artifact(2));
    await store.applyManagedEdit(2, unrelated.scope, [], [unrelated.id]);
    const restarted = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent });
    const read = () => restarted.readPublishedSnapshot(scope(), { qualifiedSourceIds: [] });
    const previous = await read();
    expect(previous.kind === 'published' && previous.snapshot.groups.map(group =>
      [group.id, group.clauses[0]?.decision])).toEqual([
      [edited.id, 'deny'], [unrelated.id, 'deny'],
    ]);
    await restarted.applyManagedEdit(3, edited.scope,
      [{ ...edited, clauses: [{ ...edited.clauses[0]!, decision: 'ask' }] }],
      [], undefined, true);
    const active = await read();
    expect(active.kind).toBe('published');
    if (active.kind !== 'published') return;
    expect(active.snapshot.revision).toBe(4);
    expect(active.snapshot.groups.map(group => [group.id, group.clauses[0]?.decision])).toEqual(
      expect.arrayContaining([[edited.id, 'ask'], [unrelated.id, 'deny']]));
    expect(active.snapshot.groups).toHaveLength(2);
    const fourthBytes = await fs.readFile(artifact(4));
    await restarted.publish(4);
    const legacy = await read();
    expect(legacy.kind === 'published' && legacy.snapshot.revision).toBe(5);
    expect(restarted.getAppliedState().generatedRevision).toBe(5);
    expect(legacy.kind === 'published' && legacy.snapshot.groups.map(group => group.id)).toEqual([edited.id]);
    expect(await fs.readFile(artifact(1))).toEqual(firstBytes);
    expect(await fs.readFile(artifact(2))).toEqual(orphanBytes);
    expect(await fs.readFile(artifact(4))).toEqual(fourthBytes);
    expect(JSON.parse(await fs.readFile(artifact(5), 'utf8')).revision).toBe(5);
  });

  it('retries an explicit deletion after marker failure without retiring any other draft source', async () => {
    const { store } = await setup(); const rule = managed('retry-delete');
    await store.applyManagedEdit(0, rule.scope, [rule], [], undefined, true);
    const rename = syncFs.renameSync;
    const spy = vi.spyOn(syncFs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('/publish-state.json')) throw Object.assign(new Error('marker failure'), { code: 'EIO' });
      return rename(from, to);
    });
    try { await expect(store.applyManagedEdit(1, rule.scope, [], [rule.id], undefined, true)).rejects.toThrow('marker failure'); }
    finally { spy.mockRestore(); }
    const draft = await store.readSnapshot(scope());
    const previous = await store.readPublishedSnapshot(scope(), { qualifiedSourceIds: [] });
    expect(previous.kind === 'published' && previous.snapshot.groups[0]?.id).toBe(rule.id);
    await store.applyManagedEdit(draft.revision, rule.scope, [], [rule.id], undefined, true);
    const active = await store.readPublishedSnapshot(scope(), { qualifiedSourceIds: [] });
    expect(active.kind === 'published' && active.snapshot.groups).toEqual([]);
    expect(store.getAppliedState().generatedRevision).toBeGreaterThan(draft.revision);
  });

  it('projects only published Cindy groups for a host-bound consumer, with native qualification unknown', async () => {
    const { ownerDataDir, assertCurrent, store } = await setup();
    const current = { scope: scope(), sessionId: 'session-1', sessionInstanceId: 'instance-1' };
    const reader = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent, localManagedCommandHostId: 'host',
      resolveManagedConsumer: () => current });
    const personal = managed('personal');
    const inProject = managed('project-a', '/project/A');
    const otherProject = managed('project-b', '/project/B');
    const otherHost = managed('other-host', undefined, 'host-B');
    await store.applySourceRefresh(0, [available(native('allow'))]);
    await store.applyManagedEdit(1, personal.scope, [personal]);
    await store.applyManagedEdit(2, inProject.scope, [inProject]);
    await store.applyManagedEdit(3, otherProject.scope, [otherProject]);
    await store.applyManagedEdit(4, otherHost.scope, [otherHost]);
    expect(await reader.readPublishedManagedSnapshot()).toMatchObject({ kind: 'unpublished' });
    await store.publish(5);
    const published = await reader.readPublishedManagedSnapshot();
    expect(published).toMatchObject({ kind: 'published-managed', revision: 5, nativeQualification: 'unknown' });
    if (published.kind !== 'published-managed') return;
    expect(published.groups.map(group => group.id).sort()).toEqual([personal.id, inProject.id].sort());
    current.scope = scope('/project/B');
    const projectB = await reader.readPublishedManagedSnapshot();
    expect(projectB.kind === 'published-managed' && projectB.groups.map(group => group.id).sort())
      .toEqual([personal.id, otherProject.id].sort());
    current.scope = { ...scope(), executionHostId: 'host-B' };
    const hostB = await reader.readPublishedManagedSnapshot();
    expect(hostB.kind === 'published-managed' && hostB.groups.map(group => group.id)).toEqual([otherHost.id]);
    current.scope = scope();
    await store.applyManagedEdit(5, personal.scope, [{ ...personal, clauses: [{ ...personal.clauses[0]!, decision: 'allow' }] }]);
    const stillPublished = await reader.readPublishedManagedSnapshot();
    expect(stillPublished).toMatchObject({ kind: 'published-managed', revision: 5 });
    expect(stillPublished.kind === 'published-managed'
      && stillPublished.groups.find(group => group.id === personal.id)?.clauses[0]?.decision).toBe('deny');
  });

  it('requires a stable host-owned consumer identity before projecting published rules', async () => {
    const { ownerDataDir, assertCurrent, store, switchOwner } = await setup();
    const personal = managed('personal');
    await store.applyManagedEdit(0, personal.scope, [personal]);
    await store.publish(1);
    expect(await store.readPublishedManagedSnapshot()).toMatchObject({ kind: 'unavailable' });
    let context: { scope: RuleScope; sessionId: string; sessionInstanceId: string } | null = null;
    const reader = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent,
      resolveManagedConsumer: () => context });
    expect(await reader.readPublishedManagedSnapshot()).toMatchObject({ kind: 'unavailable' });
    context = { scope: { ...scope(), projectId: undefined }, sessionId: 'session-1', sessionInstanceId: 'instance-1' };
    expect(await reader.readPublishedManagedSnapshot()).toMatchObject({ kind: 'unavailable' });
    context = { scope: scope(), sessionId: 'session-1', sessionInstanceId: 'instance-1' };
    expect(await reader.readPublishedManagedSnapshot()).toMatchObject({ kind: 'published-managed', revision: 1 });
    let calls = 0;
    const changed = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent,
      resolveManagedConsumer: () => ++calls === 1 ? context : { ...context!, sessionInstanceId: 'instance-2' } });
    expect(await changed.readPublishedManagedSnapshot()).toMatchObject({
      kind: 'unavailable', reason: 'managed-consumer-changed',
    });
    switchOwner('B');
    await expect(reader.readPublishedManagedSnapshot()).rejects.toThrow('Owner changed');
  });
  it('saves canonical user across projects, publishes explicitly, and never claims applied', async () => {
    const { store } = await setup();
    const denied = native('deny');
    const saved = await store.applySourceRefresh(0, [available(denied)]);
    expect(saved.snapshot.revision).toBe(1);
    expect(await store.readPublishedSnapshot(scope())).toMatchObject({ kind: 'unpublished' });
    expect((await store.readSnapshot(scope('/project/B'))).groups.map(group => group.id)).toEqual([denied.id]);
    expect(await store.publish(1)).toMatchObject({ requestedRevision: 1, generatedRevision: 1 });
    expect(await store.readPublishedSnapshot(scope('/project/B'), { qualifiedSourceIds: [denied.id] }))
      .toMatchObject({ kind: 'published', snapshot: { revision: 1 } });
    expect(store.getAppliedState()).toMatchObject({ generatedRevision: 1 });
    expect(store.getAppliedState()).not.toHaveProperty('appliedRevision');
  });

  it('project replacement masks only its source there and removal restores deny', async () => {
    const { store } = await setup();
    const denied = native('deny');
    await store.applySourceRefresh(0, [available(denied)]);
    const replacement = normalizeRuleGroup(denied.origin, scope(), [{ ...denied.clauses[0]!, decision: 'allow' }]);
    await store.applyProjectReplacement(1, scope(), denied.id, replacement);
    expect((await store.readSnapshot(scope())).groups.map(group => group.clauses[0]?.decision)).toEqual(['allow']);
    expect((await store.readSnapshot({ ...scope(), harnesses: ['claude-code', 'pi'] })).groups
      .map(group => group.clauses[0]?.decision)).toEqual(['allow']);
    expect((await store.readSnapshot(scope('/project/B'))).groups.map(group => group.clauses[0]?.decision)).toEqual(['deny']);
    const changedNative = await store.applySourceRefresh(2, [available(native('allow'))]);
    expect(changedNative.conflicts).toEqual([denied.id]);
    expect(changedNative.snapshot.revision).toBe(2);
    await store.applyProjectReplacement(2, scope(), denied.id);
    expect((await store.readSnapshot(scope())).groups.map(group => group.clauses[0]?.decision)).toEqual(['deny']);
  });

  it('keeps last valid deny on damaged import and does not lend A to unqualified B', async () => {
    const { store } = await setup();
    const denied = native('deny');
    await store.applySourceRefresh(0, [available(denied)]);
    const result = await store.applySourceRefresh(1, [
      { kind: 'unavailable', reason: 'source-invalid', sourceId: denied.id },
      available(native('allow', 'project', '/project/A')),
    ]);
    expect(result.conflicts).toEqual([denied.id]);
    expect(result.snapshot.revision).toBe(2);
    expect((await store.readSnapshot(scope())).groups[0]?.clauses[0]?.decision).toBe('deny');
    await store.publish(2);
    expect(await store.readPublishedSnapshot(scope('/project/B'), { qualifiedSourceIds: [] }))
      .toMatchObject({ kind: 'unavailable' });
  });

  it('keeps last valid deny for every same-ID mixed-source conflict while importing an independent source', async () => {
    const denied = native('deny');
    const collisions: ApprovalRuleRefreshInput[][] = [
      [{ kind: 'unavailable', reason: 'source-invalid', sourceId: denied.id }, available(native('allow'))],
      [available(native('allow')), { kind: 'unavailable', reason: 'source-invalid', sourceId: denied.id }],
      [available(native('allow')), available(native('deny'))],
    ];
    for (const collision of collisions) {
      const { store } = await setup();
      await store.applySourceRefresh(0, [available(denied)]);
      const result = await store.applySourceRefresh(1, [
        ...collision, available(native('allow', 'project', '/project/A')),
      ]);
      expect(result.conflicts).toEqual([denied.id]);
      expect(result.snapshot.revision).toBe(2);
      const saved = await store.readSnapshot(scope());
      expect(saved.groups.find(group => group.id === denied.id)?.clauses[0]?.decision).toBe('deny');
      expect(saved.groups.some(group => group.origin.layer === 'project' && group.clauses[0]?.decision === 'allow')).toBe(true);
    }
  });

  it('rejects mixed conflicting managed save atomically and owner switch blocks writes', async () => {
    const { store, ownerDataDir, switchOwner } = await setup();
    const denied = native('deny');
    await store.applySourceRefresh(0, [available(denied)]);
    const file = path.join(ownerDataDir, 'command-approval-rules.json');
    const before = await fs.readFile(file);
    await expect(store.applyManagedEdit(1, scope(), [native('allow'), native('allow', 'project', '/project/B')]))
      .rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(before);
    switchOwner('B');
    await expect(store.applySourceRefresh(1, [available(native('allow'))])).rejects.toThrow('Owner changed');
    expect(await fs.readFile(file)).toEqual(before);
  });

  it('retains old bytes on missing harnesses, old IDs, orphan tombstones and managed references', async () => {
    const cases: Array<[string, (group: UnifiedRule) => unknown]> = [
      ['missing-harnesses', group => ({ schemaVersion: 1, revision: 1, groups: [{ ...group, scope: { ownerId: 'A', executionHostId: 'host' } }], tombstones: [] })],
      ['old-id', group => ({ schemaVersion: 1, revision: 1, groups: [{ ...group, id: 'old-id' }], tombstones: [] })],
      ['orphan-tombstone', group => ({ schemaVersion: 1, revision: 1, groups: [group], tombstones: [{ id: 'old-deleted', revision: 1 }] })],
      ['managed-reference', group => ({ schemaVersion: 1, revision: 1, groups: [group], tombstones: [], managedOverrides: [{ id: 'old-managed', scope: group.scope, revision: 1, replacesSourceId: 'unknown' }] })],
    ];
    for (const [reason, make] of cases) {
      const { store, ownerDataDir } = await setup();
      const file = path.join(ownerDataDir, 'command-approval-rules.json');
      await fs.mkdir(ownerDataDir, { recursive: true });
      const raw = JSON.stringify(make(native('deny'))) + '\n';
      await fs.writeFile(file, raw);
      await expect(store.applySourceRefresh(1, [available(native('allow'))])).rejects.toMatchObject({ code: 'LEGACY_CONFLICT', reason });
      expect(await fs.readFile(file, 'utf8')).toBe(raw);
    }
  });

  it('restores saved and published revisions after restart without inventing application', async () => {
    const { store, ownerDataDir, assertCurrent } = await setup();
    const denied = native('deny');
    await store.applySourceRefresh(0, [available(denied)]);
    await store.publish(1);
    const reopened = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent });
    expect((await reopened.readSnapshot(scope())).groups.map(group => group.id)).toEqual([denied.id]);
    expect(await reopened.readPublishedSnapshot(scope(), { qualifiedSourceIds: [denied.id] }))
      .toMatchObject({ kind: 'published', snapshot: { revision: 1 } });
    expect(reopened.getAppliedState()).not.toHaveProperty('appliedRevision');
    await reopened.applySourceRefresh(1, [available(native('allow'))]);
    expect((await reopened.readSnapshot(scope())).groups[0]?.clauses[0]?.decision).toBe('allow');
    const published = await reopened.readPublishedSnapshot(scope(), { qualifiedSourceIds: [denied.id] });
    expect(published).toMatchObject({ kind: 'published', snapshot: { revision: 1 } });
  });

  it('serializes two store instances under the owner lock and rejects stale revision', async () => {
    const { store, ownerDataDir, assertCurrent } = await setup();
    const peer = createApprovalRuleStore({ ownerId: 'A', ownerDataDir, assertCurrent });
    const results = await Promise.allSettled([
      store.applySourceRefresh(0, [available(native('deny'))]),
      peer.applySourceRefresh(0, [available(native('allow', 'project', '/project/A'))]),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.readSnapshot(scope())).revision).toBe(1);
  });

  it('reads only the registered native file and preserves bytes when qualification fails', async () => {
    const { ownerDataDir } = await setup();
    const filePath = path.join(ownerDataDir, 'fixture-settings.json');
    const raw = '{"permissions":{"deny":["Bash(git push:*)"]}}\n';
    await fs.mkdir(ownerDataDir, { recursive: true });
    await fs.writeFile(filePath, raw);
    const registration: NativeSourceRegistration = {
      kind: 'host-effective-native-source', harness: 'claude-code', layer: 'user',
      canonicalLocator: await fs.realpath(filePath), ownerId: 'A', executionHostId: 'host',
      layerState: 'enabled', locatorState: 'canonical', projectState: 'not-applicable', harnesses: ['claude-code'],
    };
    const parsed = readClaudePersonalRules(JSON.parse(raw), registration);
    expect(parsed.kind).toBe('available');
    if (parsed.kind !== 'available') return;
    const source = { filePath, registration, previousGroupId: parsed.group.id };
    const result = await readRegisteredApprovalRuleFiles({ ownerId: 'A', executionHostId: 'host', sources: [source] });
    expect(result.qualifiedSourceIds).toEqual([parsed.group.id]);
    expect(result.inputs[0]).toMatchObject({ kind: 'available', group: { id: parsed.group.id } });
    const alias = path.join(ownerDataDir, 'alias-settings.json');
    if (process.platform !== 'win32') await fs.symlink(filePath, alias);
    const deduplicated = await readRegisteredApprovalRuleFiles({ ownerId: 'A', executionHostId: 'host',
      sources: [source, { ...source, filePath: process.platform === 'win32' ? filePath : alias }] });
    expect(deduplicated.qualifiedSourceIds).toEqual([parsed.group.id]);
    expect(deduplicated.inputs).toHaveLength(1);
    expect(await fs.readFile(filePath, 'utf8')).toBe(raw);
    const disabled = await readRegisteredApprovalRuleFiles({ ownerId: 'A', executionHostId: 'host',
      sources: [{ ...source, registration: { ...registration, layerState: 'disabled' } }] });
    expect(disabled.qualifiedSourceIds).toEqual([]);
    expect(disabled.inputs[0]).toMatchObject({ kind: 'unavailable', reason: 'layer-disabled' });
    const missing = await readRegisteredApprovalRuleFiles({ ownerId: 'A', executionHostId: 'host',
      sources: [{ ...source, registration: undefined as unknown as NativeSourceRegistration }] });
    expect(missing.inputs[0]).toMatchObject({ kind: 'unavailable', reason: 'registration-missing' });
    const projectRegistration: NativeSourceRegistration = { ...registration, layer: 'project',
      projectId: '/project/A', projectState: 'qualified' };
    const project = readClaudePersonalRules(JSON.parse(raw), projectRegistration);
    expect(project.kind).toBe('available');
    if (project.kind !== 'available') return;
    for (const filePathValue of [undefined, null, 42, {}]) {
      const besideBadPath = await readRegisteredApprovalRuleFiles({ ownerId: 'A', executionHostId: 'host',
        sources: [{ ...source, filePath: filePathValue as string },
          { filePath, registration: projectRegistration, previousGroupId: project.group.id }] });
      expect(besideBadPath.inputs).toMatchObject([
        { kind: 'unavailable', reason: 'locator-unverified', sourceId: parsed.group.id },
        { kind: 'available', group: { id: project.group.id } },
      ]);
      expect(besideBadPath.qualifiedSourceIds).toEqual([project.group.id]);
    }
    expect(await fs.readFile(filePath, 'utf8')).toBe(raw);
  });
});

// Unit: real Host capture -> same-Query content -> isolated owner store.
// Missing coverage: native content must not become durable execution authority.
async function liveImportFixture() {
  const h = await setup();
  const workDir = path.join(path.dirname(h.ownerDataDir), 'work');
  await fs.mkdir(workDir, { recursive: true });
  let valid = true;
  const owner = { ownerId: 'A', executionHostId: 'host', generation: 'A:1',
    dbClient: {}, ownerDataDir: h.ownerDataDir };
  const session = { id: 's', instanceId: 'i', agentKind: 'claude-code', workDir,
    remoteHostId: null as string | null, agentDeviceId: null, getStatus: () => 'active' };
  const row = { status: 'active', source: 'desktop', agentKind: 'cc', workingDir: workDir,
    title: 'test', userSendAt: 1, workspaceKind: 'project', providerId: null,
    remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null,
    clearedAt: null as number | null };
  const events: string[] = [];
  let reads = 0;
  let onRow: ((count: number) => void | Promise<void>) | undefined;
  const importer = createClaudeLiveUserRulesImporter({
    captureOwner: () => { events.push('capture'); return owner; },
    ownerCurrent: () => valid, listSessions: () => [session],
    readSessionRow: async () => { await onRow?.(++reads); return { ...row }; },
  });
  const request = { sessionId: 's', sessionInstanceId: 'i', workingDir: workDir,
    spawnProfile: { platform: process.platform, configRoot: path.join(workDir, '.claude'), basis: 'default-home' as const },
    signal: new AbortController().signal, isCurrent: () => valid,
    read: async () => {
      events.push('read');
      return readClaudeLiveUserRules({ state: { originalCwd: workDir, managedOnly: false,
        rules: [['deny', 'Bash(git push)'], ['allow', 'Bash(git status)'], ['ask', 'Read(**)']]
          .map(([behavior, rule]) => ({ source: 'userSettings', behavior, rule, editability: 'persistent' })),
      } }, true);
    },
  };
  return { ...h, workDir, request, importer, events, row, session,
    invalidate: () => { valid = false; },
    onRow: (hook: (count: number) => void | Promise<void>) => { onRow = hook; } };
}

function threeSourceRequest(request: Parameters<NonNullable<AgentDeps['onClaudeLiveUserRules']>>[0]) {
  return Object.assign(request, { readSources: async () => {
    const contents = readClaudeLiveSourceContents({ state: {
    originalCwd: request.workingDir, managedOnly: false, errors: [],
    rules: ['userSettings', 'projectSettings', 'localSettings'].flatMap(source =>
      ['allow', 'ask', 'deny'].map(behavior => ({ source, behavior, rule: 'Bash(git push)', editability: 'persistent' }))),
    } }, { userSettings: true, projectSettings: true, localSettings: true });
    const user = await request.read();
    contents.userSettings = user.kind === 'available' ? { ...user, originalCwd: request.workingDir } : user;
    return contents;
  } });
}

describe('live Claude user content import', () => {
  // Unit: real Host lease -> isolated real store; user-only tests missed
  // project/local drafts and their cwd scope. No execution qualification follows.
  it('imports three same-Query source contents into independent draft groups', async () => {
    const h = await liveImportFixture();
    const read = h.request.read;
    const request = Object.assign(h.request, { readSources: async () => {
      const user = await read();
      if (user.kind !== 'available') throw new Error('fixture user unavailable');
      return { userSettings: user,
        projectSettings: { ...user, source: 'projectSettings' as const },
        localSettings: { ...user, source: 'localSettings' as const } };
    } });
    expect(await h.importer(request)).toMatchObject({ kind: 'saved', revision: 1 });
    expect(h.events).toEqual(['capture', 'read']);
    const snapshot = await h.store.readSnapshot(scope(await fs.realpath(h.workDir)));
    expect(snapshot.groups.map(group => [group.origin.layer, group.scope.projectId]).sort()).toEqual(
      [['local', await fs.realpath(h.workDir)], ['project', await fs.realpath(h.workDir)], ['user', undefined]]);
    expect(new Set(snapshot.groups.map(group => group.id)).size).toBe(3);
    expect(await h.importer(request)).toMatchObject({ kind: 'saved', revision: 1 });
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-runtime'))).rejects.toThrow();
  });

  it('keeps user identity across cwd changes while project/local content remains cwd scoped', async () => {
    const h = await liveImportFixture();
    await h.importer(h.request);
    const user = h.store.readSourceImportSnapshot().groups[0]!;
    const request = threeSourceRequest(h.request);
    expect(await h.importer(request)).toMatchObject({ kind: 'saved', revision: 2 });
    const first = h.store.readSourceImportSnapshot();
    expect(first.groups.find(group => group.origin.layer === 'user')).toEqual(user);
    const cwd = await fs.realpath(h.workDir);
    const alias = path.join(path.dirname(h.workDir), 'cwd-alias');
    if (process.platform !== 'win32') {
      await fs.symlink(h.workDir, alias);
      h.session.workDir = alias; h.row.workingDir = alias; request.workingDir = alias;
      expect(await h.importer(request)).toMatchObject({ kind: 'saved', revision: 2 });
    }
    const other = path.join(path.dirname(h.workDir), 'other'); await fs.mkdir(other);
    h.session.workDir = other; h.row.workingDir = other; request.workingDir = other;
    expect(await h.importer(request)).toMatchObject({ kind: 'saved', revision: 3 });
    const after = h.store.readSourceImportSnapshot();
    expect(after.groups).toHaveLength(5);
    expect(first.groups.every(group => after.groups.some(item => item.id === group.id))).toBe(true);
    expect((await h.store.readSnapshot(scope(cwd))).groups.map(group => group.id).sort())
      .toEqual(first.groups.map(group => group.id).sort());
    request.spawnProfile!.configRoot = path.join(other, 'different-profile');
    expect(await h.importer(request)).toMatchObject({ kind: 'saved', revision: 4 });
    expect(h.store.readSourceImportSnapshot().groups).toHaveLength(8);
  });

  it('refreshes available layers while retaining excluded content and all published managed bytes', async () => {
    const h = await liveImportFixture(); const request = threeSourceRequest(h.request);
    const cc = managed('cc'); const pi = normalizeRuleGroup(managed('pi').origin, { ...cc.scope, harnesses: ['pi'] }, cc.clauses);
    await h.store.applyManagedEdit(0, cc.scope, [cc]); await h.store.applyManagedEdit(1, pi.scope, [pi]);
    await h.store.publish(2); await h.importer(request);
    const before = h.store.readSourceImportSnapshot();
    const files = ['command-approval-runtime/publish-state.json', 'command-approval-runtime/revisions/2/snapshot.json'];
    const bytes = await Promise.all(files.map(file => fs.readFile(path.join(h.ownerDataDir, file))));
    const read = request.readSources;
    request.readSources = async () => {
      const contents = await read();
      const local = contents.localSettings;
      if (local.kind === 'available') local.clauses[0]!.original = 'Bash(updated)';
      return { ...contents, projectSettings: { kind: 'unavailable', reason: 'source-excluded' } };
    };
    expect(await h.importer(request)).toMatchObject({ kind: 'saved', revision: 4 });
    const after = h.store.readSourceImportSnapshot();
    for (const layer of ['user', 'project'])
      expect(after.groups.find(group => group.origin.layer === layer && group.origin.harness === 'claude-code'))
        .toEqual(before.groups.find(group => group.origin.layer === layer && group.origin.harness === 'claude-code'));
    expect(await Promise.all(files.map(file => fs.readFile(path.join(h.ownerDataDir, file))))).toEqual(bytes);
    for (const harness of ['claude-code', 'pi'] as const) {
      const reader = createApprovalRuleStore({ ownerId: 'A', ownerDataDir: h.ownerDataDir, assertCurrent: h.assertCurrent,
        resolveManagedConsumer: () => ({ scope: { ...scope(h.workDir), harnesses: [harness] }, sessionId: 's', sessionInstanceId: 'i' }) });
      const result = await reader.readPublishedManagedSnapshot();
      expect(result.kind === 'published-managed' && result.groups.map(group => group.id)).toEqual([harness === 'pi' ? pi.id : cc.id]);
    }
  });

  it.each(['project', 'local'] as const)('rejects fake qualification for %s content and its managed baseline', async layer => {
    const h = await liveImportFixture(); const request = threeSourceRequest(h.request);
    const read = request.readSources;
    request.readSources = async () => {
      const contents = await read();
      return { userSettings: { kind: 'unavailable', reason: 'source-excluded' },
        projectSettings: layer === 'project' ? contents.projectSettings : { kind: 'unavailable', reason: 'source-excluded' },
        localSettings: layer === 'local' ? contents.localSettings : { kind: 'unavailable', reason: 'source-excluded' } };
    };
    await h.importer(request);
    expect(h.store.readSourceImportSnapshot().groups).toHaveLength(1);
    const group = h.store.readSourceImportSnapshot().groups.find(group => group.origin.layer === layer)!;
    const target = scope(await fs.realpath(h.workDir));
    await h.store.publish(1);
    expect(await h.store.readPublishedSnapshot(target, { qualifiedSourceIds: [group.id] }))
      .toMatchObject({ kind: 'unavailable', reason: 'live-source-content-only' });
    await h.store.applyManagedEdit(1, group.scope, [], [group.id]); await h.store.publish(2);
    expect(await h.store.readPublishedSnapshot(target, { qualifiedSourceIds: [group.id] }))
      .toMatchObject({ kind: 'unavailable', reason: 'live-source-content-only' });
  });

  it.each(['project', 'local'] as const)('preserves ambiguous old %s content bytes instead of adopting its identity', async layer => {
    const h = await liveImportFixture(); const cwd = await fs.realpath(h.workDir);
    const old = normalizeRuleGroup({ ...native('deny').origin, layer }, { ...scope(cwd) }, native('deny').clauses);
    await h.store.applySourceRefresh(0, [available(old)]);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const bytes = await fs.readFile(file);
    expect(await h.importer(threeSourceRequest(h.request))).toMatchObject({ kind: 'unavailable',
      reason: 'source-identity-conflict', detail: 'file-or-unknown-source' });
    expect(await fs.readFile(file)).toEqual(bytes);
    await h.store.applyManagedEdit(1, old.scope, [], [old.id]);
    const baselineBytes = await fs.readFile(file);
    expect(await h.importer(threeSourceRequest(h.request))).toMatchObject({ kind: 'unavailable', reason: 'source-identity-conflict' });
    expect(await fs.readFile(file)).toEqual(baselineBytes);
  });

  it.each(['owner', 'row', 'directory'] as const)('rejects %s invalidation at the three-layer locked write fence', async change => {
    const h = await liveImportFixture(); const request = threeSourceRequest(h.request);
    let changed = false;
    h.onRow(async () => {
      if (changed) return;
      try { await fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json.lock')); }
      catch { return; }
      changed = true;
      if (change === 'owner') h.invalidate();
      if (change === 'row') h.row.clearedAt = 2;
      if (change === 'directory') { await fs.rename(h.workDir, h.workDir + '-old'); await fs.mkdir(h.workDir); }
    });
    expect(await h.importer(request)).toMatchObject({ kind: 'unavailable' });
    expect(changed).toBe(true);
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-runtime'))).rejects.toThrow();
  });

  it('retains independent managed state when native observation fails, and reads later edits through the same lease', async () => {
    const h = await liveImportFixture();
    const rule = managed('active-cindy');
    let observing = true;
    const result = await h.importer({ ...h.request, isCurrent: () => observing,
      execution: { turnGeneration: 1, isCurrent: () => true }, read: async () => { throw new Error('native source unavailable'); } });
    expect(result.kind).toBe('unavailable');
    if (!('observation' in result) || !result.observation) throw new Error('Missing independent managed observation');
    observing = false;
    // A genuinely unpublished owner has no restrictions, unlike a failed read.
    expect(await result.observation.readManaged!()).toMatchObject({ groups: [] });
    await h.store.applyManagedEdit(0, rule.scope, [rule], [], undefined, true);
    const current = await result.observation.readManaged!();
    if (!current || 'kind' in current) throw new Error('Managed fixture unavailable');
    expect(current.groups.map(group => group.id)).toEqual([rule.id]);
    await h.store.applyManagedEdit(1, rule.scope, [{ ...rule, clauses: [{ ...rule.clauses[0]!, decision: 'ask' }] }], [], undefined, true);
    const updated = await result.observation.readManaged!();
    if (!updated || 'kind' in updated) throw new Error('Updated managed fixture unavailable');
    expect(updated.groups[0]?.clauses[0]?.decision).toBe('ask');
    await h.store.applyManagedEdit(2, rule.scope, [], [rule.id], undefined, true);
    expect(await result.observation.readManaged!()).toMatchObject({ groups: [] });
    h.invalidate();
    await expect(result.observation.readManaged!()).rejects.toThrow('Managed execution changed');
  });

  // Unit: the real Host capture/store returns a separate turn lease. Expiring
  // a read deadline must not revoke that accepted execution; owner/row/cwd must.
  it.each(['observation-ended', 'owner', 'row', 'directory', 'execution'] as const)(
    'separates bounded observation from the %s execution boundary', async boundary => {
      const h = await liveImportFixture(); let observing = true, executing = true;
      const signal = new AbortController();
      const result = await h.importer({ ...h.request, signal: signal.signal, isCurrent: () => observing,
        execution: { turnGeneration: 1, isCurrent: () => executing } });
      expect(result.kind).toBe('saved');
      if (!('observation' in result) || !result.observation) throw new Error('missing execution observation');
      observing = false; signal.abort();
      if (boundary === 'owner') h.invalidate();
      if (boundary === 'row') h.row.clearedAt = 1;
      if (boundary === 'execution') executing = false;
      if (boundary === 'directory') { await fs.rename(h.workDir, h.workDir + '-old'); await fs.mkdir(h.workDir); }
      expect(await result.observation.revalidate()).toBe(boundary === 'observation-ended');
      expect(result.observation.groups[0]?.clauses.map(clause => clause.original)).toEqual([
        'Bash(git push)', 'Bash(git status)', 'Read(**)',
      ]);
      expect(h.events).toEqual(['capture', 'read']);
    });

  it('captures before reading and saves content without publication or execution qualification', async () => {
    const h = await liveImportFixture();
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 1 });
    expect(h.events).toEqual(['capture', 'read']);
    const snapshot = await h.store.readSnapshot(scope(h.workDir));
    expect(snapshot.groups).toHaveLength(1);
    const group = snapshot.groups[0]!;
    expect(group.origin.locator.startsWith('claude-code-live://userSettings/')).toBe(true);
    expect(group.clauses.map(clause => [clause.original, clause.decision])).toEqual([
      ['Bash(git push)', 'deny'], ['Bash(git status)', 'allow'], ['Read(**)', 'ask']]);
    expect(group.clauses[2]?.matcher).toBeUndefined();
    expect(h.store.getAppliedState()).toEqual({});
    await h.store.publish(1);
    expect(await h.store.readPublishedSnapshot(scope(h.workDir), { qualifiedSourceIds: [group.id] }))
      .toMatchObject({ kind: 'unavailable', reason: 'live-source-content-only' });
  });

  it.each(['owner', 'cwd', 'clear', 'instance'] as const)('drops %s changes during the live read', async change => {
    const h = await liveImportFixture();
    const read = h.request.read;
    h.request.read = async () => {
      const result = await read();
      if (change === 'owner') h.invalidate();
      if (change === 'cwd' && result.kind === 'available') result.originalCwd = h.ownerDataDir;
      if (change === 'clear') h.row.clearedAt = 2;
      if (change === 'instance') h.session.instanceId = 'replaced';
      return result;
    };
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
  });

  it('keeps distinct launch profiles and shares the same profile content across projects', async () => {
    const h = await liveImportFixture();
    await h.importer(h.request);
    const first = await h.store.readSnapshot(scope(h.workDir));
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 1 });
    const other = path.join(path.dirname(h.workDir), 'other-project');
    await fs.mkdir(other);
    h.session.workDir = other; h.row.workingDir = other; h.request.workingDir = other;
    const read = h.request.read;
    h.request.read = async () => {
      const result = await read();
      if (result.kind === 'available') result.originalCwd = other;
      return result;
    };
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 1 });
    h.request.spawnProfile.configRoot = path.join(other, 'different-profile');
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 2 });
    const after = await h.store.readSnapshot(scope(other));
    expect(after.groups).toHaveLength(2);
    expect(after.groups.some(group => group.id === first.groups[0]!.id)).toBe(true);
  });

  it.each(['file', 'backup', 'baseline'] as const)('preserves ambiguous %s bytes without recovery or publication', async kind => {
    const h = await liveImportFixture();
    await h.store.applySourceRefresh(0, [available(native('deny'))]);
    if (kind === 'baseline') {
      const source = native('deny');
      await h.store.applyManagedEdit(1, source.scope, [], [source.id]);
    }
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json');
    const bytes = await fs.readFile(file);
    if (kind === 'backup') await fs.rename(file, file + '.bak');
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable',
      reason: 'source-identity-conflict', detail: kind === 'backup' ? 'pending-atomic-recovery' : 'file-or-unknown-source' });
    expect(await fs.readFile(file + (kind === 'backup' ? '.bak' : ''))).toEqual(bytes);
    if (kind === 'backup') await expect(fs.stat(file)).rejects.toThrow();
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-runtime'))).rejects.toThrow();
  });

  it.each(['source-excluded', 'source-empty', 'managed-only', 'settings-errors'] as const)(
    'retains last content on %s, never treating it as retirement', async reason => {
      const h = await liveImportFixture(); await h.importer(h.request);
      const file = path.join(h.ownerDataDir, 'command-approval-rules.json');
      const bytes = await fs.readFile(file);
      h.request.read = async () => ({ kind: 'unavailable', reason });
      expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable', reason });
      expect(await fs.readFile(file)).toEqual(bytes);
    });

  it.each(['before-read', 'inside-lock'] as const)('blocks stale %s without business writes', async stage => {
    const h = await liveImportFixture();
    h.onRow(count => { if (count === (stage === 'before-read' ? 1 : 6)) h.invalidate(); });
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
    if (stage === 'before-read') expect(h.events).toEqual(['capture']);
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-runtime'))).rejects.toThrow();
  });

  it('preserves managed edits and both CC/Pi published deny projections beside live content', async () => {
    const h = await liveImportFixture();
    const cc = managed('cc');
    const pi = normalizeRuleGroup(managed('pi').origin, { ...cc.scope, harnesses: ['pi'] }, cc.clauses);
    await h.store.applyManagedEdit(0, cc.scope, [cc]);
    await h.store.applyManagedEdit(1, pi.scope, [pi]);
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 3 });
    const snapshot = await h.store.readSnapshot(scope(h.workDir));
    const live = snapshot.groups.find(group => group.origin.harness === 'claude-code')!;
    await h.store.applyManagedEdit(3, live.scope, [{ ...live, clauses: [] }]);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json');
    const bytes = await fs.readFile(file);
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable', reason: 'source-conflict' });
    expect(await fs.readFile(file)).toEqual(bytes);
    await h.store.publish(4);
    for (const harness of ['claude-code', 'pi'] as const) {
      const reader = createApprovalRuleStore({ ownerId: 'A', ownerDataDir: h.ownerDataDir,
        assertCurrent: h.assertCurrent, resolveManagedConsumer: () => ({
          scope: { ...scope(h.workDir), harnesses: [harness] }, sessionId: 's', sessionInstanceId: 'i' }) });
      const result = await reader.readPublishedManagedSnapshot();
      expect(result.kind).toBe('published-managed');
      expect(result.kind === 'published-managed' && result.groups.map(group => group.id)).toEqual([harness === 'pi' ? pi.id : cc.id]);
    }
    await h.store.applyManagedEdit(4, live.scope, [], [live.id]);
    await h.store.publish(5);
    expect(await h.store.readPublishedSnapshot(scope(h.workDir), { qualifiedSourceIds: [live.id] }))
      .toMatchObject({ kind: 'unavailable', reason: 'live-source-content-only' });
  });

  it.each(['profile', 'remote', 'review', 'aborted'] as const)('does not read or create owner data for %s evidence', async failure => {
    const h = await liveImportFixture();
    if (failure === 'profile') h.request.spawnProfile.configRoot = 'relative';
    if (failure === 'remote') h.session.remoteHostId = 'remote';
    if (failure === 'review') h.row.source = 'review';
    if (failure === 'aborted') {
      const cancellation = new AbortController(); cancellation.abort(); h.request.signal = cancellation.signal;
    }
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
    expect(h.events).toEqual(['capture']);
    await expect(fs.stat(h.ownerDataDir)).rejects.toThrow();
  });

  it('cancels a real owner-lock wait without late content writes or retries', async () => {
    const h = await liveImportFixture();
    await fs.mkdir(h.ownerDataDir);
    let unlock!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const locking = withCrossProcessLock(path.join(h.ownerDataDir, 'command-approval-rules.json.lock'),
      { label: 'live import cancellation test' }, async status => {
        expect(status.held).toBe(true); acquired(); await released;
      });
    await held;
    const cancellation = new AbortController();
    h.request.signal = cancellation.signal;
    const importing = h.importer(h.request);
    try {
      await vi.waitFor(() => expect(h.events).toContain('read'));
      cancellation.abort();
      expect(await importing).toMatchObject({ kind: 'unavailable' });
      await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
    } finally { cancellation.abort(); unlock(); await locking; await importing; }
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
  });
});

// Unit: actual Main lease -> lazy config metadata -> temporary ordinary rules
// files -> real owner store. Content must preserve all decisions while never
// borrowing a native execution qualification or publishing a new artifact.
async function codexContentFixture() {
  const h = await setup();
  const root = path.dirname(path.dirname(h.ownerDataDir));
  const workDir = path.join(root, 'codex-work');
  const profile = path.join(root, 'codex-profile');
  const configFile = path.join(profile, 'config.toml');
  const rulesDir = path.join(profile, 'rules');
  await fs.mkdir(workDir); await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(configFile, '');
  const text = ['prefix_rule(pattern=["git", "status"], decision="allow")',
    'prefix_rule(pattern=["git", "fetch"], decision="prompt")',
    'prefix_rule(pattern=["git", "push"], decision="forbidden")',
    'blocked = ["rm"]', 'prefix_rule(pattern=blocked, decision="forbidden")'].join('\n');
  const ruleFile = path.join(rulesDir, 'main.rules'); await fs.writeFile(ruleFile, text);
  let valid = true;
  const owner = { ownerId: 'A', executionHostId: 'host', generation: 'A:1', dbClient: {}, ownerDataDir: h.ownerDataDir };
  let currentDbClient = owner.dbClient;
  let inputCurrent = true;
  const cancellation = new AbortController();
  const session = { id: 'cx', instanceId: 'cx-instance', agentKind: 'codex', workDir,
    remoteHostId: null as string | null, agentDeviceId: null, getStatus: () => 'active' };
  const row = { status: 'active', source: 'desktop', agentKind: 'codex', workingDir: workDir,
    title: 'test', userSendAt: 1, workspaceKind: 'project', providerId: null,
    remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null as number | null };
  const events: string[] = [];
  let reads = 0;
  let onRow: ((count: number) => void | Promise<void>) | undefined;
  const importer = createCodexUserRuleContentImporter({
    captureOwner: () => { events.push('capture'); return owner; },
    ownerCurrent: captured => valid && captured.dbClient === currentDbClient, listSessions: () => [session],
    readSessionRow: async () => { await onRow?.(++reads); return { ...row }; },
  });
  const request: Parameters<NonNullable<AgentDeps['onCodexUserRuleContent']>>[0] = { sessionId: session.id, sessionInstanceId: session.instanceId, workingDir: workDir,
    threadId: 'native-thread', hostGeneration: 1,
    serverProfile: { codexHome: profile, userAgent: 'codex/0.159.2' },
    signal: cancellation.signal, isCurrent: () => inputCurrent,
    read: async () => { events.push('read'); return { kind: 'available' as const, requestedCwd: workDir,
      nativeEffect: 'not-attested' as const, sources: [{ file: configFile, profile: null, version: 'v1' }] }; },
  };
  return { ...h, root, workDir, profile, configFile, rulesDir, ruleFile, text, request, session, row, events, importer,
    cancellation, invalidateInput: () => { inputCurrent = false; }, replaceDbClient: () => { currentDbClient = {}; },
    invalidate: () => { valid = false; }, onRow: (hook: (count: number) => void | Promise<void>) => { onRow = hook; } };
}

// Unit: same Main capture -> lazy metadata -> ordinary project rules -> real
// store. User-only fixtures missed project scope and independent draft content.
async function codexProjectFixture() {
  const h = await codexContentFixture();
  const folder = path.join(h.workDir, '.codex');
  const directory = path.join(folder, 'rules'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'project.rules'); await fs.writeFile(file, h.text);
  const readProject: NonNullable<typeof h.request.readProject> = async () => {
    h.events.push('read-project');
    return { kind: 'available' as const, requestedCwd: h.request.workingDir, nativeEffect: 'not-attested' as const,
      sources: [{ dotCodexFolder: folder, version: 'project-v1' }], unavailableSources: [] as Array<{ dotCodexFolder: string; reason: string }> };
  };
  const request = Object.assign(h.request, { readProject });
  return { ...h, request, folder, projectDirectory: directory, projectFile: file };
}

describe('Codex user source content import', () => {
  it('imports project rules beside unchanged user content through the real Host store', async () => {
    const h = await codexProjectFixture();
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 1 });
    const groups = h.store.readSourceImportSnapshot().groups;
    expect(groups.map(group => group.origin.layer).sort()).toEqual(['project', 'user']);
    expect(h.events).toEqual(['capture', 'read', 'read-project']);
    const project = groups.find(group => group.origin.layer === 'project')!;
    expect(project.origin).toMatchObject({ harness: 'codex', decisionDomain: 'unknown' });
    expect(project.origin.sourceId.startsWith('codex-project-content:')).toBe(true);
    expect(project.scope.projectId).toBe(await fs.realpath(h.workDir));
    expect(project.clauses.map(clause => clause.original)).toEqual(h.text.split('\n'));
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 1 });
    expect(await fs.readFile(h.projectFile, 'utf8')).toBe(h.text);
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-runtime'))).rejects.toThrow();
  });

  it('imports project content when user is unavailable and preserves separate same-inode layers', async () => {
    const h = await codexProjectFixture();
    await fs.unlink(h.projectFile); await fs.link(h.ruleFile, h.projectFile);
    expect(await h.importer({ ...h.request, readProject: undefined })).toMatchObject({ revision: 1 });
    const user = h.store.readSourceImportSnapshot().groups[0]!;
    expect(await h.importer(h.request)).toMatchObject({ revision: 2 });
    let groups = h.store.readSourceImportSnapshot().groups;
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.origin.layer === 'user')).toEqual(user);
    const project = groups.find(group => group.origin.layer === 'project')!;
    expect(project.clauses).toEqual(user.clauses);
    h.request.read = async () => ({ kind: 'unavailable', reason: 'source-disabled' });
    expect(await h.importer(h.request)).toMatchObject({ revision: 2 });
    groups = h.store.readSourceImportSnapshot().groups;
    expect(groups.find(group => group.id === project.id)).toEqual(project);
  });

  it('keeps logical project sources across cwd aliases and separate parent/child cwd views and folders', async () => {
    const h = await codexProjectFixture();
    h.request.read = async () => ({ kind: 'unavailable', reason: 'source-excluded' });
    const parentFolder = path.join(h.root, 'parent', '.codex');
    await fs.mkdir(path.join(parentFolder, 'rules'), { recursive: true });
    await fs.writeFile(path.join(parentFolder, 'rules', 'parent.rules'), h.text);
    const read = h.request.readProject;
    let metadataVersion = 0;
    h.request.readProject = async () => { const result = await read();
      if (result.kind === 'available') {
        result.sources[0]!.version = 'metadata-' + ++metadataVersion;
        result.sources.push({ dotCodexFolder: parentFolder, version: 'parent-v1' });
      }
      return result;
    };
    expect(await h.importer(h.request)).toMatchObject({ revision: 1 });
    const first = h.store.readSourceImportSnapshot();
    expect(first.groups).toHaveLength(2);
    expect(new Set(first.groups.map(group => group.origin.sourceId)).size).toBe(2);
    if (process.platform !== 'win32') {
      const alias = path.join(h.root, 'cwd-alias'); await fs.symlink(h.workDir, alias);
      h.request.workingDir = alias; h.session.workDir = alias; h.row.workingDir = alias;
      expect(await h.importer(h.request)).toMatchObject({ revision: 1 });
    }
    const child = path.join(h.workDir, 'child'); await fs.mkdir(child);
    h.request.workingDir = child; h.session.workDir = child; h.row.workingDir = child;
    expect(await h.importer(h.request)).toMatchObject({ revision: 2 });
    const after = h.store.readSourceImportSnapshot();
    expect(after.groups).toHaveLength(4);
    expect(new Set(after.groups.map(group => group.origin.sourceId)).size).toBe(2);
    expect(new Set(after.groups.map(group => group.scope.projectId)).size).toBe(2);
    expect(first.groups.every(group => after.groups.some(item => item.id === group.id))).toBe(true);
    expect(await h.importer(h.request)).toMatchObject({ revision: 2 });
  });

  it.each(['source-disabled', 'source-conflict', 'source-empty', 'missing'] as const)(
    'retains last project content on %s without retirement or publication', async reason => {
      const h = await codexProjectFixture();
      h.request.read = async () => ({ kind: 'unavailable', reason: 'source-excluded' });
      await h.importer(h.request);
      const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const before = await fs.readFile(file);
      if (reason === 'missing') await fs.unlink(h.projectFile);
      else h.request.readProject = async () => ({ kind: 'unavailable', reason });
      expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
      expect(await fs.readFile(file)).toEqual(before);
      await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-runtime'))).rejects.toThrow();
    });

  it('refreshes available user content without retiring an unavailable project folder', async () => {
    const h = await codexProjectFixture(); await h.importer(h.request);
    const project = h.store.readSourceImportSnapshot().groups.find(group => group.origin.layer === 'project')!;
    await fs.writeFile(h.ruleFile, 'prefix_rule(pattern=["changed"], decision="allow")');
    h.request.readProject = async () => ({ kind: 'unavailable', reason: 'source-disabled' });
    expect(await h.importer(h.request)).toMatchObject({ revision: 2 });
    expect(h.store.readSourceImportSnapshot().groups.find(group => group.id === project.id)).toEqual(project);
  });

  it('rejects fake execution qualification for only project content and only its baseline', async () => {
    const h = await codexProjectFixture(); h.request.read = async () => ({ kind: 'unavailable', reason: 'source-excluded' });
    await h.importer(h.request);
    const snapshot = h.store.readSourceImportSnapshot(); expect(snapshot.groups).toHaveLength(1);
    const project = snapshot.groups[0]!;
    const target = { ...scope(await fs.realpath(h.workDir)), harnesses: ['codex' as const] };
    await h.store.publish(1);
    expect(await h.store.readPublishedSnapshot(target, { qualifiedSourceIds: [project.id] }))
      .toMatchObject({ kind: 'unavailable', reason: 'live-source-content-only' });
    await h.store.applyManagedEdit(1, project.scope, [], [project.id]); await h.store.publish(2);
    expect(h.store.readSourceImportSnapshot().groups).toHaveLength(0);
    expect(await h.store.readPublishedSnapshot(target, { qualifiedSourceIds: [project.id] }))
      .toMatchObject({ kind: 'unavailable', reason: 'live-source-content-only' });
  });

  it.each(['file', 'baseline', 'backup'] as const)('preserves ambiguous old project %s bytes', async kind => {
    const h = await codexProjectFixture(); h.request.read = async () => ({ kind: 'unavailable', reason: 'source-excluded' });
    const old = normalizeRuleGroup({ ...native('deny').origin, harness: 'codex', layer: 'project' },
      { ...scope(await fs.realpath(h.workDir)), harnesses: ['codex'] }, native('deny').clauses);
    await h.store.applySourceRefresh(0, [available(old)]);
    if (kind === 'baseline') await h.store.applyManagedEdit(1, old.scope, [], [old.id]);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const before = await fs.readFile(file);
    if (kind === 'backup') await fs.rename(file, file + '.bak');
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable', reason: 'source-identity-conflict',
      detail: kind === 'backup' ? 'pending-atomic-recovery' : 'file-or-unknown-source' });
    expect(await fs.readFile(file + (kind === 'backup' ? '.bak' : ''))).toEqual(before);
    if (kind === 'backup') await expect(fs.stat(file)).rejects.toThrow();
  });

  it.each(['owner', 'stop', 'project-directory', 'project-file'] as const)(
    'rejects %s changes during the actual project locked write fence', async change => {
      const h = await codexProjectFixture(); let changed = false;
      h.onRow(async () => {
        if (changed) return;
        try { await fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json.lock')); } catch { return; }
        changed = true;
        if (change === 'owner') h.invalidate();
        if (change === 'stop') h.cancellation.abort();
        if (change === 'project-directory') { await fs.rename(h.projectDirectory, h.projectDirectory + '.old');
          await fs.mkdir(h.projectDirectory); await fs.writeFile(h.projectFile, h.text); }
        if (change === 'project-file') { await fs.rename(h.projectFile, h.projectFile + '.old'); await fs.writeFile(h.projectFile, h.text); }
      });
      expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
      expect(changed).toBe(true);
      await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
    });

  it('captures before reading actual files and stores complete content only in the draft', async () => {
    const h = await codexContentFixture();
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 1 });
    expect(h.events).toEqual(['capture', 'read']);
    const snapshot = h.store.readSourceImportSnapshot();
    expect(snapshot.groups).toHaveLength(1);
    const group = snapshot.groups[0]!;
    expect(group.origin).toMatchObject({ harness: 'codex', layer: 'user', decisionDomain: 'unknown' });
    expect(group.origin.sourceId.startsWith('codex-user-content:')).toBe(true);
    expect(group.origin.locator.startsWith('codex-user-content://')).toBe(true);
    expect(group.scope.projectId).toBeUndefined();
    expect(group.clauses.map(clause => clause.original)).toEqual(h.text.split('\n'));
    expect(group.clauses.slice(0, 3).map(clause => clause.decision)).toEqual(['allow', 'ask', 'deny']);
    expect(group.clauses.slice(3).every(clause => !clause.matcher && clause.reason)).toBe(true);
    expect(h.store.getAppliedState()).toEqual({});
    expect(await fs.readFile(h.ruleFile, 'utf8')).toBe(h.text);
  });

  it('shares logical content across projects, preserves independent files/profiles and ignores metadata-only version changes', async () => {
    const h = await codexContentFixture();
    await h.importer(h.request);
    const original = h.store.readSourceImportSnapshot().groups[0]!;
    expect(await h.importer(h.request)).toMatchObject({ revision: 1 });
    const other = path.join(h.root, 'second-project'); await fs.mkdir(other);
    h.request.workingDir = other; h.session.workDir = other; h.row.workingDir = other;
    const read = h.request.read;
    h.request.read = async () => {
      const metadata = await read();
      if (metadata.kind === 'available') { metadata.requestedCwd = other; metadata.sources[0]!.version = 'v2'; }
      return metadata;
    };
    expect(await h.importer(h.request)).toMatchObject({ revision: 1 });
    await fs.writeFile(path.join(h.rulesDir, 'second.rules'), 'prefix_rule(pattern=["ls"], decision="allow")');
    expect(await h.importer(h.request)).toMatchObject({ revision: 2 });
    const profile2 = path.join(h.root, 'second-profile'); await fs.mkdir(path.join(profile2, 'rules'), { recursive: true });
    await fs.writeFile(path.join(profile2, 'config.toml'), '');
    await fs.writeFile(path.join(profile2, 'rules', 'main.rules'), h.text);
    await fs.writeFile(path.join(profile2, 'rules', 'second.rules'), 'prefix_rule(pattern=["ls"], decision="allow")');
    h.request.serverProfile = { ...h.request.serverProfile, codexHome: profile2 };
    const previousRead = h.request.read;
    h.request.read = async () => {
      const metadata = await previousRead();
      if (metadata.kind === 'available') metadata.sources[0]!.file = path.join(profile2, 'config.toml');
      return metadata;
    };
    expect(await h.importer(h.request)).toMatchObject({ revision: 3 });
    const snapshot = h.store.readSourceImportSnapshot();
    expect(snapshot.groups).toHaveLength(4);
    expect(snapshot.groups.find(group => group.id === original.id)?.clauses).toEqual(original.clauses);
  });

  it('uses the pinned native file-extension boundary rather than treating a bare .rules dotfile as policy content', async () => {
    const h = await codexContentFixture();
    await fs.writeFile(path.join(h.rulesDir, '.rules'), 'prefix_rule(pattern=["not-native-policy"], decision="allow")');
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 1 });
    expect(h.store.readSourceImportSnapshot().groups).toHaveLength(1);
  });

  it('derives rules from the logical config parent even when config is a symlink', async () => {
    const h = await codexContentFixture();
    const target = path.join(h.root, 'elsewhere'); await fs.mkdir(path.join(target, 'rules'), { recursive: true });
    await fs.writeFile(path.join(target, 'config.toml'), '');
    await fs.writeFile(path.join(target, 'rules', 'unexpected.rules'), 'prefix_rule(pattern=["unexpected"], decision="allow")');
    await fs.unlink(h.configFile); await fs.symlink(path.join(target, 'config.toml'), h.configFile);
    expect(await h.importer(h.request)).toMatchObject({ revision: 1 });
    expect(h.store.readSourceImportSnapshot().groups.map(group => group.clauses.map(clause => clause.original)))
      .toEqual([h.text.split('\n')]);
    await fs.unlink(h.configFile); await fs.writeFile(h.configFile, 'replacement config');
    expect(await h.importer(h.request)).toMatchObject({ revision: 1 });
  });

  it('deduplicates same-file hardlink aliases in one profile without recognizing a different stored alias', async () => {
    const h = await codexContentFixture();
    await h.importer(h.request);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const before = await fs.readFile(file);
    await fs.link(h.ruleFile, path.join(h.rulesDir, 'aaa.rules'));
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable', reason: 'source-conflict' });
    expect(await fs.readFile(file)).toEqual(before);
    const fresh = await codexContentFixture();
    await fs.link(fresh.ruleFile, path.join(fresh.rulesDir, 'zzz.rules'));
    expect(await fresh.importer(fresh.request)).toMatchObject({ kind: 'saved', revision: 1 });
    expect(fresh.store.readSourceImportSnapshot().groups).toHaveLength(1);
  });

  it('preserves a managed deletion baseline when the same file gains another logical alias', async () => {
    const h = await codexContentFixture(); await h.importer(h.request);
    const group = h.store.readSourceImportSnapshot().groups[0]!;
    await h.store.applyManagedEdit(1, group.scope, [], [group.id]);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const before = await fs.readFile(file);
    await fs.link(h.ruleFile, path.join(h.rulesDir, 'aaa.rules'));
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable', reason: 'source-conflict' });
    expect(await fs.readFile(file)).toEqual(before);
  });

  it('keeps a valid file as content beside native-invalid syntax and retains last valid bytes beside bad UTF8', async () => {
    const h = await codexContentFixture(); await h.importer(h.request);
    const original = h.store.readSourceImportSnapshot().groups[0]!;
    await fs.writeFile(h.ruleFile, Buffer.from([0xff, 0xfe]));
    await fs.writeFile(path.join(h.rulesDir, 'new.rules'), 'definitely not a native call(');
    const result = await h.importer(h.request);
    expect(result).toMatchObject({ kind: 'saved', revision: 2 });
    expect('conflicts' in result && result.conflicts).toContain(original.id);
    const snapshot = h.store.readSourceImportSnapshot();
    expect(snapshot.groups.find(group => group.id === original.id)).toEqual(original);
    const fresh = snapshot.groups.find(group => group.id !== original.id)!;
    expect(fresh.clauses[0]).toMatchObject({ original: 'definitely not a native call(', reason: expect.any(String) });
    expect(fresh.clauses[0]?.matcher).toBeUndefined();
  });

  it.each(['missing', 'empty', 'oversize', 'utf8', 'symlink'] as const)('retains the old draft for %s rule files', async failure => {
    const h = await codexContentFixture(); await h.importer(h.request);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const before = await fs.readFile(file);
    if (failure === 'missing') await fs.unlink(h.ruleFile);
    if (failure === 'empty') await fs.writeFile(h.ruleFile, '');
    if (failure === 'oversize') await fs.writeFile(h.ruleFile, Buffer.alloc(1_000_001));
    if (failure === 'utf8') await fs.writeFile(h.ruleFile, Buffer.from([0xff]));
    if (failure === 'symlink') {
      await fs.rename(h.ruleFile, path.join(h.root, 'target.rules'));
      await fs.symlink(path.join(h.root, 'target.rules'), h.ruleFile);
    }
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
    expect(await fs.readFile(file)).toEqual(before);
  });

  it.each(['source-disabled', 'layers-unavailable', 'source-empty'] as const)('retains old content for unavailable metadata: %s', async reason => {
    const h = await codexContentFixture(); await h.importer(h.request);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const before = await fs.readFile(file);
    h.request.read = async () => ({ kind: 'unavailable', reason });
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable', reason });
    expect(await fs.readFile(file)).toEqual(before);
  });

  it.each(['owner', 'db', 'instance', 'clear', 'stop', 'input', 'cwd', 'work-directory', 'file', 'directory'] as const)(
    'rejects %s invalidation at the locked final check', async change => {
      const h = await codexContentFixture();
      h.onRow(async count => {
        if (count !== 6) return;
        if (change === 'owner') h.invalidate();
        if (change === 'db') h.replaceDbClient();
        if (change === 'input') h.invalidateInput();
        if (change === 'instance') h.session.instanceId = 'new-instance';
        if (change === 'clear') h.row.clearedAt = 2;
        if (change === 'stop') h.cancellation.abort();
        if (change === 'cwd') h.row.workingDir = h.root;
        if (change === 'work-directory') { await fs.rename(h.workDir, h.workDir + '.old'); await fs.mkdir(h.workDir); }
        if (change === 'file') { await fs.rename(h.ruleFile, h.ruleFile + '.old'); await fs.writeFile(h.ruleFile, h.text); }
        if (change === 'directory') { await fs.rename(h.rulesDir, h.rulesDir + '.old'); await fs.mkdir(h.rulesDir); await fs.writeFile(h.ruleFile, h.text); }
      });
      expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
      await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
      await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-runtime'))).rejects.toThrow();
    });

  it.each(['profile', 'remote', 'review', 'wrong-kind', 'cwd'] as const)('does not read content for unqualified %s context', async failure => {
    const h = await codexContentFixture();
    if (failure === 'profile') h.request.serverProfile.codexHome = 'relative';
    if (failure === 'remote') h.session.remoteHostId = 'remote-host';
    if (failure === 'review') h.row.source = 'review';
    if (failure === 'wrong-kind') h.row.agentKind = 'cc';
    if (failure === 'cwd') h.row.workingDir = h.root;
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
    expect(h.events).toEqual(['capture']);
    await expect(fs.stat(h.ownerDataDir)).rejects.toThrow();
  });

  it('drops an owner change during lazy metadata before opening any rule file or creating the owner root', async () => {
    const h = await codexContentFixture();
    const read = h.request.read; h.request.read = async () => { const value = await read(); h.invalidate(); return value; };
    const opening = vi.spyOn(fs, 'open');
    try {
      expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' });
      expect(opening).not.toHaveBeenCalled();
      await expect(fs.stat(h.ownerDataDir)).rejects.toThrow();
    } finally { opening.mockRestore(); }
  });

  it.each(['file', 'baseline', 'backup'] as const)('preserves old ambiguous %s sources without recovery', async kind => {
    const h = await codexContentFixture();
    const old = normalizeRuleGroup({ ...native('deny').origin, harness: 'codex' },
      { ownerId: 'A', executionHostId: 'host', harnesses: ['codex'] }, native('deny').clauses);
    await h.store.applySourceRefresh(0, [available(old)]);
    if (kind === 'baseline') await h.store.applyManagedEdit(1, old.scope, [], [old.id]);
    const file = path.join(h.ownerDataDir, 'command-approval-rules.json'); const before = await fs.readFile(file);
    if (kind === 'backup') await fs.rename(file, file + '.bak');
    expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable', reason: 'source-identity-conflict',
      detail: kind === 'backup' ? 'pending-atomic-recovery' : 'file-or-unknown-source' });
    expect(await fs.readFile(file + (kind === 'backup' ? '.bak' : ''))).toEqual(before);
    if (kind === 'backup') await expect(fs.stat(file)).rejects.toThrow();
  });

  it('rejects CAS changes instead of retrying or overwriting a managed edit', async () => {
    const h = await codexContentFixture(); const seed = managed('seed');
    await h.store.applyManagedEdit(0, seed.scope, [seed]);
    const open = fs.open; let edited = false;
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (!edited && args[0] === h.ruleFile) { edited = true; await h.store.applyManagedEdit(1, seed.scope, [managed('parallel')]); }
      return open(...args);
    });
    try { expect(await h.importer(h.request)).toMatchObject({ kind: 'unavailable' }); }
    finally { opening.mockRestore(); }
    const snapshot = h.store.readSourceImportSnapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.groups.map(group => group.origin.sourceId)).toEqual(['seed', 'parallel']);
  });

  it.each(['group', 'baseline', 'replacement'] as const)('rejects fake native qualifications including %s references', async reference => {
    const h = await codexContentFixture(); await h.importer(h.request);
    const group = h.store.readSourceImportSnapshot().groups[0]!;
    const target = { ...scope(h.workDir), harnesses: ['codex' as const] };
    let revision = 1;
    if (reference === 'baseline') { await h.store.applyManagedEdit(1, group.scope, [], [group.id]); revision++; }
    if (reference === 'replacement') {
      await h.store.applyProjectReplacement(1, target, group.id, normalizeRuleGroup(group.origin, target, [])); revision++;
    }
    await h.store.publish(revision);
    expect(await h.store.readPublishedSnapshot(target, { qualifiedSourceIds: [group.id] }))
      .toMatchObject({ kind: 'unavailable', reason: 'live-source-content-only' });
  });

  it('leaves published CC/Pi managed bytes and projections unchanged while importing the draft', async () => {
    const h = await codexProjectFixture(); const cc = managed('cc');
    const pi = normalizeRuleGroup(managed('pi').origin, { ...cc.scope, harnesses: ['pi'] }, cc.clauses);
    await h.store.applyManagedEdit(0, cc.scope, [cc]); await h.store.applyManagedEdit(1, pi.scope, [pi]); await h.store.publish(2);
    const files = ['command-approval-runtime/publish-state.json', 'command-approval-runtime/revisions/2/snapshot.json'];
    const before = await Promise.all(files.map(file => fs.readFile(path.join(h.ownerDataDir, file))));
    expect(await h.importer(h.request)).toMatchObject({ kind: 'saved', revision: 3 });
    expect(await Promise.all(files.map(file => fs.readFile(path.join(h.ownerDataDir, file))))).toEqual(before);
    await h.store.publish(3);
    for (const harness of ['claude-code', 'pi'] as const) {
      const store = createApprovalRuleStore({ ownerId: 'A', ownerDataDir: h.ownerDataDir, assertCurrent: h.assertCurrent,
        resolveManagedConsumer: () => ({ scope: { ...scope(h.workDir), harnesses: [harness] }, sessionId: 's', sessionInstanceId: 'i' }) });
      const result = await store.readPublishedManagedSnapshot();
      expect(result.kind).toBe('published-managed');
      expect(result.kind === 'published-managed' && result.groups.map(group => group.id)).toEqual([harness === 'pi' ? pi.id : cc.id]);
    }
  });

  it('cancels an actual cross-process owner lock wait with no late business write', async () => {
    const h = await codexProjectFixture(); await fs.mkdir(h.ownerDataDir, { recursive: true });
    let unlock!: () => void; let acquired!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const locking = withCrossProcessLock(path.join(h.ownerDataDir, 'command-approval-rules.json.lock'),
      { label: 'codex import cancellation test' }, async status => { expect(status.held).toBe(true); acquired(); await released; });
    await held;
    const cancellation = new AbortController(); h.request.signal = cancellation.signal;
    const opening = vi.spyOn(fs, 'open');
    const importing = h.importer(h.request);
    try {
      await vi.waitFor(() => expect(opening.mock.calls.some(([file, flags]) =>
        file === path.join(h.ownerDataDir, 'command-approval-rules.json.lock') && flags === 'wx')).toBe(true),
      { timeout: 80, interval: 1 });
      cancellation.abort();
      expect(await importing).toMatchObject({ kind: 'unavailable' });
    } finally { cancellation.abort(); unlock(); await locking; await importing; opening.mockRestore(); }
    await expect(fs.stat(path.join(h.ownerDataDir, 'command-approval-rules.json'))).rejects.toThrow();
  });

});
