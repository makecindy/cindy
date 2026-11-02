import { requirementsKey } from './requirements.js';
import type { ApprovalRuleSnapshot, RuleEvaluation, RuleHarness, RuleMatcher, RuleScope, UnifiedRule } from './types.js';

/** Only simple literal words are evaluated. Shell syntax stays with the native runtime. */
export function literalCommandArgv(command: string): string[] | null {
  if (command !== command.trim() || !command || / {2}/.test(command)
    || !/^[A-Za-z0-9_./:@%+=, -]+$/.test(command)
    || /^(?:env|command|sudo|sh|bash|zsh|pwsh|powershell)(?: |$)/.test(command)) return null;
  return command.split(' ');
}
/** The observed Codex native wrapper is an opaque exact command, never an argv prefix. */
function isSimpleCodexShellCommand(command: string): boolean {
  if (command !== command.trim()) return false;
  const body = /^\/bin\/bash -lc '([^'\r\n]+)'$/.exec(command)?.[1];
  return body !== undefined && literalCommandArgv(body) !== null;
}
export function isSupportedManagedCommand(command: string, harness: RuleHarness): boolean {
  return literalCommandArgv(command) !== null || (harness === 'codex' && isSimpleCodexShellCommand(command));
}
export function ruleScopeMatches(rule: RuleScope, query: RuleScope, harness: RuleHarness): boolean {
  return rule.ownerId === query.ownerId && rule.executionHostId === query.executionHostId
    && (rule.projectId === undefined || rule.projectId === query.projectId)
    && !!rule.harnesses?.includes(harness);
}
/** Whole keyed project groups replace their user group for this consumer only.
 * Native and generic groups never acquire this authored-rule priority by name. */
export function selectApprovalRuleGroups(groups: readonly UnifiedRule[], scope: RuleScope, harness: RuleHarness): UnifiedRule[] {
  const applicable = groups.filter(group => ruleScopeMatches(group.scope, scope, harness));
  // A later authored edit replaces the same key only on its selected consumers.
  // Project priority remains above user priority; equal-revision ambiguity keeps
  // both whole groups for restrictive evaluation rather than inventing an allow.
  const priority = (group: UnifiedRule) => group.scope.projectId === undefined ? 0 : 1;
  const latest = new Map<string, { layer: number; revision: number }>();
  for (const group of applicable) {
    const key = requirementsKey(group);
    if (key === undefined) continue;
    const previous = latest.get(key), layer = priority(group);
    if (!previous || layer > previous.layer || (layer === previous.layer && group.revision > previous.revision))
      latest.set(key, { layer, revision: group.revision });
  }
  return applicable.filter(group => {
    const key = requirementsKey(group), selected = key === undefined ? undefined : latest.get(key);
    return !selected || (priority(group) === selected.layer && group.revision === selected.revision);
  });
}
function matches(matcher: RuleMatcher, command: string, argv: string[]): boolean {
  if (matcher.kind === 'argv-prefix')
    return matcher.tokens.length <= argv.length
      && matcher.tokens.every((token, index) =>
        typeof token === 'string' ? token === argv[index] : token.includes(argv[index]!));
  if (matcher.mode === 'exact') return command === matcher.pattern;
  if (matcher.mode === 'prefix')
    return command === matcher.pattern || command.startsWith(matcher.pattern + ' ');
  let patternIndex = 0, commandIndex = 0, star = -1, retry = 0;
  while (commandIndex < command.length) {
    if (matcher.pattern[patternIndex] === command[commandIndex]) { patternIndex++; commandIndex++; }
    else if (matcher.pattern[patternIndex] === '*') { star = patternIndex++; retry = commandIndex; }
    else if (star >= 0) { patternIndex = star + 1; commandIndex = ++retry; }
    else return false;
  }
  while (matcher.pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === matcher.pattern.length;
}
function toolDomain(original: string, source: string): 'exec' | 'other' | 'unknown' {
  if (source === 'codex') return 'exec';
  const name = /^([A-Za-z_][A-Za-z0-9_-]*)(?=\(|$)/.exec(original)?.[1];
  if (!name) return 'unknown';
  if (name === 'Bash') return 'exec';
  return ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'].includes(name)
    || name.startsWith('mcp__') ? 'other' : 'unknown';
}
export function evaluateApprovalRules(
  snapshot: Readonly<ApprovalRuleSnapshot>, scope: RuleScope, command: string,
  harness: RuleHarness,
): RuleEvaluation {
  const applicable = selectApprovalRuleGroups(snapshot.groups, scope, harness);
  if (!applicable.length) return { status: 'unmatched' };
  const uncoveredRuleIds = applicable.filter(group => group.clauses.some(clause => !clause.matcher)).map(group => group.id);
  const diagnostics = uncoveredRuleIds.length ? { uncoveredRuleIds } : {};
  const commandGroups = applicable.map(group => ({ ...group, clauses: group.clauses.filter(clause =>
    clause.decision === 'requirement' || requirementsKey(group) !== undefined || toolDomain(clause.original, group.origin.harness) !== 'other') })).filter(group => group.clauses.length);
  if (!commandGroups.length) return { status: 'unmatched', ...diagnostics };
  const argv = literalCommandArgv(command);
  const codexExact = harness === 'codex' && isSimpleCodexShellCommand(command);
  if (!argv && !codexExact) return { status: 'uncovered', ...diagnostics, ruleIds: commandGroups.map(group => group.id),
    actionConstraint: 'unsupported-input', reason: 'Input outside verified literal command domain' };
  const decisions: Array<{ id: string; decision: 'allow' | 'ask' | 'deny' }> = [];
  const residual: string[] = [];
  for (const group of commandGroups) {
    const supportsOpaqueExact = (clause: typeof group.clauses[number]) => group.origin.harness === 'cindy'
      && group.origin.decisionDomain === 'personal-approval' && group.origin.layer === 'user'
      && (group.origin.sourceId.startsWith('exact-codex-command:')
        || (requirementsKey(group) !== undefined && group.scope.harnesses?.[0] === 'codex'))
      && clause.tool?.domain === 'exec' && clause.tool.name === 'exec'
      && clause.matcher?.kind === 'cc-command' && clause.matcher.mode === 'exact';
    const hits = group.clauses.filter(clause => clause.decision !== 'requirement' && clause.matcher && (argv
      ? matches(clause.matcher, command, argv)
      : supportsOpaqueExact(clause) && clause.matcher.kind === 'cc-command' && clause.matcher.pattern === command));
    const unresolved = group.clauses.some(clause => !clause.matcher || (!argv && !supportsOpaqueExact(clause)));
    const personal = !group.origin.decisionDomain || group.origin.decisionDomain === 'personal-approval';
    if (unresolved || (!personal && hits.length)) residual.push(group.id);
    if (personal && hits.length) decisions.push({ id: group.id, decision:
      hits.some(clause => clause.decision === 'deny') ? 'deny'
        : hits.some(clause => clause.decision === 'ask') ? 'ask' : 'allow' });
  }
  const restrictive = decisions.filter(item => item.decision !== 'allow');
  if (restrictive.length) return { status: 'matched', ...diagnostics,
    decision: restrictive.some(item => item.decision === 'deny') ? 'deny' : 'ask',
    ruleIds: restrictive.map(item => item.id) };
  if (residual.length) return { status: 'uncovered', ...diagnostics, ruleIds: residual,
    actionConstraint: 'literal-residual', reason: 'Source priority group has unresolved requirements' };
  if (decisions.length) return { status: 'matched', ...diagnostics, decision: 'allow',
    ruleIds: decisions.map(item => item.id) };
  return { status: 'unmatched', ...diagnostics };
}
