import { promises as fs, realpathSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requirementsKey } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';
import { evaluatePersonalRequirements } from '../../../../../packages/maker-core/src/agents/shared/auto-review-decision.js';
import { isDeepStrictEqual } from 'node:util';
import type { AutoReviewRequest, ManagedAutoReviewCheck } from '../../../../../packages/maker-core/src/agents/shared/auto-review-decision.js';
import type { SessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { createApprovalRuleStore } from './approval-rule-store.js';
import type { ManagedBashDenyDeps } from './claude-hooks/managed-bash-deny-hook.js';

const eligible = (row: SessionRowSnapshot | null, harness: 'pi' | 'codex'): row is SessionRowSnapshot =>
  !!row && row.status === 'active' && row.source === 'desktop' && row.agentKind === harness
  && !row.remoteHostId && !row.agentDeviceId && !row.orcaRole && !row.orcaRemoteLead
  && typeof row.workingDir === 'string' && !!row.workingDir;
const rowIdentity = (row: SessionRowSnapshot) => ({
  status: row.status, source: row.source, agentKind: row.agentKind,
  remoteHostId: row.remoteHostId ?? null, agentDeviceId: row.agentDeviceId ?? null,
  orcaRole: row.orcaRole ?? null, orcaRemoteLead: row.orcaRemoteLead ?? null,
  workingDir: row.workingDir, workspaceKind: row.workspaceKind, clearedAt: row.clearedAt ?? null,
});

/** Only existing local root Pi Auto tools or native Codex Auto approvals reach these rules.
 * Native configuration, delegation and model review remain separate domains. */
export function createManagedAutoReviewPrecheck(deps: ManagedBashDenyDeps) {
  return async (request: AutoReviewRequest): Promise<ManagedAutoReviewCheck> => {
    const unavailable = (reason: string): ManagedAutoReviewCheck => ({ kind: 'unavailable', reason });
    const execution = request.managedToolExecution;
    const command = execution?.input?.command;
    const harness = request.agentKind;
    if ((harness !== 'pi' && harness !== 'codex') || !request.sessionId || !execution?.sessionInstanceId
      || execution.toolName !== (harness === 'pi' ? 'bash' : 'exec')
      || typeof command !== 'string' || !command.trim())
      return unavailable('managed-execution-unverified');
    const piCheck = harness === 'pi' ? checkPi : undefined;
    if (piCheck) return piCheck(request, deps);
    return checkCodex(request, deps);
  };
}

/** Qualified Pi root execution: authority survives storage failure, never vice versa. */
async function checkPi(request: AutoReviewRequest, deps: ManagedBashDenyDeps): Promise<ManagedAutoReviewCheck> {
  const unverified = (): ManagedAutoReviewCheck => ({ kind: 'unavailable', reason: 'managed-execution-unverified', pi: { state: 'unverified' } });
  const execution = request.managedToolExecution!;
  const input = execution.piExecution;
  try {
    if (!input || !input.rpcId || !input.isCurrent() || !isDeepStrictEqual(input.input, execution.input)) return unverified();
    const owner = deps.captureOwner();
    const matches = deps.listSessions().filter(session => session.id === request.sessionId);
    if (!owner || !deps.ownerCurrent(owner) || matches.length !== 1) return unverified();
    const session = matches[0]!;
    const permission = session.stablePermissionModeState, plan = session.stablePlanModeState;
    const workDir = session.workDir;
    const identity = () => input.isCurrent() && deps.ownerCurrent(owner)
      && deps.listSessions().filter(candidate => candidate.id === request.sessionId).length === 1
      && deps.listSessions().find(candidate => candidate.id === request.sessionId) === session
      && session.instanceId === execution.sessionInstanceId && session.agentKind === 'pi'
      && session.workDir === workDir && session.getStatus() === 'active'
      && !session.remoteHostId && !session.agentDeviceId && session.autoReviewOwner === 'cindy'
      && isDeepStrictEqual(session.stablePlanModeState, plan);
    if (!identity() || !permission || (input.isAuto() && permission.mode !== 'auto') || !plan || plan.enabled) return unverified();
    const row = await deps.readSessionRow(session.id);
    if (!identity() || !row) return unverified();
    if (!eligible(row, 'pi')) return { kind: 'unavailable', reason: 'managed-task-inapplicable', pi: { state: 'inapplicable' } };
    const rowKey = rowIdentity(row);
    const projectId = await fs.realpath(row.workingDir!);
    const stat = await fs.stat(projectId);
    if (!identity() || !stat.isDirectory() || projectId !== await fs.realpath(workDir)) return unverified();
    const executionCurrent = () => {
      try { const now = statSync(projectId); return identity() && now.isDirectory()
        && now.dev === stat.dev && now.ino === stat.ino && realpathSync(workDir) === projectId
        && realpathSync(row.workingDir!) === projectId; } catch { return false; }
    };
    if (!executionCurrent()) return unverified();
    // Mode/publication are personal-policy contributions, not execution identity.
    const contextKey = JSON.stringify([owner.ownerId, owner.generation, owner.executionHostId,
      session.id, execution.sessionInstanceId, projectId, String(stat.dev), String(stat.ino), rowKey, permission, plan, input.rpcId, input.input]);
    const withdrawn = async (): Promise<ManagedAutoReviewCheck> => {
      const latest = await deps.readSessionRow(session.id);
      if (!executionCurrent() || !eligible(latest, 'pi') || !isDeepStrictEqual(rowIdentity(latest), rowKey)
        || await fs.realpath(latest.workingDir!) !== projectId) return unverified();
      const finalRow = await deps.readSessionRow(session.id);
      if (!executionCurrent() || !eligible(finalRow, 'pi') || !isDeepStrictEqual(rowIdentity(finalRow), rowKey)) return unverified();
      return { kind: 'clear', contextKey, isCurrent: executionCurrent, isExecutionCurrent: executionCurrent };
    };
    if (!input.isAuto()) return await withdrawn();
    const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, projectId, harnesses: ['pi' as const] };
    const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir: owner.ownerDataDir,
      localManagedCommandHostId: owner.executionHostId,
      assertCurrent: () => { if (!executionCurrent()) throw new Error('Managed execution changed'); },
      resolveManagedConsumer: () => executionCurrent() ? { scope, sessionId: session.id, sessionInstanceId: session.instanceId } : null });
    // Seal the exact publication bytes as well as the marker across the final
    // promise continuation, including a corrupt artifact restored during a card.
    const publication = () => {
      try {
        const revision = store.getAppliedState().generatedRevision;
        let digest = '';
        if (revision !== undefined) {
          try { digest = createHash('sha256').update(readFileSync(path.join(owner.ownerDataDir,
            'command-approval-runtime', 'revisions', String(revision), 'snapshot.json'))).digest('hex'); }
          catch { digest = 'unreadable'; }
        }
        return JSON.stringify([revision, digest]);
      } catch { return 'publication-unavailable'; }
    };
    let published: Awaited<ReturnType<typeof store.readPublishedManagedSnapshot>> | { kind: 'unavailable'; reason: string };
    const beforeReadSeal = publication();
    try { published = await store.readPublishedManagedSnapshot(); }
    catch { published = { kind: 'unavailable', reason: 'managed-policy-unavailable' }; }
    const seal = publication();
    if (seal !== beforeReadSeal) return unverified();
    const latest = await deps.readSessionRow(session.id);
    if (!executionCurrent() || !eligible(latest, 'pi') || !isDeepStrictEqual(rowIdentity(latest), rowKey)
      || await fs.realpath(latest.workingDir!) !== projectId) return unverified();
    const finalRow = await deps.readSessionRow(session.id);
    if (!executionCurrent() || !eligible(finalRow, 'pi') || !isDeepStrictEqual(rowIdentity(finalRow), rowKey)
      || publication() !== seal) return unverified();
    if (!input.isAuto()) return { kind: 'clear', contextKey, isCurrent: executionCurrent, isExecutionCurrent: executionCurrent };
    if (!isDeepStrictEqual(session.stablePermissionModeState, permission)) return unverified();
    const lease = { contextKey,
      isExecutionCurrent: executionCurrent,
      isCurrent: () => executionCurrent() && isDeepStrictEqual(session.stablePermissionModeState, permission) && publication() === seal };
    if (published.kind === 'unavailable') return { kind: 'unavailable', reason: published.reason,
      pi: { state: 'storage-unavailable', lease } };
    const groups = published.kind === 'published-managed' ? published.groups.filter(group => requirementsKey(group) !== undefined
      || (group.origin.harness === 'cindy' && group.origin.layer === 'user' && group.origin.decisionDomain === 'personal-approval'
        && group.origin.sourceId.startsWith('exact-bash:') && group.clauses.length === 1
        && group.clauses[0]?.tool?.domain === 'exec' && group.clauses[0].tool.name === 'bash'
        && group.clauses[0].matcher?.kind === 'cc-command' && group.clauses[0].matcher.mode === 'exact'
        && group.clauses[0].matcher.pattern === execution.input.command)) : [];
    const revision = published.kind === 'published-managed' ? published.revision : undefined;
    const personalRequirements = { scope, groups, fingerprint: JSON.stringify([revision, groups]) };
    const match = evaluatePersonalRequirements(personalRequirements, execution.input.command as string, 'pi');
    if (match.status === 'matched' && (match.decision === 'deny' || (match.decision === 'ask' && !match.uncoveredRuleIds?.length)))
      return { ...lease, kind: match.decision, revision: revision!, ruleId: match.ruleIds[0]!,
        reason: match.decision === 'deny' ? 'Blocked by published Cindy personal rule ' + match.ruleIds[0] + '.' : 'A current personal rule requires confirmation.' };
    return { ...lease, kind: 'clear', revision, ...(groups.length ? { personalRequirements } : {}) };
  } catch { return unverified(); }
}

/** Only the actual local root command-approval callback can supply this lease. */
async function checkCodex(request: AutoReviewRequest, deps: ManagedBashDenyDeps): Promise<ManagedAutoReviewCheck> {
  const unverified = (): ManagedAutoReviewCheck => ({ kind: 'unavailable', reason: 'managed-execution-unverified', codex: { state: 'unverified' } });
  const execution = request.managedToolExecution!;
  const approval = execution.codexApproval;
  try {
    if (!approval || !approval.threadId || !approval.turnId || !approval.itemId || !approval.isCurrent()
      || typeof execution.input.cwd !== 'string' || !execution.input.cwd.trim()) return unverified();
    // Capture owner before the first await, independently of permission mode.
    const owner = deps.captureOwner();
    const matches = deps.listSessions().filter(session => session.id === request.sessionId);
    if (!owner || !deps.ownerCurrent(owner) || matches.length !== 1) return unverified();
    const session = matches[0]!;
    const workDir = session.workDir, plan = session.stablePlanModeState, permission = session.stablePermissionModeState;
    const actualInput = structuredClone(execution.input);
    const active = () => approval.isAuto?.() ?? true;
    const identity = () => approval.isCurrent() && isDeepStrictEqual(execution.input, actualInput) && deps.ownerCurrent(owner)
      && deps.listSessions().filter(candidate => candidate.id === request.sessionId).length === 1
      && deps.listSessions().find(candidate => candidate.id === request.sessionId) === session
      && session.instanceId === execution.sessionInstanceId && session.agentKind === 'codex'
      && session.workDir === workDir && session.getStatus() === 'active'
      && !session.remoteHostId && !session.agentDeviceId && session.autoReviewOwner === 'cindy'
      && isDeepStrictEqual(session.stablePlanModeState, plan);
    if (!identity() || !permission || (active() && permission.mode !== 'auto') || !plan || plan.enabled) return unverified();
    const row = await deps.readSessionRow(session.id);
    if (!identity() || !row) return unverified();
    if (!eligible(row, 'codex')) return unverified();
    const rowKey = rowIdentity(row);
    const projectId = await fs.realpath(row.workingDir!);
    const stat = await fs.stat(projectId);
    if (!identity() || !stat.isDirectory() || projectId !== await fs.realpath(workDir)
      || projectId !== await fs.realpath(actualInput.cwd as string)) return unverified();
    const executionCurrent = () => {
      try { const now = statSync(projectId); return identity() && now.isDirectory()
        && now.dev === stat.dev && now.ino === stat.ino && realpathSync(workDir) === projectId
        && realpathSync(row.workingDir!) === projectId && realpathSync(actualInput.cwd as string) === projectId; } catch { return false; }
    };
    if (!executionCurrent()) return unverified();
    const contextKey = JSON.stringify([owner.ownerId, owner.generation, owner.executionHostId,
      session.id, execution.sessionInstanceId, projectId, String(stat.dev), String(stat.ino), rowKey, plan,
      approval.threadId, approval.turnId, approval.itemId, approval.approvalId,
      approval.hostGeneration, approval.inputGeneration, approval.directoryGeneration, actualInput]);
    const rowsCurrent = async () => {
      const latest = await deps.readSessionRow(session.id);
      if (!executionCurrent() || !eligible(latest, 'codex') || !isDeepStrictEqual(rowIdentity(latest), rowKey)
        || await fs.realpath(latest.workingDir!) !== projectId) return false;
      const finalRow = await deps.readSessionRow(session.id);
      return executionCurrent() && eligible(finalRow, 'codex') && isDeepStrictEqual(rowIdentity(finalRow), rowKey);
    };
    if (!active()) return await rowsCurrent()
      ? { kind: 'clear', contextKey, isCurrent: executionCurrent, isExecutionCurrent: executionCurrent } : unverified();
    const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, projectId, harnesses: ['codex' as const] };
    const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir: owner.ownerDataDir,
      localManagedCommandHostId: owner.executionHostId,
      assertCurrent: () => { if (!executionCurrent()) throw new Error('Managed execution changed'); },
      resolveManagedConsumer: () => executionCurrent() ? { scope, sessionId: session.id, sessionInstanceId: session.instanceId } : null });
    const publication = () => {
      try {
        const revision = store.getAppliedState().generatedRevision;
        let digest = '';
        if (revision !== undefined) {
          try { digest = createHash('sha256').update(readFileSync(path.join(owner.ownerDataDir,
            'command-approval-runtime', 'revisions', String(revision), 'snapshot.json'))).digest('hex'); }
          catch { digest = 'unreadable'; }
        }
        return JSON.stringify([revision, digest]);
      } catch { return 'publication-unavailable'; }
    };
    const before = publication();
    let published: Awaited<ReturnType<typeof store.readPublishedManagedSnapshot>>;
    try { published = await store.readPublishedManagedSnapshot(); }
    catch { published = { kind: 'unavailable', reason: 'managed-policy-unavailable' }; }
    const seal = publication();
    if (before !== seal || !await rowsCurrent() || publication() !== seal) return unverified();
    if (!active()) return { kind: 'clear', contextKey, isCurrent: executionCurrent, isExecutionCurrent: executionCurrent };
    if (!isDeepStrictEqual(session.stablePermissionModeState, permission)) return unverified();
    const lease = { contextKey, isExecutionCurrent: executionCurrent,
      isCurrent: () => executionCurrent() && (!active()
        || (isDeepStrictEqual(session.stablePermissionModeState, permission) && publication() === seal)) };
    if (published.kind === 'unavailable') return { kind: 'unavailable', reason: published.reason, codex: { state: 'storage-unavailable', lease } };
    const groups = published.kind === 'published-managed' ? published.groups.filter(group =>
      requirementsKey(group) !== undefined || (group.origin.harness === 'cindy' && group.origin.layer === 'user'
        && group.origin.decisionDomain === 'personal-approval' && group.origin.sourceId.startsWith('exact-codex-command:')
        && group.clauses.length === 1 && group.clauses[0]?.tool?.domain === 'exec' && group.clauses[0].tool.name === 'exec'
        && group.clauses[0].matcher?.kind === 'cc-command' && group.clauses[0].matcher.mode === 'exact'
        && group.clauses[0].matcher.pattern === actualInput.command)) : [];
    const revision = published.kind === 'published-managed' ? published.revision : undefined;
    const personalRequirements = { scope, groups, fingerprint: JSON.stringify([revision, groups]) };
    const match = evaluatePersonalRequirements(personalRequirements, actualInput.command as string, 'codex');
    if (match.status === 'matched' && (match.decision === 'deny' || (match.decision === 'ask' && !match.uncoveredRuleIds?.length)))
      return { ...lease, kind: match.decision, revision: revision!, ruleId: match.ruleIds[0]!,
        reason: match.decision === 'deny' ? 'Blocked by published Cindy personal rule ' + match.ruleIds[0] + '.' : 'A current personal rule requires confirmation.' };
    return { ...lease, kind: 'clear', revision, ...(groups.length ? { personalRequirements } : {}) };
  } catch { return unverified(); }
}
