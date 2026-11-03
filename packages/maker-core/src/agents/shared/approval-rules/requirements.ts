import { normalizeRuleGroup } from './normalize.js';
import type { RuleHarness, RuleOrigin, UnifiedRule } from './types.js';

/** New authored rules default to all consumers; persisted scopes never default. */
export function personalRuleTargets(value: unknown): RuleHarness[] | null {
  if (value === undefined) return ['claude-code', 'codex', 'pi'];
  if (!Array.isArray(value) || value.length === 0 || value.length > 3
    || value.some(target => !['claude-code', 'codex', 'pi'].includes(target))
    || new Set(value).size !== value.length) return null;
  return [...value].sort() as RuleHarness[];
}

/** Stable user keys, shared by trusted construction, persistence and evaluation. */
export const validRequirementsKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
export function requirementsOrigin(key: string): RuleOrigin {
  if (!validRequirementsKey(key)) throw new Error('Invalid personal requirement key');
  return { harness: 'cindy', layer: 'user', sourceId: 'requirements:' + key,
    locator: 'cindy://personal-approval/requirements/' + key,
    dialectVersion: '1', decisionDomain: 'personal-approval' };
}
export const requirementsNamespace = (origin: RuleOrigin) =>
  origin.sourceId.startsWith('requirements:') || origin.locator.startsWith('cindy://personal-approval/requirements/');
/** A project keeps the same origin as its own user group; scope supplies identity. */
export function requirementsKey(group: UnifiedRule): string | undefined {
  const key = group.origin.sourceId.slice('requirements:'.length);
  if (!validRequirementsKey(key)) return undefined;
  const expected = requirementsOrigin(key);
  if (Object.keys(group.origin).length !== Object.keys(expected).length
    || Object.keys(expected).some(field => group.origin[field as keyof RuleOrigin] !== expected[field as keyof RuleOrigin])
    || !group.scope.harnesses || !personalRuleTargets(group.scope.harnesses)
    || normalizeRuleGroup(expected, group.scope, group.clauses).id !== group.id) return undefined;
  return key;
}
