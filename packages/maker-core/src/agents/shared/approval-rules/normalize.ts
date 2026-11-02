import { createHash } from 'node:crypto';
import type { RuleClause, RuleOrigin, RuleScope, UnifiedRule } from './types.js';

export function normalizeRuleGroup(origin: RuleOrigin, scope: RuleScope, clauses: RuleClause[]): UnifiedRule {
  const harnesses = [...new Set(scope.harnesses ?? (origin.harness === 'cindy' ? [] : [origin.harness]))].sort();
  if (!harnesses.length || harnesses.some(value => !['claude-code', 'codex', 'pi'].includes(value)))
    throw new Error('Explicit approval rule harness eligibility required');
  const effectiveScope = { ...scope, harnesses };
  const id = createHash('sha256').update(JSON.stringify([
    'approval-source-v2',
    effectiveScope.ownerId, effectiveScope.executionHostId, effectiveScope.projectId ?? null,
    harnesses, origin.harness, origin.layer, origin.locator, origin.sourceId,
    origin.decisionDomain ?? 'personal-approval',
  ])).digest('hex');
  return { id, revision: 1, scope: effectiveScope, origin: { ...origin },
    clauses: structuredClone(clauses), updatedBy: origin.sourceId };
}
