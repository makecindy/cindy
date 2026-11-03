/** Data model for explicitly registered personal sources, not native defaults. */
export type RuleHarness = 'claude-code' | 'codex' | 'pi';
export type RuleDecision = 'allow' | 'ask' | 'deny';
export type RuleScope = {
  ownerId: string;
  executionHostId: string;
  projectId?: string;
  /** Effective consumers proven by the trusted source registration. */
  harnesses?: RuleHarness[];
};
export type RuleOrigin = {
  harness: 'claude-code' | 'codex' | 'cindy';
  sourceId: string;
  locator: string;
  dialectVersion: string;
  layer: 'user' | 'project' | 'local';
  decisionDomain?: 'personal-approval' | 'sandbox-escalation' | 'unknown';
};
export type RuleMatcher =
  | { kind: 'cc-command'; pattern: string; mode: 'exact' | 'prefix' | 'glob' }
  | { kind: 'argv-prefix'; tokens: Array<string | string[]> };
type DecidingRuleClause = {
  id: string;
  original: string;
  decision: RuleDecision;
  matcher?: RuleMatcher;
  /** A clause without a verified matcher remains in its entire priority group. */
  reason?: string;
  tool?: { domain: 'exec' | 'other' | 'unknown'; name?: string };
  justification?: string;
  /** Explicitly remembered Auto asks for one exact command; never native grants or deny exceptions. */
  autoAskExceptions?: AutoAskException[];
  examples?: { match: string[]; notMatch: string[] };
};
/** User-authored verbatim data has no programmatic permission decision. */
export type RuleClause = DecidingRuleClause | {
  id: string;
  original: string;
  decision: 'requirement';
  reason: 'user-authored-verbatim';
  tool: { domain: 'exec'; name?: 'Bash' | 'bash' | 'exec' };
  matcher?: never;
  autoAskExceptions?: never;
  justification?: never;
  examples?: never;
};
export type AutoAskException = {
  scope: RuleScope;
  sourceGroupId: string;
  sourceScope: RuleScope;
  sourceOrigin: RuleOrigin;
  clauseId: string;
  original: string;
};
export type UnifiedRule = {
  id: string;
  revision: number;
  scope: RuleScope;
  origin: RuleOrigin;
  clauses: RuleClause[];
  updatedBy: string;
};
export type ManagedRuleOverride = {
  id: string;
  scope: RuleScope;
  revision: number;
  baseline?: UnifiedRule;
  replacesSourceId?: string;
};
export type ApprovalRuleSnapshot = {
  schemaVersion: 1;
  revision: number;
  groups: UnifiedRule[];
  tombstones: Array<{ id: string; revision: number }>;
  /** Explicit edits only. A project replacement names its canonical source. */
  managedOverrides?: ManagedRuleOverride[];
};
export type RuleEvaluation =
  | { status: 'unmatched'; uncoveredRuleIds?: string[] }
  | { status: 'matched'; decision: RuleDecision; ruleIds: string[]; uncoveredRuleIds?: string[] }
  | { status: 'uncovered'; ruleIds: string[]; actionConstraint: 'unsupported-input' | 'literal-residual'; reason: string; uncoveredRuleIds?: string[] };
export type TargetPlan = {
  ruleId: string;
  target: RuleHarness;
  status: 'program' | 'partial' | 'unsupported';
  nativeClauses: string[];
  residualRequirements: Array<{ original: string; reason: string }>;
};
