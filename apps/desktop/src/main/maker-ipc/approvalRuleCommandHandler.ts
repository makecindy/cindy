import type { PersonalRuleStatus } from '@cindy/mcps';
import { requirementsKey } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';
import { parseRequirements, writeRequirements, type RequirementsInput } from './approvalRuleWriteService.js';
import fs from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import type { AutoCommandConfirmation } from '../../../../../packages/maker-core/src/types/events.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isSupportedManagedCommand } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/evaluate.js';
import { normalizeRuleGroup } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize.js';
import { parseApprovalRuleSnapshot } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/schema.js';
import type { RuleHarness, RuleScope } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/types.js';
import { isApprovalRuleCommand, type ApprovalRuleCommandResult } from '../../shared/approvalRuleCommand.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type { SessionRowSnapshot } from '../localDb/ipc/sessions.js';
import type { createApprovalRuleStore } from '../maker-host/approval-rule-store.js';
import { ApprovalRuleHostIdentityConflict } from '../maker-host/approval-rule-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

type Owner = { ownerId: string; executionHostId: string; generation: string; dbClient: object };
type Store = ReturnType<typeof createApprovalRuleStore>;

export interface ApprovalRuleCommandDeps {
  assertTrustedSender(event: unknown): void;
  isDeviceLinkInvoke(): boolean;
  captureOwner(): Owner | null;
  ownerCurrent(owner: Owner): boolean;
  getInputGeneration(sessionId: string): number;
  readSession(sessionId: string): Promise<SessionRowSnapshot | null>;
  isProvisional(sessionId: string): boolean;
  consumerState?(sessionId: string): { instanceId: string; harness: RuleHarness; active: boolean;
    local: boolean; mode?: string; plan?: boolean; reviewOwner?: string; personalRuleConsumerReady?: boolean } | undefined;
  withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  createStore(owner: Owner, assertCurrent: () => void,
    consumer?: { scope: RuleScope; sessionId: string; sessionInstanceId: string }): Store;
}

const eligible = (row: SessionRowSnapshot | null): row is SessionRowSnapshot =>
  !!row && row.status === 'active' && row.source === 'desktop' && (row.agentKind === 'cc' || row.agentKind === 'pi' || row.agentKind === 'codex')
  && !row.remoteHostId && !row.agentDeviceId && !row.orcaRole && !row.orcaRemoteLead
  && typeof row.workingDir === 'string' && !!row.workingDir;

const identity = (row: SessionRowSnapshot) => ({
  status: row.status, source: row.source, agentKind: row.agentKind,
  remoteHostId: row.remoteHostId ?? null, agentDeviceId: row.agentDeviceId ?? null,
  orcaRole: row.orcaRole ?? null, orcaRemoteLead: row.orcaRemoteLead ?? null,
  workingDir: row.workingDir, workspaceKind: row.workspaceKind,
  clearedAt: row.clearedAt ?? null,
});

type ExplicitTarget = { harness: RuleHarness; command: string };
type EditKind = 'allow' | 'ask' | 'deny' | 'remove';
// Flat JSON string pairs only. Decode each key before duplicate detection;
// JSON.parse on the entire object would silently discard earlier targets.
function parseTargets(text: string): ExplicitTarget[] | null {
  let at = 0;
  const targets: ExplicitTarget[] = [];
  const seen = new Set<string>();
  const whitespace = () => { while (at < text.length && /[ \t]/.test(text[at]!)) at++; };
  const string = (): string | null => {
    whitespace();
    const start = at;
    if (text[at++] !== '"') return null;
    while (at < text.length) {
      const character = text[at++];
      if (character === '\\') { at++; continue; }
      if (character === '"') {
        try { const value: unknown = JSON.parse(text.slice(start, at));
          return typeof value === 'string' ? value : null; } catch { return null; }
      }
    }
    return null;
  };
  whitespace();
  if (text[at++] !== '{') return null;
  for (;;) {
    const key = string();
    if ((key !== 'claude-code' && key !== 'pi' && key !== 'codex') || seen.has(key)) return null;
    whitespace(); if (text[at++] !== ':') return null;
    const command = string();
    if (!command?.trim()) return null;
    seen.add(key); targets.push({ harness: key, command });
    whitespace();
    if (text[at] === '}') { at++; break; }
    if (text[at++] !== ',') return null;
  }
  whitespace();
  return at === text.length ? targets.sort((a, b) => a.harness.localeCompare(b.harness)) : null;
}

function parse(text: string): { kind: 'publish' }
  | { kind: 'set' | 'remove'; requirements: RequirementsInput; scope: 'user' | 'project' }
  | { kind: EditKind; command: string; scope: 'user' | 'project'; harness?: RuleHarness }
  | { kind: EditKind; targets: ExplicitTarget[]; scope: 'user' | 'project' } | null {
  if (text !== text.trim() || text.includes('\n') || text.includes('\r') || text.length > 2048) return null;
  if (text === '/approval-rule publish') return { kind: 'publish' };
  const requirements = /^\/approval-rule (set|remove) (user|project) --requirements ([\s\S]+)$/.exec(text);
  if (requirements) {
    const input = parseRequirements(requirements[3]!, requirements[1] === 'remove');
    return input ? { kind: requirements[1] as 'set' | 'remove', scope: requirements[2] as 'user' | 'project', requirements: input } : null;
  }
  const batch = /^\/approval-rule (allow|ask|deny|remove) (user|project) --targets (.+)$/.exec(text);
  if (batch) {
    const targets = parseTargets(batch[3]!);
    return targets ? { kind: batch[1] as EditKind, scope: batch[2] as 'user' | 'project', targets } : null;
  }
  const match = /^\/approval-rule (allow|ask|deny|remove) (user|project)(?: --harness (claude-code|codex|pi))? -- (.+)$/.exec(text);
  return match ? { kind: match[1] as 'allow' | 'ask' | 'deny' | 'remove', scope: match[2] as 'user' | 'project',
    command: match[4]!, ...(match[3] ? { harness: match[3] as RuleHarness } : {}) } : null;
}

/** One direct user-composer request. No Agent, MCP or remote caller can use this path. */
export function registerApprovalRuleCommandHandler(registry: IpcHandlerRegistry, deps: ApprovalRuleCommandDeps): void {
  registry.handle(MAKER_INVOKE.APPROVAL_RULE_COMMAND, async (event, raw: unknown): Promise<ApprovalRuleCommandResult> => {
    if (deps.isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'Local composer required');
    deps.assertTrustedSender(event);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throwIpcError('INVALID_PARAMS', 'Approval command request required');
    const request = raw as Record<string, unknown>;
    if (typeof request.sessionId !== 'string' || !request.sessionId || request.sessionId.length > 128
      || typeof request.text !== 'string' || !isApprovalRuleCommand(request.text))
      throwIpcError('INVALID_PARAMS', 'Invalid approval command request');
    if (request.text === '/approval-rule status') return { kind: 'status', statuses: await readPersonalRuleStatus(deps, request.sessionId) };
    const parsed = parse(request.text);
    if (!parsed) return { kind: 'unsupported', reason: 'syntax' };
    const owner = deps.captureOwner();
    if (!owner || !owner.ownerId || !owner.executionHostId) return { kind: 'unsupported', reason: 'context' };
    const sessionId = request.sessionId;
    const generation = deps.getInputGeneration(sessionId);
    let directoryCurrent = () => true;
    const current = () => deps.ownerCurrent(owner) && deps.getInputGeneration(sessionId) === generation
      && !deps.isProvisional(sessionId) && directoryCurrent();
    if (!current()) return { kind: 'unsupported', reason: 'context' };
    try { return await deps.withSessionLock(sessionId, async () => {
      const row = await deps.readSession(sessionId);
      if (!current() || !eligible(row)) return { kind: 'unsupported', reason: 'context' };
      const capturedRow = identity(row);
      const taskHarness = row.agentKind === 'pi' ? 'pi' : row.agentKind === 'codex' ? 'codex' : 'claude-code';
      const targets: ExplicitTarget[] = 'requirements' in parsed ? parsed.requirements.targets.map(harness => ({ harness, command: '' })) : parsed.kind === 'publish' ? [{ harness: taskHarness, command: '' }]
        : 'targets' in parsed ? parsed.targets : (parsed.harness ? [parsed.harness] : ['claude-code', 'codex', 'pi'] as const).map(harness => ({ harness, command: parsed.command }));
      if (parsed.kind !== 'publish' && !('requirements' in parsed) && targets.some(target => !isSupportedManagedCommand(target.command, target.harness)))
        return { kind: 'unsupported', reason: 'command' };
      let projectId: string | undefined;
      if (parsed.kind !== 'publish' && (parsed.scope === 'project' || 'requirements' in parsed)) {
        const cwd = await fs.realpath(row.workingDir!), stat = await fs.stat(cwd);
        if (parsed.scope === 'project') projectId = cwd;
        if (!current() || !stat.isDirectory()) return { kind: 'unsupported', reason: 'context' };
        directoryCurrent = () => {
          try { const now = statSync(cwd); return realpathSync.native(row.workingDir!) === cwd
            && now.isDirectory() && now.dev === stat.dev && now.ino === stat.ino; } catch { return false; }
        };
      }
      const verify = async () => {
        if (!current()) throwIpcError('PRECONDITION_FAILED', 'Approval command context changed');
        const latest = await deps.readSession(sessionId);
        if (!current() || !eligible(latest) || !isDeepStrictEqual(identity(latest), capturedRow))
          throwIpcError('PRECONDITION_FAILED', 'Approval command context changed');
      };
      const assertCurrent = () => {
        if (!current()) throwIpcError('PRECONDITION_FAILED', 'Approval command context changed');
      };
      const store = deps.createStore(owner, assertCurrent);
      const scope: RuleScope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId,
        harnesses: targets.map(target => target.harness), ...(projectId ? { projectId } : {}) };
      await verify();
      const snapshot = await store.readSnapshot(scope);
      await verify();
      const clientId = randomUUID();
      if (parsed.kind === 'publish') {
        const published = await store.publish(snapshot.revision, verify);
        assertCurrent();
        return { kind: 'published', revision: published.generatedRevision!, clientId };
      }
      if ('requirements' in parsed) {
        const saved = await writeRequirements(store, snapshot.revision, scope, parsed.requirements, parsed.kind === 'remove', verify);
        assertCurrent();
        return { kind: 'saved', ...saved, clientId };
      }
      const groups = targets.map(target => managedCommandGroup(target.harness, target.command,
          parsed.kind === 'remove' ? 'deny' : parsed.kind, { ...scope, harnesses: [target.harness] }));
      const saved = await store.applyManagedEdit(snapshot.revision, scope, parsed.kind === 'remove' ? [] : groups,
        parsed.kind === 'remove' ? groups.map(group => group.id) : [], verify, true, 'targets' in parsed || targets.length > 1);
      assertCurrent();
      return { kind: 'saved', revision: saved.revision, ruleId: groups[0]!.id,
        ...(targets.length > 1 ? { ruleIds: groups.map(group => group.id) } : {}), clientId };
    }); } catch (error) {
      if (error instanceof ApprovalRuleHostIdentityConflict)
        return { kind: 'error', code: error.code };
      if (isIpcError(error)) throw error;
      throwIpcError('INTERNAL', 'Approval rule operation failed');
    }
  });
}

/** Same IDs and exact scope as direct /approval-rule edits, including remove. */
function managedCommandGroup(targetHarness: 'claude-code' | 'pi' | 'codex', command: string,
  decision: 'allow' | 'ask' | 'deny', scope: RuleScope) {
      const digest = createHash('sha256').update(targetHarness === 'claude-code' ? command : targetHarness + ':' + command).digest('hex');
      const domain = targetHarness === 'codex' ? 'exact-codex-command' : 'exact-bash';
      const origin = { harness: 'cindy' as const, sourceId: domain + ':' + digest,
        locator: 'cindy://personal-approval/' + domain + '/' + digest,
        dialectVersion: '1', layer: 'user' as const, decisionDomain: 'personal-approval' as const };
      return normalizeRuleGroup(origin, scope, [{ id: digest, original: (targetHarness === 'codex' ? 'exec(' : 'Bash(') + command + ')',
        decision: decision, matcher: { kind: 'cc-command', pattern: command, mode: 'exact' },
        tool: { domain: 'exec', name: targetHarness === 'pi' ? 'bash' : targetHarness === 'codex' ? 'exec' : 'Bash' } }]);
}

/** Capture before displaying a local card. Renderer supplies only intent, never a command identity. */
export async function captureRememberedAutoCommand(deps: ApprovalRuleCommandDeps,
  sessionId: string, evidence: AutoCommandConfirmation, pendingCurrent: () => boolean,
  instanceId: string) {
  const owner = deps.captureOwner();
  if (!owner || !instanceId || evidence.sessionInstanceId !== instanceId || evidence.command.length > 2000
    || !isSupportedManagedCommand(evidence.command, evidence.harness)) return null;
  const inputGeneration = deps.getInputGeneration(sessionId);
  let directoryCurrent = () => true;
  const current = () => deps.ownerCurrent(owner) && pendingCurrent() && evidence.isCurrent()
    && deps.getInputGeneration(sessionId) === inputGeneration && !deps.isProvisional(sessionId) && directoryCurrent();
  if (!current()) return null;
  const row = await deps.readSession(sessionId);
  if (!current() || !eligible(row)
    || (row.agentKind === 'cc' ? 'claude-code' : row.agentKind) !== evidence.harness) return null;
  const capturedRow = identity(row);
  const cwd = await fs.realpath(row.workingDir!);
  const stat = await fs.stat(cwd);
  if (!current() || !stat.isDirectory() || await fs.realpath(evidence.cwd) !== cwd) return null;
  directoryCurrent = () => {
    try {
      const now = statSync(cwd);
      return realpathSync.native(evidence.cwd) === cwd && now.isDirectory() && now.dev === stat.dev && now.ino === stat.ino;
    } catch { return false; }
  };
  let scope: RuleScope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId,
    harnesses: [evidence.harness] };
  let group = managedCommandGroup(evidence.harness, evidence.command, 'allow', scope);
  if (evidence.autoAskExceptions?.length) {
    if (evidence.harness !== 'claude-code' || evidence.autoAskExceptions.some(exception =>
      exception.scope.ownerId !== owner.ownerId || exception.scope.executionHostId !== owner.executionHostId
      || exception.scope.projectId !== cwd || exception.scope.harnesses?.length !== 1
      || exception.scope.harnesses[0] !== 'claude-code'
      || exception.sourceScope.ownerId !== owner.ownerId || exception.sourceScope.executionHostId !== owner.executionHostId
      || (exception.sourceScope.projectId !== undefined && exception.sourceScope.projectId !== cwd))) return null;
    group.clauses[0]!.autoAskExceptions = structuredClone(evidence.autoAskExceptions);
    parseApprovalRuleSnapshot({ schemaVersion: 1, revision: 1, groups: [group], tombstones: [] });
  }
  const store = deps.createStore(owner, () => {
    if (!current()) throw new Error('Remembered command context changed');
  });
  // Native content remains content-only; only inspect the already-active managed projection.
  const projection = deps.createStore(owner, () => {
    if (!current()) throw new Error('Remembered command context changed');
  }, { scope: { ...scope, projectId: cwd }, sessionId, sessionInstanceId: instanceId });
  const activeTarget = async () => {
    const active = await projection.readPublishedManagedSnapshot();
    if (active.kind === 'unavailable') throw new Error('Personal rule state unavailable');
    return active.kind === 'published-managed' ? active.groups.filter(candidate => candidate.id === group.id
      || candidate.clauses.some(clause => clause.matcher?.kind === 'cc-command'
        && clause.matcher.mode === 'exact' && clause.matcher.pattern === evidence.command))
      .sort((left, right) => left.id.localeCompare(right.id)) : [];
  };
  const baseline = await activeTarget();
  const projectScope = { ...scope, projectId: cwd };
  const projectGroup = normalizeRuleGroup(group.origin, projectScope, group.clauses);
  if (baseline.some(candidate => candidate.id === projectGroup.id)) {
    scope = projectScope; group = projectGroup;
  }
  const verify = async () => {
    if (!current()) throw new Error('Remembered command context changed');
    const latest = await deps.readSession(sessionId);
    const directory = await fs.stat(cwd);
    if (!current() || !eligible(latest) || !isDeepStrictEqual(identity(latest), capturedRow)
      || await fs.realpath(latest.workingDir!) !== cwd || directory.dev !== stat.dev || directory.ino !== stat.ino
      || !isDeepStrictEqual(await activeTarget(), baseline) || !current())
      throw new Error('Remembered command or rule changed');
  };
  await verify();
  return { harness: evidence.harness, command: evidence.command, ...(scope.projectId ? { projectId: scope.projectId } : {}),
    async save(updatedInput?: Record<string, unknown>) {
      // An edited action must first reach its own real confirmation. Never persist the previous command.
      if (updatedInput && updatedInput.command !== evidence.command)
        throw new Error('Edited command requires its own confirmation before remembering');
      await verify();
      return deps.withSessionLock(sessionId, async () => {
        await verify();
        const snapshot = await store.readSnapshot(scope);
        await verify();
        return store.applyManagedEdit(snapshot.revision, scope, [group], [], verify, true);
      });
    } };
}

/** Owner-scoped read only. Availability is not an assertion that a command ran. */
export async function readPersonalRuleStatus(deps: ApprovalRuleCommandDeps, sessionId: string): Promise<PersonalRuleStatus[]> {
  const owner = deps.captureOwner(), generation = deps.getInputGeneration(sessionId);
  const runtime = deps.consumerState?.(sessionId);
  const current = () => !!owner && deps.ownerCurrent(owner) && deps.getInputGeneration(sessionId) === generation
    && !deps.isProvisional(sessionId) && isDeepStrictEqual(deps.consumerState?.(sessionId), runtime);
  if (!current() || !owner) throwIpcError('PRECONDITION_FAILED', 'Personal rule context changed');
  const row = await deps.readSession(sessionId);
  if (!current() || !eligible(row)) throwIpcError('PERMISSION_DENIED', 'Local root task required');
  const captured = identity(row), directory = await fs.realpath(row.workingDir!), directoryStat = await fs.stat(directory);
  if (!current() || !directoryStat.isDirectory()) throwIpcError('PRECONDITION_FAILED', 'Personal rule directory changed');
  const states: PersonalRuleStatus[] = [];
  const store = deps.createStore(owner, () => { if (!current()) throw new Error('Personal rule context changed'); });
  for (const harness of ['claude-code', 'codex', 'pi'] as const) {
    let savedRules = 0, consumableRules = 0, failed = false, pending = false;
    try {
      const view = store.readManagedStatusSnapshot({ ownerId: owner.ownerId, executionHostId: owner.executionHostId,
        harnesses: [harness], projectId: directory });
      if (view.kind === 'unavailable') failed = true;
      if (view.kind === 'published-managed') {
        savedRules = view.savedGroups.length; pending = view.pending;
        consumableRules = view.groups.filter(group => requirementsKey(group) !== undefined || (
          group.origin.layer === 'user' && group.origin.decisionDomain === 'personal-approval' && group.clauses.length === 1
          && group.origin.sourceId.startsWith(harness === 'codex' ? 'exact-codex-command:' : 'exact-bash:')
          && group.clauses[0]?.tool?.domain === 'exec'
          && group.clauses[0].tool.name === ({ 'claude-code': 'Bash', codex: 'exec', pi: 'bash' }[harness])
          && group.clauses[0].matcher?.kind === 'cc-command' && group.clauses[0].matcher.mode === 'exact'
          && isSupportedManagedCommand(group.clauses[0].matcher.pattern, harness))).length;
      }
    } catch { failed = true; }
    const reason: PersonalRuleStatus['reason'] = failed ? 'storage-unavailable' : pending ? 'pending-activation' : !savedRules ? 'no-rules'
      : consumableRules !== savedRules ? 'unsupported-rules' : !runtime ? 'runtime-unverified'
      : runtime.harness !== harness || !runtime.active ? 'no-current-task'
      : !runtime.local || !runtime.instanceId ? 'runtime-unverified' : runtime.plan ? 'plan-mode'
      : runtime.mode !== 'auto' ? 'auto-required' : runtime.reviewOwner !== 'cindy' ? 'native-owned'
      : harness === 'pi' && runtime.personalRuleConsumerReady !== true ? 'runtime-unverified' : 'ready';
    states.push({ harness, savedRules, consumableRules, state: reason === 'ready' ? 'available' : 'not-effective',
      reason, nativeQualification: 'unverified' });
  }
  const latest = await deps.readSession(sessionId), latestPath = await fs.realpath(row.workingDir!), latestStat = await fs.stat(latestPath);
  if (!current() || !eligible(latest) || !isDeepStrictEqual(identity(latest), captured)
    || latestPath !== directory || latestStat.dev !== directoryStat.dev || latestStat.ino !== directoryStat.ino)
    throwIpcError('PRECONDITION_FAILED', 'Personal rule context changed');
  return states;
}
