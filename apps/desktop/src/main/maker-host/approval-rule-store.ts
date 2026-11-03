import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { requirementsKey, requirementsNamespace } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';
import { normalizeRuleGroup } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize.js';
import { parseApprovalRuleSnapshot, emptyApprovalRuleSnapshot } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/schema.js';
import { isSupportedManagedCommand, ruleScopeMatches, selectApprovalRuleGroups } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/evaluate.js';
import type { ApprovalRuleSnapshot, RuleScope, UnifiedRule } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/types.js';

export type ApprovalRuleRefreshInput = { kind: 'available'; group: UnifiedRule }
  | { kind: 'unavailable'; reason: string; sourceId: string };
type SourceRefreshOptions = { beforeWrite?: () => Promise<void>; signal?: AbortSignal; liveContentOnly?: boolean };
const liveContent = (group: UnifiedRule) => /^cc-live-(?:user|project|local):/.test(group.origin.sourceId)
  || group.origin.locator.startsWith('claude-code-live://')
  || /^codex-(?:user|project)-content:/.test(group.origin.sourceId)
  || /^codex-(?:user|project)-content:\/\//.test(group.origin.locator);
const knownClaudeProfile = (group: UnifiedRule) => {
  if (group.origin.harness !== 'claude-code') return false;
  const match = /^cc-live-(user|project|local):([a-f0-9]{64})$/.exec(group.origin.sourceId);
  if (!match) return false;
  const [, layer, key] = match;
  const source = layer === 'user' ? 'userSettings' : layer === 'project' ? 'projectSettings' : 'localSettings';
  return group.origin.layer === layer
    && group.origin.locator === 'claude-code-live://' + source + '/' + key
    && group.origin.dialectVersion === (layer === 'user' ? 'live-user-v1' : 'live-cwd-v1')
    && (layer === 'user' ? group.scope.projectId === undefined
      : typeof group.scope.projectId === 'string' && path.isAbsolute(group.scope.projectId));
};

const knownLiveProfile = (group: UnifiedRule) => knownClaudeProfile(group)
  || (group.origin.harness === 'codex' && (group.origin.layer === 'user' || group.origin.layer === 'project')
    && group.origin.decisionDomain === 'unknown'
    && new RegExp('^codex-' + group.origin.layer + '-content:[a-f0-9]{64}$').test(group.origin.sourceId)
    && group.origin.locator === 'codex-' + group.origin.layer + '-content://' + group.origin.layer + '/'
      + group.origin.sourceId.slice(('codex-' + group.origin.layer + '-content:').length)
    && group.origin.dialectVersion === group.origin.layer + '-content-v1'
    && (group.origin.layer === 'user' ? group.scope.projectId === undefined
      : typeof group.scope.projectId === 'string' && path.isAbsolute(group.scope.projectId)));

export class ApprovalRuleSourceConflict extends Error {
  readonly code = 'source-identity-conflict';
  constructor(readonly reason: string) { super(reason); }
}

type Publication = { requestedRevision?: number; generatedRevision?: number };
type ManagedConsumer = { scope: RuleScope; sessionId: string; sessionInstanceId: string };

export class ApprovalRuleLegacyConflict extends Error {
  readonly code = 'LEGACY_CONFLICT';
  constructor(readonly reason: string) { super('Approval rule legacy conflict: ' + reason); }
}

export class ApprovalRuleHostIdentityConflict extends Error {
  readonly code = 'host-identity-conflict';
  constructor() { super('Approval rule host identity conflict'); }
}

/** The caller pins owner identity and data root. No HOME or native policy access. */
export function createApprovalRuleStore(options: {
  ownerId: string; ownerDataDir: string; assertCurrent(): void;
  /** Trusted Host callback, bound to the active execution; never model/tool arguments. */
  resolveManagedConsumer?: () => ManagedConsumer | null;
  /** Main's stable local ID, only for the local exact-bash command namespace. */
  localManagedCommandHostId?: string;
}) {
  if (!options.ownerId || !path.isAbsolute(options.ownerDataDir))
    throw new Error('Owner-scoped absolute approval rule directory required');
  const file = path.join(options.ownerDataDir, 'command-approval-rules.json');
  const runtime = path.join(options.ownerDataDir, 'command-approval-runtime');
  const publicationFile = path.join(runtime, 'publish-state.json');
  const checkOwner = (scope: RuleScope) => {
    options.assertCurrent();
    if (scope.ownerId !== options.ownerId) throw new Error('Approval rule owner mismatch');
  };
  const validId = (group: UnifiedRule) => {
    try { return normalizeRuleGroup(group.origin, group.scope, group.clauses).id === group.id; }
    catch { return false; }
  };
  const commandHostConflict = (groups: UnifiedRule[]) => options.localManagedCommandHostId !== undefined
    && groups.some(group => group.origin.harness === 'cindy'
      && (group.origin.sourceId.startsWith('exact-bash:') || group.origin.sourceId.startsWith('exact-codex-command:')
        || group.origin.locator.startsWith('cindy://personal-approval/exact-bash/')
        || group.origin.locator.startsWith('cindy://personal-approval/exact-codex-command/')
        || requirementsNamespace(group.origin))
      && group.scope.executionHostId !== options.localManagedCommandHostId);
  const assertCommandHost = (groups: UnifiedRule[]) => {
    if (commandHostConflict(groups)) throw new ApprovalRuleHostIdentityConflict();
  };
  const observeFile = (target: string): string | null => {
    try { return fs.readFileSync(target, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (fs.existsSync(target + '.bak')) throw new ApprovalRuleSourceConflict('pending-atomic-recovery');
      return null;
    }
  };
  const read = (repair = true): ApprovalRuleSnapshot => {
    options.assertCurrent();
    let raw: string | null;
    if (repair) raw = readAtomicFileSync(file);
    else {
      // A bounded live observation must never initiate backup recovery.
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (fs.existsSync(file + '.bak')) throw new ApprovalRuleSourceConflict('pending-atomic-recovery');
        raw = null;
      }
    }
    if (raw === null) return emptyApprovalRuleSnapshot();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ApprovalRuleLegacyConflict('invalid-snapshot'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApprovalRuleLegacyConflict('invalid-snapshot');
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.groups) && record.groups.some(group => group && typeof group === 'object'
      && (!('scope' in group) || !(group as { scope?: { harnesses?: unknown } }).scope?.harnesses)))
      throw new ApprovalRuleLegacyConflict('missing-harnesses');
    let parsed: ApprovalRuleSnapshot;
    try { parsed = parseApprovalRuleSnapshot(value); }
    catch { throw new ApprovalRuleLegacyConflict('invalid-snapshot'); }
    if (parsed.groups.some(group => group.scope.ownerId !== options.ownerId))
      throw new Error('Approval rule owner mismatch');
    if (parsed.groups.some(group => !validId(group))) throw new ApprovalRuleLegacyConflict('old-id');
    if (parsed.managedOverrides !== undefined && !Array.isArray(parsed.managedOverrides))
      throw new ApprovalRuleLegacyConflict('managed-reference');
    if (parsed.managedOverrides?.some(entry => entry.scope.ownerId !== options.ownerId
      || (!parsed.groups.some(group => group.id === entry.id)
        && !parsed.tombstones.some(tombstone => tombstone.id === entry.id))
      || (entry.baseline && entry.baseline.id !== entry.id)
      || (entry.replacesSourceId && !parsed.groups.some(group => group.id === entry.replacesSourceId
        && group.origin.layer === 'user' && group.scope.projectId === undefined
        && entry.scope.projectId !== undefined
        && normalizeRuleGroup(group.origin, entry.scope, group.clauses).id === entry.id))))
      throw new ApprovalRuleLegacyConflict('managed-reference');
    if (parsed.tombstones.some(entry => !parsed.managedOverrides?.some(override => override.id === entry.id)))
      throw new ApprovalRuleLegacyConflict('orphan-tombstone');
    return parsed;
  };
  // Count only current groups, in each exact owner/host/project/target scope.
  // Tombstones and project baseline copies are references, not extra user text.
  const assertRequirementsBudget = (snapshot: ApprovalRuleSnapshot) => {
    const sizes = new Map<string, number>();
    for (const group of snapshot.groups) if (requirementsNamespace(group.origin)) {
      const key = JSON.stringify([group.scope.ownerId, group.scope.executionHostId,
        group.scope.projectId ?? null, group.scope.harnesses]);
      const size = (sizes.get(key) ?? 0) + group.clauses.reduce((sum, clause) => sum + Buffer.byteLength(clause.original, 'utf8'), 0);
      if (size > 64 * 1024) throw new Error('Personal requirements exceed 64 KiB per scope');
      sizes.set(key, size);
    }
  };
  const write = (snapshot: ApprovalRuleSnapshot): ApprovalRuleSnapshot => {
    const valid = parseApprovalRuleSnapshot(snapshot);
    assertRequirementsBudget(valid);
    options.assertCurrent();
    atomicWriteFileSync(file, JSON.stringify(valid, null, 2) + String.fromCharCode(10));
    return valid;
  };
  const mutate = async <T>(run: () => T | Promise<T>, signal?: AbortSignal): Promise<T> => {
    options.assertCurrent();
    signal?.throwIfAborted();
    fs.mkdirSync(options.ownerDataDir, { recursive: true });
    return withCrossProcessLock(file + '.lock', { label: 'command approval rules' }, async status => {
      if (!status.held) throw new Error('Approval rule store lock ' + status.reason);
      options.assertCurrent();
      return await run();
    }, signal);
  };
  const sameScope = (a: RuleScope, b: RuleScope) => a.ownerId === b.ownerId
    && a.executionHostId === b.executionHostId && a.projectId === b.projectId
    && isDeepStrictEqual([...(a.harnesses ?? [])].sort(), [...(b.harnesses ?? [])].sort());
  /** Explicit Cindy commands and keyed requirements share whole-group project references. */
  const managedSource = (group: UnifiedRule): string | undefined => {
    if (requirementsKey(group)) return normalizeRuleGroup(group.origin, { ...group.scope, projectId: undefined }, group.clauses).id;
    const harness = group.scope.harnesses?.length === 1 ? group.scope.harnesses[0] : undefined;
    const clause = group.clauses.length === 1 ? group.clauses[0] : undefined;
    if (!harness || group.origin.harness !== 'cindy' || group.origin.layer !== 'user'
      || group.origin.decisionDomain !== 'personal-approval' || !validId(group)
      || !group.origin.sourceId.startsWith(harness === 'codex' ? 'exact-codex-command:' : 'exact-bash:')
      || clause?.tool?.domain !== 'exec' || clause.tool.name !== ({ 'claude-code': 'Bash', pi: 'bash', codex: 'exec' }[harness])
      || clause.matcher?.kind !== 'cc-command' || clause.matcher.mode !== 'exact') return undefined;
    return normalizeRuleGroup(group.origin, { ...group.scope, projectId: undefined }, group.clauses).id;
  };
  const reconcileManagedProjects = (snapshot: ApprovalRuleSnapshot, sources: Set<string>): ApprovalRuleSnapshot => {
    const overrides = new Map(snapshot.managedOverrides?.map(entry => [entry.id, entry]));
    for (const entry of overrides.values()) {
      if (entry.replacesSourceId && sources.has(entry.replacesSourceId)) {
        const group = snapshot.groups.find(group => group.id === entry.id);
        if (!group || managedSource(group) !== entry.replacesSourceId)
          throw new ApprovalRuleSourceConflict('managed-project-reference');
      }
    }
    for (const group of snapshot.groups) {
      if (group.scope.projectId === undefined) continue;
      const sourceId = managedSource(group);
      if (!sourceId || !sources.has(sourceId)) continue;
      const old = overrides.get(group.id);
      if (old && (!sameScope(old.scope, group.scope)
        || (old.replacesSourceId && old.replacesSourceId !== sourceId)
        || (old.baseline && managedSource(old.baseline) !== sourceId)))
        throw new ApprovalRuleSourceConflict('managed-project-reference');
      const { baseline: _baseline, replacesSourceId: _source, ...rest } = old
        ?? { id: group.id, scope: group.scope, revision: snapshot.revision };
      const source = snapshot.groups.find(candidate => candidate.id === sourceId && candidate.scope.projectId === undefined);
      overrides.set(group.id, { ...rest, revision: snapshot.revision, ...(source ? { replacesSourceId: sourceId,
        baseline: normalizeRuleGroup(source.origin, group.scope, source.clauses) } : {}) });
    }
    return { ...snapshot, managedOverrides: [...overrides.values()] };
  };
  const visible = (snapshot: ApprovalRuleSnapshot, scope: RuleScope): ApprovalRuleSnapshot => {
    checkOwner(scope);
    const applies = (overrideScope: RuleScope) => (scope.harnesses ?? [])
      .some(harness => ruleScopeMatches(overrideScope, scope, harness));
    const replacements = new Set(snapshot.managedOverrides?.filter(override => override.replacesSourceId
      && applies(override.scope)).map(override => override.replacesSourceId));
    const candidates = snapshot.groups.filter(group => !replacements.has(group.id));
    const visibleIds = new Set((scope.harnesses ?? []).flatMap(harness =>
      selectApprovalRuleGroups(candidates, scope, harness).map(group => group.id)));
    return { ...snapshot, groups: candidates.filter(group => visibleIds.has(group.id)),
      tombstones: snapshot.tombstones.filter(tombstone => snapshot.managedOverrides?.some(override =>
        override.id === tombstone.id && applies(override.scope))),
      managedOverrides: snapshot.managedOverrides?.filter(override => applies(override.scope)) };
  };
  const publication = (observeOnly = false): Publication => {
    options.assertCurrent();
    const raw = observeOnly ? observeFile(publicationFile) : readAtomicFileSync(publicationFile);
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !Number.isSafeInteger((value as Publication).generatedRevision)
      || (value as Publication).requestedRevision !== (value as Publication).generatedRevision)
      throw new Error('Invalid approval publication');
    return { requestedRevision: (value as Publication).requestedRevision,
      generatedRevision: (value as Publication).generatedRevision };
  };
  const requireRevision = (snapshot: ApprovalRuleSnapshot, expected: number) => {
    if (snapshot.revision !== expected) throw new Error('Approval rule revision changed');
  };
  const readPublishedRevision = (revision: number, observeOnly = false): ApprovalRuleSnapshot => {
    const artifact = path.join(runtime, 'revisions', String(revision), 'snapshot.json');
    const raw = observeOnly ? observeFile(artifact) : readAtomicFileSync(artifact);
    if (raw === null) throw new Error('Published approval snapshot missing');
    const snapshot = parseApprovalRuleSnapshot(JSON.parse(raw));
    if (snapshot.revision !== revision) throw new Error('Published approval revision mismatch');
    if (snapshot.groups.some(group => !validId(group)))
      throw new ApprovalRuleLegacyConflict('old-id');
    if (snapshot.groups.some(group => group.scope.ownerId !== options.ownerId)
      || snapshot.managedOverrides?.some(override => override.scope.ownerId !== options.ownerId))
      throw new Error('Published approval owner mismatch');
    return snapshot;
  };
  // Even failed/uncommitted artifacts reserve their revision forever.
  const nextRuntimeRevision = (floor: number) => {
    let maximum = Math.max(floor, publication().generatedRevision ?? 0);
    const revisions = path.join(runtime, 'revisions');
    if (fs.existsSync(revisions)) for (const entry of fs.readdirSync(revisions)) {
      const value = Number(entry);
      if (/^[0-9]+$/.test(entry) && Number.isSafeInteger(value)) maximum = Math.max(maximum, value);
    }
    if (!Number.isSafeInteger(maximum + 1)) throw new Error('Approval revision exhausted');
    return maximum + 1;
  };
  const artifactBytes = (snapshot: ApprovalRuleSnapshot) => JSON.stringify(parseApprovalRuleSnapshot(snapshot), null, 2) + String.fromCharCode(10);
  const prepareArtifact = (snapshot: ApprovalRuleSnapshot) => {
    assertRequirementsBudget(snapshot);
    options.assertCurrent();
    const artifact = path.join(runtime, 'revisions', String(snapshot.revision), 'snapshot.json');
    const bytes = artifactBytes(snapshot);
    const existing = readAtomicFileSync(artifact);
    if (existing !== null) {
      if (existing !== bytes) throw new Error('Immutable approval artifact conflict');
      return;
    }
    atomicWriteFileSync(artifact, bytes);
  };
  const activate = (revision: number) => {
    options.assertCurrent();
    atomicWriteFileSync(publicationFile, JSON.stringify({ requestedRevision: revision, generatedRevision: revision }) + String.fromCharCode(10));
  };
  const validManagedConsumer = (consumer: ManagedConsumer | null | undefined): consumer is ManagedConsumer =>
    !!consumer && typeof consumer.sessionId === 'string' && !!consumer.sessionId
    && typeof consumer.sessionInstanceId === 'string' && !!consumer.sessionInstanceId
    && !!consumer.scope && consumer.scope.ownerId === options.ownerId
    && typeof consumer.scope.executionHostId === 'string' && !!consumer.scope.executionHostId
    && typeof consumer.scope.projectId === 'string' && !!consumer.scope.projectId
    && (isDeepStrictEqual(consumer.scope.harnesses, ['claude-code'])
      || isDeepStrictEqual(consumer.scope.harnesses, ['pi'])
      || isDeepStrictEqual(consumer.scope.harnesses, ['codex']));
  return {
    async readSnapshot(scope: RuleScope): Promise<ApprovalRuleSnapshot> {
      const snapshot = read();
      assertCommandHost(snapshot.groups);
      return visible(snapshot, scope);
    },
    /** Whole-owner content view for the live importer; deliberately no repair. */
    readSourceImportSnapshot(): ApprovalRuleSnapshot { return read(false); },
    async applySourceRefresh(expectedRevision: number, inputs: ApprovalRuleRefreshInput[], deletedIds: string[] = [], refresh?: SourceRefreshOptions) {
      return mutate(async () => {
        if (refresh?.beforeWrite) await refresh.beforeWrite();
        refresh?.signal?.throwIfAborted();
        options.assertCurrent();
        const previous = read(!refresh?.liveContentOnly); requireRevision(previous, expectedRevision);
        if (refresh?.liveContentOnly) {
          const incoming = inputs.filter((input): input is Extract<ApprovalRuleRefreshInput, { kind: 'available' }> => input.kind === 'available');
          if (incoming.some(input => !knownLiveProfile(input.group)))
            throw new ApprovalRuleSourceConflict('live-profile-invalid');
          const all = [...previous.groups, ...(previous.managedOverrides ?? []).flatMap(entry => entry.baseline ? [entry.baseline] : [])];
          for (const { group } of incoming) {
            const ambiguous = all.some(old => old.origin.harness === group.origin.harness
              && old.origin.layer === group.origin.layer && old.scope.projectId === group.scope.projectId
              && old.scope.ownerId === group.scope.ownerId && old.scope.executionHostId === group.scope.executionHostId
              && !knownLiveProfile(old));
            if (ambiguous) throw new ApprovalRuleSourceConflict('file-or-unknown-source');
          }
        }
        const groups = new Map(previous.groups.map(group => [group.id, group]));
        const blocked = new Set(deletedIds);
        const candidates = new Map<string, UnifiedRule[]>();
        for (const input of inputs) {
          if (input.kind === 'unavailable') { blocked.add(input.sourceId); continue; }
          const group = input.group;
          checkOwner(group.scope);
          if (!validId(group) || group.origin.harness === 'cindy') throw new Error('Invalid native source group');
          const variants = candidates.get(group.id) ?? [];
          variants.push(group);
          candidates.set(group.id, variants);
        }
        for (const [id, variants] of candidates) {
          if (variants.some(group => !isDeepStrictEqual(
            { ...group, revision: 0 }, { ...variants[0]!, revision: 0 },
          ))) blocked.add(id);
        }
        const conflicts: string[] = [...blocked];
        let changed = false;
        const revision = previous.revision + 1;
        for (const [id, variants] of candidates) {
          if (blocked.has(id)) continue;
          const group = variants[0]!;
          const old = groups.get(group.id);
          if (previous.managedOverrides?.some(override => override.id === group.id)) {
            conflicts.push(group.id); continue;
          }
          const replacementConflict = previous.managedOverrides?.some(override => {
            if (override.replacesSourceId !== group.id) return false;
            return !override.baseline || !isDeepStrictEqual(
              { ...override.baseline, revision: 0 },
              { ...normalizeRuleGroup(group.origin, override.scope, group.clauses), revision: 0 },
            );
          });
          if (replacementConflict) { conflicts.push(group.id); continue; }
          if (old && isDeepStrictEqual({ ...old, revision: 0 }, { ...group, revision: 0 })) continue;
          groups.set(group.id, { ...group, revision }); changed = true;
        }
        // A bare deleted ID carries no effective-layer or owner/project proof.
        // It was added to blocked above, retaining the last valid source.
        const snapshot = changed ? write({ ...previous, revision, groups: [...groups.values()] }) : previous;
        return { snapshot, conflicts: [...new Set(conflicts)] };
      }, refresh?.signal);
    },
    async applyManagedEdit(expectedRevision: number, scope: RuleScope, edits: UnifiedRule[], deletedIds: string[] = [], beforeWrite?: () => Promise<void>, immediate = false, explicitTargets = false) {
      return mutate(async () => {
        await beforeWrite?.();
        checkOwner(scope);
        const previous = read(); requireRevision(previous, expectedRevision);
        assertCommandHost([...previous.groups, ...edits]);
        const groups = new Map(previous.groups.map(group => [group.id, group]));
        const overrides = new Map(previous.managedOverrides?.map(override => [override.id, override]));
        const effectiveRevision = immediate ? publication().generatedRevision : undefined;
        const baseline = effectiveRevision === undefined ? emptyApprovalRuleSnapshot() : readPublishedRevision(effectiveRevision);
        // A previous activation failure may have saved this explicit deletion in
        // draft already. Retry against the still-effective owned target.
        const deletionTarget = (id: string) => groups.get(id) ?? (immediate
          ? baseline.groups.find(group => group.id === id) : undefined);
        const managedSources = new Set([...edits, ...deletedIds.flatMap(id => { const group = deletionTarget(id); return group ? [group] : []; })]
          .flatMap(group => { const source = managedSource(group); return source ? [source] : []; }));
        if (new Set(edits.map(group => group.id)).size !== edits.length
          || new Set(deletedIds).size !== deletedIds.length
          || deletedIds.some(id => edits.some(group => group.id === id))) throw new Error('Conflicting approval edit');
        // Main's explicit mapping is one atomic edit, while every stored group
        // retains its original single-harness identity and consumer scope.
        if (explicitTargets) {
          const targets = scope.harnesses ?? [];
          const affected = [...edits, ...deletedIds.flatMap(id => { const group = deletionTarget(id); return group ? [group] : []; })];
          if (!immediate || !targets.length || targets.length > 3 || new Set(targets).size !== targets.length
            || targets.some(target => !['claude-code', 'pi', 'codex'].includes(target))
            || (edits.length > 0 && deletedIds.length > 0) || affected.length !== targets.length
            || new Set(affected.map(group => group.scope.harnesses?.[0])).size !== targets.length
            || new Set(edits.map(group => group.clauses[0]?.decision)).size > 1
            || affected.some(group => !managedSource(group) || group.scope.harnesses?.length !== 1
              || !targets.includes(group.scope.harnesses[0]!)
              || group.clauses[0]?.matcher?.kind !== 'cc-command'
              || !isSupportedManagedCommand(group.clauses[0].matcher.pattern, group.scope.harnesses[0]!)))
            throw new Error('Invalid explicit approval targets');
        }
        const editScopeMatches = (group: UnifiedRule) => sameScope(group.scope, explicitTargets
          ? { ...scope, harnesses: group.scope.harnesses } : scope);
        for (const group of edits) {
          if (!editScopeMatches(group) || !validId(group)) throw new Error('Approval rule scope or identity mismatch');
          const old = groups.get(group.id);
          if (!old && group.origin.harness !== 'cindy') throw new Error('Native rule requires existing source');
          if (old && !isDeepStrictEqual(old.origin, group.origin)) throw new Error('Approval source identity changed');
        }
        for (const id of deletedIds) {
          const target = deletionTarget(id);
          if (!target) throw new Error('Approval rule target not found');
          if (!editScopeMatches(target)) throw new Error('Approval rule target scope mismatch');
        }
        const sharedRequirements = [...edits, ...deletedIds.map(id => deletionTarget(id)!)];
        const qualifiedShared = sharedRequirements.length > 0 && sharedRequirements.every(group => !!requirementsKey(group));
        if (immediate && ((!explicitTargets && !qualifiedShared && !isDeepStrictEqual(scope.harnesses, ['claude-code']) && !isDeepStrictEqual(scope.harnesses, ['pi']) && !isDeepStrictEqual(scope.harnesses, ['codex']))
          || edits.some(group => group.origin.harness !== 'cindy')
          || deletedIds.some(id => deletionTarget(id)?.origin.harness !== 'cindy')))
          throw new Error('Immediate edits require explicit managed CC, Pi or Codex rules');
        const revision = immediate ? nextRuntimeRevision(previous.revision) : previous.revision + 1;
        for (const group of edits) {
          const old = groups.get(group.id);
          if (!overrides.has(group.id)) overrides.set(group.id, { id: group.id, scope: group.scope, revision,
            ...(old?.origin.harness !== 'cindy' && old ? { baseline: old } : {}) });
          groups.set(group.id, { ...group, revision });
        }
        const tombstones = previous.tombstones.filter(entry => !edits.some(group => group.id === entry.id) && !deletedIds.includes(entry.id));
        for (const id of deletedIds) {
          const old = deletionTarget(id)!;
          if (!overrides.has(id) || managedSource(old)) overrides.set(id, { id, scope: old.scope, revision,
            ...(old.origin.harness !== 'cindy' ? { baseline: old } : {}) });
          groups.delete(id);
          tombstones.push({ id, revision });
        }
        const next = reconcileManagedProjects({ ...previous, revision, groups: [...groups.values()], tombstones,
          managedOverrides: [...overrides.values()] }, managedSources);
        assertRequirementsBudget(next);
        if (!immediate) return write(next);
        const touched = new Set([...edits.map(group => group.id), ...deletedIds]);
        const effective = reconcileManagedProjects({ ...baseline, revision,
          groups: [...baseline.groups.filter(group => !touched.has(group.id)), ...next.groups.filter(group => touched.has(group.id))],
          tombstones: [...baseline.tombstones.filter(entry => !touched.has(entry.id)), ...next.tombstones.filter(entry => touched.has(entry.id))],
          managedOverrides: [...(baseline.managedOverrides ?? []).filter(entry => !touched.has(entry.id)),
            ...(next.managedOverrides ?? []).filter(entry => touched.has(entry.id))] }, managedSources);
        // The marker is the activation commit. A failed edit can leave an
        // unactivated draft/artifact, but must retain the old effective policy.
        prepareArtifact(effective);
        const saved = write(next);
        activate(revision);
        return saved;
      });
    },
    async applyProjectReplacement(expectedRevision: number, scope: RuleScope, sourceId: string, replacement?: UnifiedRule) {
      return mutate(() => {
        checkOwner(scope);
        if (!scope.projectId) throw new Error('Explicit project scope required');
        const previous = read(); requireRevision(previous, expectedRevision);
        const groups = new Map(previous.groups.map(group => [group.id, group]));
        const overrides = new Map(previous.managedOverrides?.map(override => [override.id, override]));
        const source = groups.get(sourceId);
        if (!source || source.scope.projectId !== undefined || source.origin.layer !== 'user'
          || !sameScope(source.scope, { ...scope, projectId: undefined }))
          throw new Error('Canonical personal source required');
        const prior = [...overrides.values()].find(override => override.replacesSourceId === sourceId
          && sameScope(override.scope, scope));
        if (replacement) {
          const identity = normalizeRuleGroup(source.origin, scope, source.clauses).id;
          if (replacement.id !== identity || !sameScope(replacement.scope, scope)
            || !isDeepStrictEqual(replacement.origin, source.origin)) throw new Error('Replacement identity mismatch');
          if (groups.has(identity) && prior?.id !== identity) throw new Error('Replacement already exists');
          groups.set(identity, { ...replacement, revision: previous.revision + 1 });
          overrides.set(identity, { id: identity, scope, revision: previous.revision + 1,
            baseline: normalizeRuleGroup(source.origin, scope, source.clauses), replacesSourceId: sourceId });
        } else {
          if (!prior) throw new Error('Project replacement not found');
          groups.delete(prior.id); overrides.delete(prior.id);
        }
        return write({ ...previous, revision: previous.revision + 1, groups: [...groups.values()],
          managedOverrides: [...overrides.values()] });
      });
    },
    async publish(revision: number, beforeWrite?: () => Promise<void>) {
      return mutate(async () => {
        await beforeWrite?.();
        const snapshot = read(); requireRevision(snapshot, revision);
        assertCommandHost(snapshot.groups);
        const artifact = path.join(runtime, 'revisions', String(revision), 'snapshot.json');
        const generated = revision < (publication().generatedRevision ?? 0)
          || (fs.existsSync(artifact) && fs.readFileSync(artifact, 'utf8') !== artifactBytes(snapshot))
          ? { ...snapshot, revision: nextRuntimeRevision(revision) } : snapshot;
        prepareArtifact(generated);
        activate(generated.revision);
        return publication();
      });
    },
    getAppliedState(): Publication { return publication(); },
    /** Read-only authored status projection; never proves a live native consumer. */
    readManagedStatusSnapshot(scope: RuleScope) {
      checkOwner(scope);
      const draft = read(false);
      const state = publication(true);
      const snapshot = state.generatedRevision === undefined ? emptyApprovalRuleSnapshot() : readPublishedRevision(state.generatedRevision, true);
      if (commandHostConflict([...draft.groups, ...snapshot.groups])) return { kind: 'unavailable' as const, reason: 'host-identity-conflict' };
      const savedGroups = visible(draft, scope).groups.filter(group => group.origin.harness === 'cindy');
      const groups = visible(snapshot, scope).groups.filter(group => group.origin.harness === 'cindy');
      return { kind: 'published-managed' as const, revision: snapshot.revision, groups, savedGroups,
        pending: !isDeepStrictEqual(savedGroups, groups) };
    },

    /** Managed-only published bytes; native policy qualification remains unknown. */
    async readPublishedManagedSnapshot() {
      options.assertCurrent();
      const consumer = options.resolveManagedConsumer?.();
      if (!validManagedConsumer(consumer)) return { kind: 'unavailable' as const,
        reason: 'managed-consumer-unverified' };
      const captured = structuredClone(consumer);
      const state = publication();
      if (state.generatedRevision === undefined) return { kind: 'unpublished' as const };
      const snapshot = readPublishedRevision(state.generatedRevision);
      if (commandHostConflict(snapshot.groups)) return { kind: 'unavailable' as const,
        reason: 'host-identity-conflict' };
      options.assertCurrent();
      if (!isDeepStrictEqual(options.resolveManagedConsumer?.(), captured))
        return { kind: 'unavailable' as const, reason: 'managed-consumer-changed' };
      const groups = visible(snapshot, captured.scope).groups.filter(group => group.origin.harness === 'cindy');
      options.assertCurrent();
      return { kind: 'published-managed' as const, revision: snapshot.revision,
        nativeQualification: 'unknown' as const, groups };
    },
    async readPublishedSnapshot(scope: RuleScope, qualification?: { qualifiedSourceIds: string[] }) {
      checkOwner(scope);
      const state = publication();
      if (state.generatedRevision === undefined) return { kind: 'unpublished' as const, state };
      const snapshot = readPublishedRevision(state.generatedRevision);
      const filtered = visible(snapshot, scope);
      if (filtered.groups.some(liveContent) || filtered.managedOverrides?.some(override =>
        (override.baseline && liveContent(override.baseline))
        || (override.replacesSourceId && snapshot.groups.some(group => group.id === override.replacesSourceId && liveContent(group)))))
        return { kind: 'unavailable' as const, reason: 'live-source-content-only', state };
      if (!qualification) return { kind: 'unavailable' as const,
        reason: 'source-qualification-missing', state };
      const eligible = new Set(qualification?.qualifiedSourceIds);
      if (filtered.groups.some(group => group.origin.harness !== 'cindy'
        && !eligible.has(group.id) && !snapshot.managedOverrides?.some(override =>
          override.id === group.id && override.replacesSourceId && eligible.has(override.replacesSourceId))))
        return { kind: 'unavailable' as const, reason: 'source-qualification-missing', state };
      if (filtered.managedOverrides?.some(override => override.baseline?.origin.harness !== 'cindy'
        && override.baseline && !eligible.has(override.replacesSourceId ?? override.baseline.id)))
        return { kind: 'unavailable' as const, reason: 'source-qualification-missing', state };
      return { kind: 'published' as const, snapshot: filtered, state };
    },
  };
}
