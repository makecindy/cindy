import { isDeepStrictEqual } from 'node:util';
import type { HookCallback, HookCallbackMatcher, HookEvent, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { literalCommandArgv } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/evaluate.js';
import { requirementsKey } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';
import { createApprovalRuleStore } from '../approval-rule-store.js';
import type { SessionRowSnapshot } from '../../localDb/ipc/sessions.js';

export type ManagedBashOwner = {
  ownerId: string;
  executionHostId: string;
  generation: string;
  dbClient: object;
  ownerDataDir: string;
};

export type ManagedBashSession = {
  id: string;
  instanceId: string;
  requestSessionId: string;
  agentKind: string;
  workDir: string;
  remoteHostId: string | null;
  agentDeviceId: string | null;
  autoReviewOwner: 'native' | 'cindy';
  stablePermissionModeState: { mode: string | null; generation: number } | null;
  stablePlanModeState: { enabled: boolean; generation: number } | null;
  getStatus(): string;
};

export type ManagedBashDenyDeps = {
  captureOwner(): ManagedBashOwner | null;
  ownerCurrent(owner: ManagedBashOwner): boolean;
  listSessions(): ManagedBashSession[];
  readSessionRow(sessionId: string): Promise<SessionRowSnapshot | null>;
  canonicalWorkDir(workDir: string): Promise<string>;
};

const rowEligible = (row: SessionRowSnapshot | null): row is SessionRowSnapshot =>
  !!row && row.status === 'active' && row.source === 'desktop' && row.agentKind === 'cc'
  && !row.remoteHostId && !row.agentDeviceId && !row.orcaRole && !row.orcaRemoteLead
  && typeof row.workingDir === 'string' && !!row.workingDir;

const rowIdentity = (row: SessionRowSnapshot) => ({
  status: row.status, source: row.source, agentKind: row.agentKind,
  remoteHostId: row.remoteHostId ?? null, agentDeviceId: row.agentDeviceId ?? null,
  orcaRole: row.orcaRole ?? null, orcaRemoteLead: row.orcaRemoteLead ?? null,
  workingDir: row.workingDir, workspaceKind: row.workspaceKind,
  clearedAt: row.clearedAt ?? null,
});

/** Additive, local-only deny hook; all other calls retain Claude's native Auto route. */
export function createManagedBashDenyHooks(
  deps: ManagedBashDenyDeps,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const preToolUse: HookCallback = async input => {
    const unchanged = { continue: true as const };
    if (input.hook_event_name !== 'PreToolUse') return unchanged;
    const pre = input as PreToolUseHookInput & { agent_id?: string; agent_type?: string };
    if (pre.tool_name !== 'Bash' || pre.agent_id != null || pre.agent_type != null) return unchanged;
    const command = (pre.tool_input as Record<string, unknown> | undefined)?.command;
    if (typeof command !== 'string' || !literalCommandArgv(command)) return unchanged;
    try {
      const owner = deps.captureOwner();
      if (!owner || !owner.ownerId || !owner.executionHostId || !owner.ownerDataDir
        || !deps.ownerCurrent(owner)) return unchanged;
      const matches = deps.listSessions().filter(session => session.requestSessionId === pre.session_id);
      if (matches.length !== 1) return unchanged;
      const session = matches[0]!;
      const permission = session.stablePermissionModeState;
      const plan = session.stablePlanModeState;
      const reviewOwner = session.autoReviewOwner;
      if (!permission || permission.mode !== 'auto' || !plan || plan.enabled
        || (reviewOwner !== 'native' && reviewOwner !== 'cindy') || session.agentKind !== 'claude-code'
        || session.remoteHostId || session.agentDeviceId || session.getStatus() !== 'active') return unchanged;
      const instanceId = session.instanceId;
      const current = () => {
        const currentMatches = deps.listSessions().filter(candidate => candidate.requestSessionId === pre.session_id);
        return deps.ownerCurrent(owner) && currentMatches.length === 1
          && currentMatches[0] === session && session.instanceId === instanceId
          && session.requestSessionId === pre.session_id && session.getStatus() === 'active'
          && session.agentKind === 'claude-code' && !session.remoteHostId && !session.agentDeviceId
          && isDeepStrictEqual(session.stablePermissionModeState, permission)
          && isDeepStrictEqual(session.stablePlanModeState, plan)
          && session.autoReviewOwner === reviewOwner;
      };
      const row = await deps.readSessionRow(session.id);
      if (!current() || !rowEligible(row)) return unchanged;
      const capturedRow = rowIdentity(row);
      const projectId = await deps.canonicalWorkDir(row.workingDir!);
      if (!current() || !projectId || projectId !== await deps.canonicalWorkDir(session.workDir)) return unchanged;
      if (!current()) return unchanged;
      const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId,
        projectId, harnesses: ['claude-code'] as ['claude-code'] };
      const store = createApprovalRuleStore({
        ownerId: owner.ownerId, ownerDataDir: owner.ownerDataDir,
        localManagedCommandHostId: owner.executionHostId,
        assertCurrent: () => { if (!current()) throw new Error('Approval hook context changed'); },
        resolveManagedConsumer: () => current() ? { scope, sessionId: session.id,
          sessionInstanceId: instanceId } : null,
      });
      const published = await store.readPublishedManagedSnapshot();
      if (!current() || published.kind !== 'published-managed') return unchanged;
      const latest = await deps.readSessionRow(session.id);
      if (!current() || !rowEligible(latest) || !isDeepStrictEqual(rowIdentity(latest), capturedRow)
        || await deps.canonicalWorkDir(latest.workingDir!) !== projectId) return unchanged;
      const finalRow = await deps.readSessionRow(session.id);
      if (!current() || !rowEligible(finalRow)
        || !isDeepStrictEqual(rowIdentity(finalRow), capturedRow)) return unchanged;
      if (!current() || store.getAppliedState().generatedRevision !== published.revision) return unchanged;
      const denies = published.groups.some(group => {
        return group.origin.harness === 'cindy'
          && group.origin.layer === 'user' && group.origin.decisionDomain === 'personal-approval'
          && (group.scope.projectId === undefined || group.scope.projectId === projectId)
          // The store schema validates every published group. Only the stable
          // requirements namespace extends the existing single-exact domain.
          && (group.clauses.length === 1 || requirementsKey(group) !== undefined)
          && group.clauses.some(clause => clause.decision === 'deny'
            && clause.tool?.domain === 'exec' && (clause.tool.name === 'Bash'
              || (clause.tool.name === undefined && requirementsKey(group) !== undefined))
            && clause.matcher?.kind === 'cc-command' && clause.matcher.mode === 'exact'
            && clause.matcher.pattern === command);
      });
      if (!denies || !current()) return unchanged;
      return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'Blocked by a published Cindy personal rule.' } };
    } catch {
      // An unavailable managed projection leaves Claude's existing native Auto decision intact.
      return unchanged;
    }
  };
  return { PreToolUse: [{ matcher: 'Bash', hooks: [preToolUse] }] };
}
