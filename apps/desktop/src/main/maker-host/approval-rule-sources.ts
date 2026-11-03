import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentDeps } from '../../../../../packages/maker-core/src/agents/base-agent.js';
import type { PersonalTurnObservation } from '../../../../../packages/maker-core/src/agents/shared/auto-review-decision.js';
import type { ManagedBashOwner } from './claude-hooks/managed-bash-deny-hook.js';
import type { SessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { createApprovalRuleStore, ApprovalRuleSourceConflict, ApprovalRuleLegacyConflict } from './approval-rule-store.js';
import { promises as fs, type BigIntStats } from 'node:fs';
import { readBoundedFileNoFollowWithStat } from '../utils/readBoundedFile.js';
import { isDeepStrictEqual } from 'node:util';
import { qualifyNativeSource, type NativeSourceRegistration } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/readers/registration.js';
import { readClaudePersonalRules, type ClaudeLiveSourceContents } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/readers/claude-code.js';
import { readCodexPersonalRules, parseCodexUserRuleContent } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/readers/codex.js';
import { normalizeRuleGroup } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize.js';
import type { ApprovalRuleRefreshInput } from './approval-rule-store.js';

/** A trusted Host supplies these exact sources for this owner, execution host
 * and query. No HOME search, directory discovery or native file writeback. */
export type RegisteredApprovalRuleFile = {
  filePath: string;
  registration: NativeSourceRegistration;
  previousGroupId?: string;
};
export async function readRegisteredApprovalRuleFiles(options: {
  ownerId: string;
  executionHostId: string;
  sources: RegisteredApprovalRuleFile[];
}): Promise<{ inputs: ApprovalRuleRefreshInput[]; qualifiedSourceIds: string[] }> {
  const inputs: ApprovalRuleRefreshInput[] = [];
  const qualifiedSourceIds: string[] = [];
  const conflictingIds = new Set<string>();
  for (const source of options.sources) {
    const registration = source.registration;
    let conflictId = source.previousGroupId ?? 'unregistered-source';
    const unavailable = (reason: string, sourceId = conflictId) =>
      inputs.push({ kind: 'unavailable', reason, sourceId });
    if (!registration) { unavailable('registration-missing'); continue; }
    if (registration.ownerId !== options.ownerId || registration.executionHostId !== options.executionHostId) {
      unavailable('registration-invalid');
      continue;
    }
    const qualified = qualifyNativeSource(registration, registration.harness);
    if (qualified.kind !== 'qualified') { unavailable(qualified.reason); continue; }
    const sourceId = normalizeRuleGroup(qualified.origin, qualified.scope, []).id;
    conflictId = sourceId;
    if (source.previousGroupId && source.previousGroupId !== sourceId) {
      unavailable('registration-invalid'); continue;
    }
    if (typeof source.filePath !== 'string' || !path.isAbsolute(source.filePath)) {
      unavailable('locator-unverified'); continue;
    }
    try {
      const resolved = await fs.realpath(source.filePath);
      if (resolved !== registration.canonicalLocator) { unavailable('locator-unverified'); continue; }
      const stats = await fs.stat(resolved);
      if (!stats.isFile() || stats.size > 1_000_000) { unavailable('source-invalid'); continue; }
      const content = await fs.readFile(resolved, 'utf8');
      const result = registration.harness === 'claude-code'
        ? readClaudePersonalRules(JSON.parse(content), registration)
        : readCodexPersonalRules(content, registration);
      if (result.kind !== 'available') { unavailable(result.reason); continue; }
      if (result.group.id !== sourceId) { unavailable('registration-invalid', sourceId); continue; }
      if (conflictingIds.has(sourceId)) continue;
      const prior = inputs.find(input => input.kind === 'available' && input.group.id === sourceId);
      if (prior?.kind === 'available') {
        if (isDeepStrictEqual(prior.group, result.group)) continue;
        conflictingIds.add(sourceId);
        inputs.splice(inputs.indexOf(prior), 1);
        qualifiedSourceIds.splice(qualifiedSourceIds.indexOf(sourceId), 1);
        unavailable('source-conflict', sourceId);
        continue;
      }
      inputs.push(result);
      qualifiedSourceIds.push(result.group.id);
    } catch { unavailable('source-invalid'); }
  }
  const unavailableIds = new Set(inputs.filter(input => input.kind === 'unavailable')
    .map(input => input.kind === 'unavailable' ? input.sourceId : ''));
  return { inputs: inputs.filter(input => input.kind === 'unavailable'
    || !unavailableIds.has(input.group.id)),
    qualifiedSourceIds: qualifiedSourceIds.filter(id => !unavailableIds.has(id)) };
}

type LiveRequest = Parameters<NonNullable<AgentDeps['onClaudeLiveUserRules']>>[0];
type LiveSession = { id: string; instanceId: string; agentKind: string; workDir: string;
  remoteHostId: string | null; agentDeviceId: string | null; getStatus(): string };
const liveRowEligible = (row: SessionRowSnapshot | null, kind = 'cc'): row is SessionRowSnapshot =>
  !!row && row.status === 'active' && row.source === 'desktop' && row.agentKind === kind
  && !row.remoteHostId && !row.agentDeviceId && !row.orcaRole && !row.orcaRemoteLead
  && typeof row.workingDir === 'string' && !!row.workingDir;
const liveRowIdentity = (row: SessionRowSnapshot) => [row.status, row.source, row.agentKind,
  row.remoteHostId, row.agentDeviceId, row.orcaRole, row.orcaRemoteLead, row.workingDir,
  row.workspaceKind, row.clearedAt];

type ContentImportDeps = {
  captureOwner(): ManagedBashOwner | null;
  ownerCurrent(owner: ManagedBashOwner): boolean;
  listSessions(): LiveSession[];
  readSessionRow(sessionId: string): Promise<SessionRowSnapshot | null>;
};
type ContentRequest = Pick<LiveRequest, 'sessionId' | 'sessionInstanceId' | 'workingDir' | 'isCurrent' | 'signal'>
  & Pick<LiveRequest, 'execution'>;

class ContentUnavailable extends Error {}

async function captureContentImport(deps: ContentImportDeps, request: ContentRequest,
  harness: 'claude-code' | 'codex', profileValid: boolean) {
  const owner = deps.captureOwner();
  const unavailable = (reason: string): never => { throw new ContentUnavailable(reason); };
  if (!owner || !deps.ownerCurrent(owner) || !request.isCurrent() || request.signal.aborted)
    return unavailable('context-changed');
  if (!profileValid) return unavailable('profile-unavailable');
  const rowKind = harness === 'claude-code' ? 'cc' : 'codex';
  const matches = deps.listSessions().filter(session => session.id === request.sessionId);
  if (matches.length !== 1) return unavailable('session-unverified');
  const session = matches[0]!;
  const workDir = session.workDir;
  const runtimeCurrent = () => deps.ownerCurrent(owner)
    && deps.listSessions().filter(candidate => candidate.id === request.sessionId).length === 1
    && deps.listSessions().find(candidate => candidate.id === request.sessionId) === session
    && session.instanceId === request.sessionInstanceId && session.workDir === workDir
    && session.agentKind === harness && session.getStatus() === 'active'
    && !session.remoteHostId && !session.agentDeviceId;
  const current = () => request.isCurrent() && !request.signal.aborted && runtimeCurrent();
  const assertCurrent = () => { if (!current()) throw new Error('Live approval context changed'); };
  assertCurrent();
  const row = await deps.readSessionRow(session.id);
  assertCurrent();
  if (!liveRowEligible(row, rowKind)) return unavailable('task-unqualified');
  const rowIdentity = liveRowIdentity(row);
  const canonicalDirectory = async (directory: string, check = assertCurrent) => {
    check();
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('cwd-unverified');
    const canonical = await fs.realpath(directory);
    check();
    const stat = await fs.stat(canonical, { bigint: true });
    check();
    if (!stat.isDirectory()) throw new Error('cwd-unverified');
    return { path: canonical, dev: stat.dev, ino: stat.ino };
  };
  const projectId = await canonicalDirectory(request.workingDir);
  const verifyCwd = async (originalCwd?: string, check = assertCurrent) => {
    const latest = await deps.readSessionRow(session.id);
    check();
    if (!liveRowEligible(latest, rowKind) || !isDeepStrictEqual(liveRowIdentity(latest), rowIdentity))
      throw new Error('task-changed');
    for (const directory of [request.workingDir, workDir, latest.workingDir!, ...(originalCwd ? [originalCwd] : [])]) {
      if (!isDeepStrictEqual(await canonicalDirectory(directory, check), projectId)) throw new Error('cwd-unverified');
    }
    // The strict DB snapshot is checked again after asynchronous filesystem reads.
    const finalRow = await deps.readSessionRow(session.id);
    check();
    if (!liveRowEligible(finalRow, rowKind) || !isDeepStrictEqual(liveRowIdentity(finalRow), rowIdentity))
      throw new Error('task-changed');
  };
  await verifyCwd();
  const revalidateExecution = request.execution ? async () => {
    const check = () => { if (!runtimeCurrent() || !request.execution?.isCurrent()) throw new Error('Personal execution changed'); };
    try { check(); await verifyCwd(undefined, check); check(); return true; } catch { return false; }
  } : undefined;
  return { owner, assertCurrent, verifyCwd, projectId: projectId.path, revalidateExecution };
}

/** Saves observed content only. The lease is never persisted or reused as a
 * different session's loaded-source qualification. Native startup is independent. */
export function createClaudeLiveUserRulesImporter(deps: ContentImportDeps) {
  return async (request: LiveRequest) => {
    let managedObservation: PersonalTurnObservation | undefined;
    const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason,
      ...(managedObservation ? { observation: managedObservation } : {}) });
    try {
      const profile = request.spawnProfile;
      const { owner, assertCurrent, verifyCwd, projectId, revalidateExecution } = await captureContentImport(deps, request, 'claude-code',
        !!request.execution || (!!profile && profile.platform === process.platform && path.isAbsolute(profile.configRoot)
        && (profile.basis === 'explicit-config-dir' || profile.basis === 'default-home')));
      assertCurrent();
      const contentScope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, projectId, harnesses: ['claude-code' as const] };
      const readManaged = async () => {
        if (!revalidateExecution || !await revalidateExecution()) throw new Error('Managed execution changed');
        const check = () => {
          if (!deps.ownerCurrent(owner) || !request.execution?.isCurrent()) throw new Error('Managed execution changed');
        };
        const activeStore = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir: owner.ownerDataDir,
          localManagedCommandHostId: owner.executionHostId, assertCurrent: check,
          resolveManagedConsumer: () => ({ scope: contentScope, sessionId: request.sessionId, sessionInstanceId: request.sessionInstanceId }) });
        let published: Awaited<ReturnType<typeof activeStore.readPublishedManagedSnapshot>>;
        try {
          published = await activeStore.readPublishedManagedSnapshot();
        }
        catch {
          if (!await revalidateExecution()) throw new Error('Managed execution changed');
          // Missing restriction evidence needs ordinary human confirmation;
          // it is neither an empty rule set nor an execution-identity failure.
          return { kind: 'unavailable' as const, reason: 'managed-storage-unavailable' };
        }
        if (!await revalidateExecution()) throw new Error('Managed execution changed');
        if (published.kind === 'unavailable') return { kind: 'unavailable' as const, reason: published.reason };
        try {
          if (activeStore.getAppliedState().generatedRevision !== (published.kind === 'published-managed' ? published.revision : undefined))
            return { kind: 'unavailable' as const, reason: 'managed-publication-changed' };
        } catch {
          check(); // Identity failures must never be recategorized as missing storage evidence.
          return { kind: 'unavailable' as const, reason: 'managed-storage-unavailable' };
        }
        const groups = published.kind === 'published-managed' ? published.groups : [];
        return { scope: contentScope, groups, fingerprint: createHash('sha256')
          .update(JSON.stringify([published.kind === 'published-managed' ? published.revision : null, groups])).digest('hex') };
      };
      managedObservation = revalidateExecution ? { scope: contentScope, groups: [],
        fingerprint: 'no-live-content', revalidate: revalidateExecution, readManaged } : undefined;
      if (managedObservation) request.onManagedObservation?.(managedObservation);
      if (!profile || profile.platform !== process.platform || !path.isAbsolute(profile.configRoot)
        || (profile.basis !== 'explicit-config-dir' && profile.basis !== 'default-home')) return unavailable('profile-unavailable');
      let contents: Partial<ClaudeLiveSourceContents>;
      try { contents = request.readSources ? await request.readSources() : { userSettings: await request.read() }; }
      catch { contents = {}; }
      assertCurrent();
      const inputs: ApprovalRuleRefreshInput[] = [];
      const observedCwds: string[] = [];
      let unavailableReason = 'source-empty';
      for (const source of ['userSettings', 'projectSettings', 'localSettings'] as const) {
        const content = contents[source];
        if (!content || content.kind !== 'available') {
          if (content) unavailableReason = content.reason;
          continue;
        }
        if (content.source !== source) return unavailable('state-invalid');
        await verifyCwd(content.originalCwd);
        observedCwds.push(content.originalCwd);
        const layer = source === 'userSettings' ? 'user' : source === 'projectSettings' ? 'project' : 'local';
        // Project/local are cwd-level Query views, not a repository root or a
        // canonical settings file. Preserve the established user key verbatim.
        const profileKey = createHash('sha256').update(JSON.stringify(layer === 'user' ? [
          'claude-live-user-v1', profile.platform, path.normalize(profile.configRoot),
        ] : ['claude-live-cwd-v1', profile.platform, path.normalize(profile.configRoot), projectId, source])).digest('hex');
        const group = normalizeRuleGroup({ harness: 'claude-code', layer,
          sourceId: 'cc-live-' + layer + ':' + profileKey, locator: 'claude-code-live://' + source + '/' + profileKey,
          dialectVersion: layer === 'user' ? 'live-user-v1' : 'live-cwd-v1', decisionDomain: 'personal-approval' },
        { ownerId: owner.ownerId, executionHostId: owner.executionHostId, harnesses: ['claude-code'],
          ...(layer === 'user' ? {} : { projectId }) }, content.clauses);
        inputs.push({ kind: 'available', group });
      }
      if (!inputs.length) return { ...unavailable(unavailableReason), ...(managedObservation ? { observation: managedObservation } : {}) };
      const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir: owner.ownerDataDir,
        assertCurrent });
      const previous = store.readSourceImportSnapshot();
      const result = await store.applySourceRefresh(previous.revision, inputs, [], {
        liveContentOnly: true, signal: request.signal,
        beforeWrite: async () => { for (const cwd of observedCwds) await verifyCwd(cwd); },
      });
      assertCurrent();
      const requirements = {
        scope: { ownerId: owner.ownerId, executionHostId: owner.executionHostId, projectId, harnesses: ['claude-code' as const] },
        groups: structuredClone(inputs.flatMap(input => input.kind === 'available' ? [input.group] : [])),
        fingerprint: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
      };
      return result.conflicts.length ? unavailable('source-conflict')
        : { kind: 'saved' as const, revision: result.snapshot.revision,
          ...(revalidateExecution
            ? { observation: { ...requirements, revalidate: revalidateExecution, readManaged } } : {}),
        };
    } catch (error) {
      if (error instanceof ContentUnavailable) return unavailable(error.message);
      if (error instanceof ApprovalRuleSourceConflict || error instanceof ApprovalRuleLegacyConflict)
        return { ...unavailable(error.code), detail: error.reason };
      return unavailable('import-unavailable');
    }
  };
}


type CodexContentRequest = Parameters<NonNullable<AgentDeps['onCodexUserRuleContent']>>[0];
const absoluteLogicalPath = (value: unknown): value is string => typeof value === 'string'
  && path.isAbsolute(value) && !value.includes('\0');
const sameFileVersion = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile()
  && a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Content identity is the logical address supplied by this server/profile.
 * A current realpath or inode verifies this read, never rekeys persisted data. */
export function createCodexUserRuleContentImporter(deps: ContentImportDeps) {
  return async (request: CodexContentRequest) => {
    const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason });
    try {
      const profile = request.serverProfile;
      const { owner, assertCurrent, verifyCwd, projectId } = await captureContentImport(deps, request, 'codex',
        !!profile && absoluteLogicalPath(profile.codexHome)
        && /(?:^|\/|\s)0\.159\.2(?:\s|$)/.test(profile.userAgent)
        && (!profile.platformOs || profile.platformOs === process.platform
          || (process.platform === 'darwin' && profile.platformOs === 'macos')));
      assertCurrent();
      const metadata = await request.read();
      assertCurrent();
      const project = await request.readProject?.();
      assertCurrent();
      const sources: Array<{ layer: 'user'; file: string; profile: string | null; version: string }
        | { layer: 'project'; dotCodexFolder: string; version: string }> = [];
      for (const content of [metadata, project]) {
        if (!content || content.kind !== 'available') continue;
        if (content.nativeEffect !== 'not-attested' || content.requestedCwd !== request.workingDir
          || !Array.isArray(content.sources) || !content.sources.length) return unavailable('metadata-invalid');
        await verifyCwd(content.requestedCwd);
      }
      if (metadata.kind === 'available') sources.push(...metadata.sources.map(source => ({ ...source, layer: 'user' as const })));
      if (project?.kind === 'available') sources.push(...project.sources.map(source => ({ ...source, layer: 'project' as const })));
      if (!sources.length) return unavailable(project?.kind === 'unavailable' ? project.reason
        : metadata.kind === 'unavailable' ? metadata.reason : 'source-unavailable');
      const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir: owner.ownerDataDir, assertCurrent });
      const previous = store.readSourceImportSnapshot();
      const storedSourceIds = new Set([
        ...previous.groups.map(group => group.id), ...previous.tombstones.map(entry => entry.id),
        ...(previous.managedOverrides ?? []).flatMap(entry => [entry.id,
          ...(entry.baseline ? [entry.baseline.id] : []),
          ...(entry.replacesSourceId ? [entry.replacesSourceId] : [])]),
      ]);
      const inputs: ApprovalRuleRefreshInput[] = [];
      const checks: Array<() => Promise<void>> = [];
      const physical = new Map<string, string>();
      for (const source of sources) {
        assertCurrent();
        if (!source || typeof source.version !== 'string' || !source.version
          || (source.layer === 'user' ? !absoluteLogicalPath(source.file)
            || (source.profile !== null && (typeof source.profile !== 'string' || !source.profile))
            : !absoluteLogicalPath(source.dotCodexFolder))) return unavailable('metadata-invalid');
        // Derive from the logical config parent/folder BEFORE resolving symlinks.
        // Project scope is this verified cwd view, not a guessed repository root.
        const directory = path.join(source.layer === 'user' ? path.dirname(path.normalize(source.file))
          : path.normalize(source.dotCodexFolder), 'rules');
        const directoryId = createHash('sha256').update(JSON.stringify(source.layer === 'user'
          ? [profile.codexHome, source.file, source.profile]
          : ['project', profile.codexHome, source.dotCodexFolder])).digest('hex');
        let names: string[];
        let realDirectory: string;
        let directoryStat: BigIntStats;
        try {
          realDirectory = await fs.realpath(directory); assertCurrent();
          directoryStat = await fs.stat(realDirectory, { bigint: true }); assertCurrent();
          if (!directoryStat.isDirectory()) throw new Error('rules-directory-invalid');
          names = await fs.readdir(directory); assertCurrent();
          if (names.length > 256) throw new Error('rules-directory-too-large');
        } catch {
          assertCurrent();
          inputs.push({ kind: 'unavailable', sourceId: 'codex-' + source.layer + '-content-directory:' + directoryId, reason: 'source-unavailable' });
          continue;
        }
        const verifyDirectory = async () => {
          assertCurrent();
          const real = await fs.realpath(directory); assertCurrent();
          const latest = await fs.stat(real, { bigint: true }); assertCurrent();
          if (real !== realDirectory || !latest.isDirectory()
            || latest.dev !== directoryStat.dev || latest.ino !== directoryStat.ino) throw new Error('rules-directory-changed');
        };
        for (const name of names.filter(name => path.extname(name) === '.rules').sort()) {
          assertCurrent();
          const logical = path.join(directory, name);
          const key = createHash('sha256').update(JSON.stringify(source.layer === 'user'
            ? ['codex-user-content-v1', process.platform, path.normalize(profile.codexHome),
              path.normalize(source.file), source.profile, logical]
            : ['codex-project-content-v1', process.platform, path.normalize(profile.codexHome),
              path.normalize(source.dotCodexFolder), logical])).digest('hex');
          const groupOrigin = { harness: 'codex' as const, layer: source.layer,
            sourceId: 'codex-' + source.layer + '-content:' + key,
            locator: 'codex-' + source.layer + '-content://' + source.layer + '/' + key,
            dialectVersion: source.layer + '-content-v1', decisionDomain: 'unknown' as const };
          const groupScope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, harnesses: ['codex' as const],
            ...(source.layer === 'project' ? { projectId } : {}) };
          const id = normalizeRuleGroup(groupOrigin, groupScope, []).id;
          try {
            const initialPath = await fs.lstat(logical, { bigint: true }); assertCurrent();
            if (!initialPath.isFile() || initialPath.size > 1_000_000n) throw new Error('rule-not-ordinary');
            const real = await fs.realpath(logical); assertCurrent();
            const read = await readBoundedFileNoFollowWithStat(logical, 1_000_000, {
              nonBlocking: true, containWithin: realDirectory, verifyContentStability: true,
            });
            assertCurrent();
            if (!read || !sameFileVersion(initialPath, read.stat)) throw new Error('rule-replaced');
            const initialFd = read.stat;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
            const parsed = parseCodexUserRuleContent(text);
            if (parsed.kind !== 'parsed' || !parsed.clauses.length) throw new Error('source-empty');
            const verify = async () => {
              await verifyDirectory();
              const finalPath = await fs.lstat(logical, { bigint: true }); assertCurrent();
              const finalReal = await fs.realpath(logical); assertCurrent();
              if (real !== finalReal || !sameFileVersion(initialFd, finalPath)) throw new Error('rule-changed');
            };
            await verify();
            const identity = (source.layer === 'project' ? 'project:' + projectId + ':' : '') + initialFd.dev + ':' + initialFd.ino;
            const alias = physical.get(identity);
            if (alias) {
              // Never merge an already stored alternate logical address.
              if (alias !== id && storedSourceIds.has(id)) {
                inputs.push({ kind: 'unavailable', sourceId: alias, reason: 'source-alias-conflict' });
                inputs.push({ kind: 'unavailable', sourceId: id, reason: 'source-alias-conflict' });
              }
              continue;
            }
            physical.set(identity, id);
            inputs.push({ kind: 'available', group: normalizeRuleGroup(groupOrigin, groupScope, parsed.clauses) });
            checks.push(verify);
          } catch {
            assertCurrent();
            inputs.push({ kind: 'unavailable', sourceId: id, reason: 'source-invalid' });
          }
        }
      }
      if (!inputs.some(input => input.kind === 'available')) return unavailable('source-unavailable');
      const result = await store.applySourceRefresh(previous.revision, inputs, [], {
        liveContentOnly: true, signal: request.signal,
        beforeWrite: async () => {
          await verifyCwd(request.workingDir);
          for (const verify of checks) { assertCurrent(); await verify(); }
          assertCurrent();
        },
      });
      assertCurrent();
      return result.conflicts.length && result.snapshot.revision === previous.revision
        ? unavailable('source-conflict') : { kind: 'saved' as const, revision: result.snapshot.revision, conflicts: result.conflicts };
    } catch (error) {
      if (error instanceof ContentUnavailable) return unavailable(error.message);
      if (error instanceof ApprovalRuleSourceConflict || error instanceof ApprovalRuleLegacyConflict)
        return { kind: 'unavailable' as const, reason: error.code, detail: error.reason };
      return unavailable('import-unavailable');
    }
  };
}
