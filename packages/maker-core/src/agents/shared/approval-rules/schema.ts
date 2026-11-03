import { requirementsKey, requirementsNamespace, validRequirementsKey } from './requirements.js';
import { isSupportedManagedCommand } from './evaluate.js';
import type { ApprovalRuleSnapshot, ManagedRuleOverride, RuleClause, RuleMatcher, UnifiedRule } from './types.js';

const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fail = (): never => { throw new Error('Invalid command approval rule snapshot'); };
function validMatcher(value: unknown): value is RuleMatcher {
  if (!row(value)) return false;
  if (value.kind === 'cc-command')
    return str(value.pattern) && ['exact', 'prefix', 'glob'].includes(String(value.mode));
  return value.kind === 'argv-prefix' && Array.isArray(value.tokens) && value.tokens.length > 0
    && value.tokens.every(token => str(token) ||
      (Array.isArray(token) && token.length > 0 && token.every(str)));
}
function validClause(value: unknown): value is RuleClause {
  if (row(value) && value.decision === 'requirement') return str(value.id) && str(value.original)
    && !!value.original.trim() && value.reason === 'user-authored-verbatim'
    && Object.keys(value).every(key => ['id', 'original', 'decision', 'reason', 'tool'].includes(key))
    && row(value.tool) && value.tool.domain === 'exec' && (value.tool.name === undefined || ['Bash', 'bash', 'exec'].includes(String(value.tool.name)))
    && Object.keys(value.tool).every(key => ['domain', 'name'].includes(key));
  return row(value) && str(value.id) && str(value.original)
    && ['allow', 'ask', 'deny'].includes(String(value.decision))
    && (value.matcher === undefined ? str(value.reason) : validMatcher(value.matcher))
    && (value.justification === undefined || typeof value.justification === 'string')
    && (value.autoAskExceptions === undefined || (value.decision === 'allow'
      && row(value.matcher) && value.matcher.kind === 'cc-command' && value.matcher.mode === 'exact'
      && row(value.tool) && value.tool.domain === 'exec' && value.tool.name === 'Bash'
      && Array.isArray(value.autoAskExceptions) && value.autoAskExceptions.every(entry =>
        row(entry) && str(entry.sourceGroupId) && str(entry.clauseId) && str(entry.original)
        && row(entry.scope) && str(entry.scope.projectId)
        && validGroup({ id: 'execution', revision: 0, scope: entry.scope, origin: entry.sourceOrigin,
          clauses: [], updatedBy: 'remember' }, 0)
        && row(entry.sourceOrigin) && entry.sourceOrigin.harness === 'claude-code'
        && entry.sourceOrigin.decisionDomain === 'personal-approval'
        && validGroup({ id: entry.sourceGroupId, revision: 0, scope: entry.sourceScope,
          origin: entry.sourceOrigin, clauses: [], updatedBy: 'remember' }, 0))));
}
function validGroup(value: unknown, ceiling: number): value is UnifiedRule {
  if (!row(value) || !str(value.id) || !revision(value.revision) || value.revision > ceiling
    || !str(value.updatedBy) || !row(value.scope) || !row(value.origin)
    || !Array.isArray(value.clauses)) return false;
  const scope = value.scope, origin = value.origin;
  if (!str(scope.ownerId) || !str(scope.executionHostId)
    || (scope.projectId !== undefined && !str(scope.projectId))
    || !Array.isArray(scope.harnesses) || scope.harnesses.length === 0
    || scope.harnesses.some(h => !['claude-code', 'codex', 'pi'].includes(String(h)))
    || new Set(scope.harnesses).size !== scope.harnesses.length
    || !['claude-code', 'codex', 'cindy'].includes(String(origin.harness))
    || !['user', 'project', 'local'].includes(String(origin.layer))
    || !str(origin.sourceId) || !str(origin.locator) || !str(origin.dialectVersion)
    || (origin.decisionDomain !== undefined && !['personal-approval', 'sandbox-escalation', 'unknown'].includes(String(origin.decisionDomain))))
    return false;
  const harnesses = scope.harnesses;
  if (!value.clauses.every(validClause)) return false;
  const group = value as UnifiedRule;
  const neutral = group.clauses.some(clause => clause.decision === 'requirement');
  if (neutral || requirementsNamespace(group.origin)) {
    const harness = group.scope.harnesses?.[0];
    const tool = group.scope.harnesses?.length !== 1 ? undefined : harness === 'pi' ? 'bash' : harness === 'codex' ? 'exec' : 'Bash';
    if (group.clauses[0]?.tool?.name !== tool || !requirementsKey(group) || group.clauses[0]?.decision !== 'requirement'
      || group.clauses[0].id !== 'requirement' || group.clauses.length > 17) return false;
    if (!group.clauses.slice(1).every(clause => clause.decision !== 'requirement'
      && ['allow', 'ask', 'deny'].includes(clause.decision)
      && validRequirementsKey(clause.id) && clause.id !== 'requirement' && !!clause.original.trim()
      && clause.tool?.domain === 'exec' && clause.tool.name === tool
      && clause.matcher?.kind === 'cc-command' && clause.matcher.mode === 'exact'
      && group.scope.harnesses!.every(target => clause.matcher?.kind === 'cc-command' && isSupportedManagedCommand(clause.matcher.pattern, target))
      && Object.keys(clause).every(key => ['id', 'original', 'decision', 'matcher', 'tool'].includes(key)))) return false;
  }
  return value.clauses.every(validClause)
    && value.clauses.every(clause => !row(clause) || clause.autoAskExceptions === undefined
      || (origin.harness === 'cindy' && origin.layer === 'user' && origin.decisionDomain === 'personal-approval'
        && harnesses.length === 1 && harnesses[0] === 'claude-code'))
    && new Set(value.clauses.map(clause => (clause as RuleClause).id)).size === value.clauses.length;
}
function validOverride(value: unknown, ceiling: number): value is ManagedRuleOverride {
  if (!row(value) || !str(value.id) || !revision(value.revision) || value.revision > ceiling
    || !row(value.scope) || !str(value.scope.ownerId) || !str(value.scope.executionHostId)
    || (value.scope.projectId !== undefined && !str(value.scope.projectId))
    || !Array.isArray(value.scope.harnesses) || !value.scope.harnesses.length
    || value.scope.harnesses.some(h => !['claude-code', 'codex', 'pi'].includes(String(h)))
    || new Set(value.scope.harnesses).size !== value.scope.harnesses.length
    || (value.replacesSourceId !== undefined && !str(value.replacesSourceId))) return false;
  return value.baseline === undefined || validGroup(value.baseline, ceiling);
}

/** Bad persisted content is never recovered as an empty allow-all snapshot. */
export function parseApprovalRuleSnapshot(value: unknown): ApprovalRuleSnapshot {
  if (!row(value) || value.schemaVersion !== 1 || !revision(value.revision)
    || !Array.isArray(value.groups) || !Array.isArray(value.tombstones)) return fail();
  if (!value.groups.every(group => validGroup(group, value.revision as number))) return fail();
  if (value.managedOverrides !== undefined && (!Array.isArray(value.managedOverrides)
    || !value.managedOverrides.every(entry => validOverride(entry, value.revision as number))
    || new Set(value.managedOverrides.map(entry => (entry as ManagedRuleOverride).id)).size !== value.managedOverrides.length))
    return fail();
  const ids = new Set<string>();
  for (const group of value.groups as UnifiedRule[]) {
    if (ids.has(group.id)) return fail();
    ids.add(group.id);
  }
  for (const tombstone of value.tombstones) {
    if (!row(tombstone) || !str(tombstone.id) || !revision(tombstone.revision)
      || tombstone.revision > value.revision || ids.has(tombstone.id)) return fail();
    ids.add(tombstone.id);
  }
  return structuredClone(value) as ApprovalRuleSnapshot;
}
export function emptyApprovalRuleSnapshot(): ApprovalRuleSnapshot {
  return { schemaVersion: 1, revision: 0, groups: [], tombstones: [] };
}
export function freezeApprovalRuleSnapshot(snapshot: ApprovalRuleSnapshot): Readonly<ApprovalRuleSnapshot> {
  const copy = parseApprovalRuleSnapshot(snapshot);
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}
