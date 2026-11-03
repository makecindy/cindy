import { isDeepStrictEqual } from 'node:util';
import { isSupportedManagedCommand } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/evaluate.js';
import { personalRuleTargets, requirementsOrigin, validRequirementsKey } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';
import { normalizeRuleGroup } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize.js';
import type { RuleClause, RuleHarness, RuleScope } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/types.js';
import type { createApprovalRuleStore } from '../maker-host/approval-rule-store.js';
export type RequirementsInput = { targets: RuleHarness[]; id: string; text?: string; clauses: RuleClause[] };
export function parseRequirements(text: string, remove: boolean): RequirementsInput | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  // JSON.parse discards duplicate object keys. Reject that ambiguity, including
  // escaped spellings, before constructing any trusted source identity.
  const stack: Array<Set<string> | null> = [];
  let previous = '';
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g)) {
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && stack.at(-1) && (previous === '{' || previous === ',')) {
      const key = JSON.parse(token) as string;
      if (stack.at(-1)!.has(key)) return null;
      stack.at(-1)!.add(key);
    }
    previous = token;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const targets = personalRuleTargets(input.targets);
  if (!validRequirementsKey(input.id) || !targets
    || Object.keys(input).some(key => !(remove ? ['id', 'targets'] : ['id', 'targets', 'text', 'clauses']).includes(key))) return null;
  const harness = targets.length === 1 ? targets[0] : undefined;
  const tool: Extract<RuleClause, { decision: 'requirement' }>['tool'] = { domain: 'exec', ...(harness ? { name: harness === 'pi' ? 'bash' as const : harness === 'codex' ? 'exec' as const : 'Bash' as const } : {}) };
  if (remove) return { targets, id: input.id, clauses: [] };
  if (typeof input.text !== 'string' || !input.text.trim()
    || (input.clauses !== undefined && (!Array.isArray(input.clauses) || input.clauses.length > 16))) return null;
  const clauses: RuleClause[] = [{ id: 'requirement', original: input.text, decision: 'requirement',
    reason: 'user-authored-verbatim', tool }];
  const ids = new Set(['requirement']);
  for (const raw of (input.clauses ?? []) as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clause = raw as Record<string, unknown>;
    if (!validRequirementsKey(clause.id) || ids.has(clause.id)
      || typeof clause.decision !== 'string' || !['allow', 'ask', 'deny'].includes(clause.decision)
      || typeof clause.exact !== 'string' || !targets.every(target => isSupportedManagedCommand(clause.exact as string, target))
      || typeof clause.original !== 'string' || !clause.original.trim()
      || Object.keys(clause).some(key => !['id', 'decision', 'exact', 'original'].includes(key))) return null;
    ids.add(clause.id);
    clauses.push({ id: clause.id, decision: clause.decision as 'allow' | 'ask' | 'deny', original: clause.original,
      matcher: { kind: 'cc-command', mode: 'exact', pattern: clause.exact }, tool });
  }
  return { targets, id: input.id, text: input.text, clauses };
}

/** Both trusted composers and Host-attested chat edits use exactly this commit. */
export async function writeRequirements(store: ReturnType<typeof createApprovalRuleStore>, revision: number,
  scope: RuleScope, input: RequirementsInput, remove: boolean, verify: () => Promise<void>) {
  if (!isDeepStrictEqual(personalRuleTargets(scope.harnesses), input.targets)) throw new Error('Requirement targets mismatch');
  const group = normalizeRuleGroup(requirementsOrigin(input.id), scope, input.clauses);
  const saved = await store.applyManagedEdit(revision, scope, remove ? [] : [group], remove ? [group.id] : [], verify, true);
  return { revision: saved.revision, ruleId: group.id };
}
