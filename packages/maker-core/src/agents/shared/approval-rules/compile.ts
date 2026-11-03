import { literalCommandArgv } from './evaluate.js';
import type { ApprovalRuleSnapshot, RuleHarness, TargetPlan, UnifiedRule } from './types.js';

/** A priority group is indivisible: no native allow is emitted beside an unknown sibling. */
export function compileRuleGroup(group: UnifiedRule, target: RuleHarness): TargetPlan {
  const plan: TargetPlan = { ruleId: group.id, target, status: 'program',
    nativeClauses: [], residualRequirements: [] };
  if (!group.scope.harnesses?.includes(target) ||
    (group.origin.decisionDomain && group.origin.decisionDomain !== 'personal-approval')) {
    plan.status = 'unsupported';
    plan.residualRequirements = group.clauses.map(clause => ({ original: clause.original,
      reason: 'Unverified consumer or authorization domain' }));
    return plan;
  }
  for (const clause of group.clauses) {
    if (clause.decision === 'requirement' || !clause.matcher) {
      plan.residualRequirements.push({ original: clause.original, reason: clause.reason ?? 'Unknown source syntax' });
      continue;
    }
    if (group.origin.harness === 'claude-code' && !/^Bash\(/.test(clause.original)) {
      plan.residualRequirements.push({ original: clause.original, reason: 'Tool domain is not verified as command execution' });
      continue;
    }
    if (target === 'pi') continue;
    if (target === group.origin.harness) {
      plan.nativeClauses.push(clause.original);
      continue;
    }
    if (target === 'codex' && clause.matcher.kind === 'cc-command' && clause.matcher.mode === 'prefix') {
      const tokens = literalCommandArgv(clause.matcher.pattern);
      if (tokens) {
        const decision = { allow: 'allow', ask: 'prompt', deny: 'forbidden' }[clause.decision];
        plan.nativeClauses.push('prefix_rule(pattern=' + JSON.stringify(tokens) + ', decision=' + JSON.stringify(decision) + ')');
        continue;
      }
    }
    plan.residualRequirements.push({ original: clause.original, reason: 'Target lowering unverified' });
  }
  if (plan.residualRequirements.length) {
    plan.status = plan.nativeClauses.length ? 'partial' : 'unsupported';
    plan.nativeClauses = [];
  }
  return plan;
}
export function planApprovalRuleTargets(snapshot: ApprovalRuleSnapshot): TargetPlan[] {
  return snapshot.groups.flatMap(group => (['claude-code', 'codex', 'pi'] as const)
    .map(target => compileRuleGroup(group, target)));
}
