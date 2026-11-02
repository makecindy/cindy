import { describe, expect, it } from 'vitest';
import { requirementsOrigin } from './requirements.js';
import { normalizeRuleGroup } from './normalize.js';
import { evaluateApprovalRules } from './evaluate.js';
import { parseApprovalRuleSnapshot } from './schema.js';
import { compileRuleGroup } from './compile.js';
import { readClaudePersonalRules, readClaudeLiveUserRules, readClaudeLiveSourceContents } from './readers/claude-code.js';
import { readCodexPersonalRules, parseCodexUserRuleContent } from './readers/codex.js';
import type { NativeSourceRegistration } from './readers/registration.js';
import type { ApprovalRuleSnapshot, RuleOrigin, RuleScope, UnifiedRule } from './types.js';
import { evaluatePersonalRequirements, matchedPersonalAutoAsks } from '../auto-review-decision.js';

// Test value (unit): production normalize/parse/evaluate/read entry points expose
// deny, unavailable and residual outcomes. Roadmap stage one requires owner,
// source, project and unknown-syntax isolation; no prior rule-model test covers
// these paths. Minimal failures: same sourceId in two layers, disabled Codex
// layer, and wide allow beside unknown syntax. This file runs in <1s locally.
const scope: RuleScope = { ownerId: 'owner', executionHostId: 'host', projectId: 'A', harnesses: ['claude-code', 'codex', 'pi'] };
const origin = (harness: 'claude-code' | 'codex', sourceId: string): RuleOrigin => ({
  harness, sourceId, locator: 'fixture', dialectVersion: 'v1', layer: 'user',
});
const group = (o: RuleOrigin, s: RuleScope, decision: 'allow' | 'deny', pattern: string): UnifiedRule =>
  normalizeRuleGroup(o, s, [{ id: 'c1', original: o.harness === 'claude-code' ? 'Bash(' + pattern + ':*)' : pattern, decision,
    matcher: { kind: 'argv-prefix', tokens: pattern.split(' ') } }]);
const snapshot = (...groups: UnifiedRule[]): ApprovalRuleSnapshot => ({
  schemaVersion: 1, revision: 1, groups, tombstones: [],
});

// Unit: real native wrapper must match only the opaque full string, never its inner argv.
describe('Codex opaque exact native wrapper', () => {
  const command = "/bin/bash -lc 'touch /home/xd.guest/approval-test-work/CINDY_REMEMBER_TARGET_c20261026a'";
  const managed = (decision: 'allow' | 'ask' | 'deny') => normalizeRuleGroup({ harness: 'cindy', layer: 'user',
    sourceId: 'exact-codex-command:test', locator: 'cindy://personal-approval/exact-codex-command/test',
    dialectVersion: '1', decisionDomain: 'personal-approval' }, { ...scope, harnesses: ['codex'] },
    [{ id: 'exact', original: 'exec(' + command + ')', decision, tool: { domain: 'exec', name: 'exec' },
      matcher: { kind: 'cc-command', mode: 'exact', pattern: command } }]);
  it.each(['allow', 'ask', 'deny'] as const)('matches only the full supported native string for %s', decision => {
    const rule = managed(decision);
    expect(evaluateApprovalRules(snapshot(rule), scope, command, 'codex')).toMatchObject({ status: 'matched', decision });
    for (const other of [command.replace('c20261026a', 'other'), command.slice(15, -1)])
      expect(evaluateApprovalRules(snapshot(rule), scope, other, 'codex')).toMatchObject({ status: 'unmatched' });
    for (const harness of ['claude-code', 'pi'] as const) {
      const wrong = { ...rule, scope: { ...scope, harnesses: [harness] } };
      expect(evaluateApprovalRules(snapshot(wrong), scope, command, harness)).toMatchObject({ status: 'uncovered' });
    }
  });
  it.each(['prefix', 'glob', 'argv-prefix', 'native', 'residual', 'deny', 'complex'] as const)(
    'does not widen opaque input through %s or discard source siblings', scenario => {
      const rule = managed('allow');
      if (scenario === 'prefix' || scenario === 'glob') rule.clauses[0]!.matcher = { kind: 'cc-command', mode: scenario, pattern: command };
      if (scenario === 'argv-prefix') rule.clauses[0]!.matcher = { kind: 'argv-prefix', tokens: ['/bin/bash'] };
      if (scenario === 'native') rule.origin = { ...rule.origin, harness: 'codex' };
      if (scenario === 'residual') rule.clauses.push({ id: 'unknown', original: 'unknown()', decision: 'deny', reason: 'unverified' });
      if (scenario === 'deny') rule.clauses.push({ ...rule.clauses[0]!, id: 'deny', decision: 'deny' });
      const actual = scenario === 'complex' ? "/bin/bash -lc 'touch x; touch y'" : command;
      if (scenario === 'complex') rule.clauses[0]!.matcher = { kind: 'cc-command', mode: 'exact', pattern: actual };
      expect(evaluateApprovalRules(snapshot(rule), scope, actual, 'codex')).toMatchObject(
        scenario === 'deny' ? { status: 'matched', decision: 'deny' } : { status: 'uncovered' });
    });
});

// Unit: only the remembered exact Auto ask is exempt, not its source siblings or native policy.
describe('remembered exact Auto asks', () => {
  function fixture() {
    const execution: RuleScope = { ownerId: 'owner', executionHostId: 'host', projectId: '/repo', harnesses: ['claude-code'] };
    const native = normalizeRuleGroup({ ...origin('claude-code', 'live'), decisionDomain: 'personal-approval' },
      { ...execution, projectId: undefined }, [{ id: 'ask', original: 'Bash(git:*)', decision: 'ask',
        matcher: { kind: 'cc-command', mode: 'prefix', pattern: 'git' } }]);
    const requirements = { scope: execution, fingerprint: 'current', groups: [native] };
    const allow = normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: 'exact-bash:remembered',
      locator: 'cindy://personal-approval/exact-bash/remembered', dialectVersion: '1', decisionDomain: 'personal-approval' },
      { ...execution, projectId: undefined }, [{ id: 'allow', original: 'Bash(git push)', decision: 'allow',
        matcher: { kind: 'cc-command', mode: 'exact', pattern: 'git push' }, tool: { domain: 'exec', name: 'Bash' },
        autoAskExceptions: matchedPersonalAutoAsks(requirements, 'git push') }]);
    return { requirements: { ...requirements, groups: [native, allow] }, native, allow };
  }
  it('round-trips the optional exception without changing global native ask priority', () => {
    const f = fixture();
    const stored = parseApprovalRuleSnapshot(snapshot(...f.requirements.groups));
    expect(evaluatePersonalRequirements({ ...f.requirements, groups: stored.groups }, 'git push'))
      .toMatchObject({ status: 'matched', decision: 'allow' });
    expect(evaluateApprovalRules(stored, f.requirements.scope, 'git push', 'claude-code'))
      .toMatchObject({ status: 'matched', decision: 'ask' });
  });
  it.each(['deny', 'residual', 'cwd', 'command', 'harness', 'source', 'clause', 'original', 'remove', 'explicit-ask'] as const)(
    'does not borrow the remembered exception for %s', scenario => {
      const f = fixture();
      let command = 'git push';
      if (scenario === 'deny') f.native.clauses.push({ id: 'deny', original: 'Bash(git push)', decision: 'deny', matcher: { kind: 'cc-command', mode: 'exact', pattern: command } });
      if (scenario === 'residual') f.native.clauses.push({ id: 'unknown', original: 'Bash(*private*)', decision: 'deny', reason: 'unverified wildcard' });
      if (scenario === 'cwd') f.requirements.scope = { ...f.requirements.scope, projectId: '/other' };
      if (scenario === 'command') command = 'git fetch';
      if (scenario === 'harness') f.allow.scope.harnesses = ['pi'];
      if (scenario === 'source') f.native.origin.sourceId = 'new-source';
      if (scenario === 'clause') f.native.clauses[0]!.id = 'new-ask';
      if (scenario === 'original') f.native.clauses[0]!.original = 'Bash(git push)';
      if (scenario === 'remove') f.requirements.groups = [f.native];
      if (scenario === 'explicit-ask') { f.allow.clauses[0]!.decision = 'ask'; delete f.allow.clauses[0]!.autoAskExceptions; }
      expect(evaluatePersonalRequirements(f.requirements, command)).toMatchObject(scenario === 'residual'
        ? { status: 'uncovered' } : { status: 'matched', decision: scenario === 'deny' ? 'deny' : 'ask' });
    });
  it('rejects malformed or deny-bearing exception storage instead of interpreting it as an allow', () => {
    for (const change of ['deny', 'reference', 'native-group'] as const) {
      const f = fixture();
      if (change === 'deny') f.allow.clauses[0]!.decision = 'deny';
      if (change === 'reference') f.allow.clauses[0]!.autoAskExceptions![0]!.scope.projectId = '';
      if (change === 'native-group') f.allow.origin.harness = 'claude-code';
      expect(() => parseApprovalRuleSnapshot(snapshot(...f.requirements.groups))).toThrow();
    }
  });
});

// Live control-state import (unit): native probe established source/ignored/error
// semantics. File-reader tests cannot protect same-Query provenance or distinguish
// excluded/invalid settings from a successful empty source deletion.
describe('Claude live user rule observations', () => {
  const row = (behavior = 'deny', rule = 'Bash(git push:*)', source = 'userSettings') => ({
    behavior, rule, source, editability: source === 'userSettings' ? 'persistent' : 'readonly',
  });
  const state = (patch: Record<string, unknown> = {}) => ({
    originalCwd: '/fixture/work', managedOnly: false, errors: [],
    rules: [row()], workspaceDirectories: [], ...patch,
  });

  it('preserves all decisions and verbatim residuals without inventing a file identity or mixing flag rules', () => {
    const rules = [row('allow', 'Bash(git status)'), row('ask', 'Bash(git fetch:*)'), row(),
      row('deny', 'Bash(*push*)'), row('ask', 'Unknown(\u200bvalue)'),
      row('allow', 'Bash(git push:*)', 'flagSettings')];
    const result = readClaudeLiveUserRules({ state: state({ rules }) }, true);
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.rules).toEqual(rules.slice(0, -1));
    expect(result.clauses.map(clause => [clause.original, clause.decision]))
      .toEqual(rules.slice(0, -1).map(rule => [rule.rule, rule.behavior]));
    expect(result.clauses.slice(0, 3).map(clause => clause.matcher)).toEqual([
      { kind: 'cc-command', mode: 'exact', pattern: 'git status' },
      { kind: 'cc-command', mode: 'prefix', pattern: 'git fetch' },
      { kind: 'cc-command', mode: 'prefix', pattern: 'git push' },
    ]);
    expect(result.clauses.slice(3).every(clause => !clause.matcher && clause.reason)).toBe(true);
    expect(result).not.toHaveProperty('origin');
    expect(result).not.toHaveProperty('canonicalLocator');
    expect(readClaudePersonalRules({ permissions: { deny: ['Bash(git push:*)'] } }))
      .toMatchObject({ kind: 'unavailable' });
  });

  // Unit: same control-state source views preserve native filtering. User-only
  // tests cannot detect accidental flag mixing or raw project allow insertion.
  it('partitions actual rows by source and never fills a native-filtered project allow', () => {
    const rows = ['userSettings', 'projectSettings', 'localSettings'].flatMap(source =>
      ['allow', 'ask', 'deny'].filter(behavior => source !== 'projectSettings' || behavior !== 'allow')
        .map(behavior => ({ ...row(behavior, 'Bash(same)', source), editability: 'persistent' })));
    rows.push({ ...row('deny', 'Bash(*unknown*)', 'localSettings'), editability: 'persistent' });
    const response = { state: state({ rules: [...rows, row('allow', 'Bash(same)', 'flagSettings')] }) };
    const enabled = { userSettings: true, projectSettings: true, localSettings: true };
    const result = readClaudeLiveSourceContents(response, enabled);
    expect(result.userSettings).toEqual(readClaudeLiveUserRules(response, true));
    for (const source of ['userSettings', 'projectSettings', 'localSettings'] as const) {
      const content = result[source];
      expect(content.kind).toBe('available');
      if (content.kind !== 'available') continue;
      expect(content.rules).toEqual(rows.filter(rule => rule.source === source));
      expect(content.clauses.map(clause => [clause.original, clause.decision]))
        .toEqual(rows.filter(rule => rule.source === source).map(rule => [rule.rule, rule.behavior]));
      expect(content).not.toHaveProperty('canonicalLocator');
    }
    expect(result.localSettings.kind === 'available' && result.localSettings.clauses.at(-1)?.matcher).toBeUndefined();
    const excluded = readClaudeLiveSourceContents(response, { ...enabled, projectSettings: false });
    expect(excluded.projectSettings).toEqual({ kind: 'unavailable', reason: 'source-excluded' });
    expect(excluded.localSettings).toEqual(result.localSettings);
    const ignored = readClaudeLiveSourceContents({ state: state({ rules: rows.map(rule =>
      rule.source === 'projectSettings' ? { ...rule, notInEffect: true } : rule) }) }, enabled);
    expect(ignored.projectSettings).toEqual({ kind: 'unavailable', reason: 'source-not-in-effect' });
    expect(ignored.userSettings).toEqual(result.userSettings);
  });

  it.each([
    ['source-excluded', {}, false],
    ['managed-only', { managedOnly: true }, true],
    ['source-not-in-effect', { rules: [{ ...row(), notInEffect: true }] }, true],
    ['settings-errors', { errors: [{ file: '/fixture/settings.json', path: 'permissions.deny', message: 'invalid' }] }, true],
    ['source-empty', { rules: [] }, true],
    ['source-empty', { rules: [row('deny', 'Bash(git push:*)', 'flagSettings')] }, true],
    ['state-invalid', { managedOnly: undefined }, true],
    ['state-invalid', { rules: [{ ...row(), rule: 42 }] }, true],
    ['state-invalid', { rules: [{ ...row(), notInEffect: 'false' }] }, true],
    ['state-invalid', { errors: {} }, true],
  ] as const)('returns %s rather than an effective empty replacement (%j)', (reason, patch, enabled) => {
    expect(readClaudeLiveUserRules({ state: state(patch) }, enabled))
      .toEqual({ kind: 'unavailable', reason });
  });
});

// Content observation has no qualified file registration; parsing must preserve
// all native decisions and a valid nonliteral expression without promoting it.
describe('Codex source content parsing', () => {
  it('preserves full decisions and nonliteral source without claiming native loading', () => {
    const lines = [
      'prefix_rule(pattern=["git", "status"], decision="allow")',
      'prefix_rule(pattern=["git", "fetch"], decision="prompt")',
      'prefix_rule(pattern=["git", "push"], decision="forbidden")',
      'blocked = ["rm"]',
      'prefix_rule(pattern=blocked, decision="forbidden")',
    ];
    const result = parseCodexUserRuleContent(lines.join('\n'));
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') return;
    expect(result.clauses.map(clause => clause.original)).toEqual(lines);
    expect(result.clauses.slice(0, 3).map(clause => clause.decision)).toEqual(['allow', 'ask', 'deny']);
    expect(result.clauses.slice(0, 3).every(clause => clause.matcher?.kind === 'argv-prefix')).toBe(true);
    expect(result.clauses.slice(3).every(clause => !clause.matcher && clause.reason)).toBe(true);
    expect(result).not.toHaveProperty('origin');
    expect(result).not.toHaveProperty('canonicalLocator');
    expect(readCodexPersonalRules(lines.join('\n'))).toMatchObject({ kind: 'unavailable' });
    expect(parseCodexUserRuleContent({})).toEqual({ kind: 'unavailable', reason: 'source-invalid' });
  });
});

describe('personal approval rule model', () => {
  it('combines eligible sources with deny ahead of allow and keeps owner and harness isolation', () => {
    const allow = group(origin('claude-code', 'a'), scope, 'allow', 'git');
    const deny = group(origin('codex', 'b'), scope, 'deny', 'git push');
    expect(evaluateApprovalRules(snapshot(allow, deny), scope, 'git push main', 'pi'))
      .toMatchObject({ status: 'matched', decision: 'deny' });
    expect(evaluateApprovalRules(snapshot(allow, deny), { ...scope, ownerId: 'other' }, 'git push main', 'pi'))
      .toEqual({ status: 'unmatched' });
    const restricted = group(origin('codex', 'b'), { ...scope, harnesses: ['codex'] }, 'deny', 'git push');
    expect(evaluateApprovalRules(snapshot(allow, restricted), scope, 'git push main', 'pi'))
      .toMatchObject({ status: 'matched', decision: 'allow' });
  });

  it('keeps unknown clauses in the same priority group from authorizing a wide allow', () => {
    const rule = normalizeRuleGroup(origin('codex', 'b'), scope, [
      { id: 'wide', original: 'git', decision: 'allow', matcher: { kind: 'argv-prefix', tokens: ['git'] } },
      { id: 'unknown', original: 'dynamic_rule()', decision: 'deny', reason: 'Unknown native syntax' },
    ]);
    expect(evaluateApprovalRules(snapshot(rule), scope, 'git status', 'pi'))
      .toMatchObject({ status: 'uncovered', actionConstraint: 'literal-residual' });
    expect(compileRuleGroup(rule, 'codex')).toMatchObject({ status: 'partial', nativeClauses: [] });
  });

  it('does not infer another harness from a registered native source', () => {
    const local = group(origin('codex', 'b'), { ...scope, harnesses: undefined }, 'deny', 'git push');
    expect(local.scope.harnesses).toEqual(['codex']);
    expect(evaluateApprovalRules(snapshot(local), scope, 'git push', 'pi'))
      .toEqual({ status: 'unmatched' });
    expect(compileRuleGroup(local, 'pi').status).toBe('unsupported');
  });

  it('keeps project and local native files distinct when a registration reuses sourceId', () => {
    const project = normalizeRuleGroup({
      ...origin('claude-code', 'settings'), layer: 'project', locator: '/a/settings.json',
    }, scope, [{ id: 'deny', original: 'Bash(git push:*)', decision: 'deny',
      matcher: { kind: 'cc-command', pattern: 'git push', mode: 'prefix' } }]);
    const local = normalizeRuleGroup({
      ...origin('claude-code', 'settings'), layer: 'local', locator: '/b/settings.local.json',
    }, scope, [{ id: 'allow', original: 'Bash(git:*)', decision: 'allow',
      matcher: { kind: 'cc-command', pattern: 'git', mode: 'prefix' } }]);
    expect(project.id).not.toBe(local.id);
    expect(parseApprovalRuleSnapshot(snapshot(project, local)).groups).toHaveLength(2);
  });

  it('leaves nonliteral shell input and unknown CC selectors unresolved', () => {
    const rule = normalizeRuleGroup(origin('claude-code', 'a'), scope, [
      { id: 'wide', original: 'Bash(git:*)', decision: 'allow', matcher: { kind: 'cc-command', pattern: 'git', mode: 'prefix' } },
      { id: 'unknown', original: 'UnknownSelector()', decision: 'deny', reason: 'Unknown selector' },
    ]);
    expect(evaluateApprovalRules(snapshot(rule), scope, 'git status', 'pi'))
      .toMatchObject({ status: 'uncovered', actionConstraint: 'literal-residual' });
    expect(evaluateApprovalRules(snapshot(rule), scope, 'git $ACTION', 'pi'))
      .toMatchObject({ status: 'uncovered', actionConstraint: 'unsupported-input' });
  });

  it('rejects malformed persisted rules instead of treating them as empty', () => {
    const valid = snapshot(group(origin('codex', 'b'), scope, 'deny', 'git push'));
    expect(parseApprovalRuleSnapshot(valid)).toEqual(valid);
    expect(() => parseApprovalRuleSnapshot({ ...valid, groups: [{ ...valid.groups[0], scope: { ...scope, ownerId: '' } }] })).toThrow();
  });
});

const registration = (harness: 'claude-code' | 'codex', layer: 'user' | 'project' | 'local' = 'user'):
  NativeSourceRegistration => ({
    kind: 'host-effective-native-source',
    harness, layer, canonicalLocator: '/trusted/settings.rules',
    ownerId: 'owner', executionHostId: 'host', projectId: '/project/A',
    layerState: 'enabled', locatorState: 'canonical', projectState: layer === 'user' ? 'not-applicable' : 'qualified',
    harnesses: ['claude-code', 'codex', 'pi'],
  });

describe('personal native source readers', () => {
  it('requires explicit effective layer and project qualification before parsing native source', () => {
    expect(readCodexPersonalRules('prefix_rule(pattern=["git"],decision="forbidden")'))
      .toMatchObject({ kind: 'unavailable', reason: 'registration-missing' });
    for (const layerState of ['disabled', 'unknown'] as const) {
      expect(readCodexPersonalRules('prefix_rule(pattern=["git"],decision="forbidden")', {
        ...registration('codex'), layerState,
      })).toMatchObject({ kind: 'unavailable', reason: 'layer-' + layerState });
    }
    expect(readClaudePersonalRules({ permissions: { deny: ['Bash(git push:*)'] } }, {
      ...registration('claude-code', 'project'), projectState: 'unknown',
    })).toMatchObject({ kind: 'unavailable', reason: 'project-unqualified' });
    expect(readClaudePersonalRules({ permissions: { deny: ['Bash(git push:*)'] } }, {
      ...registration('claude-code'), locatorState: 'unknown',
    })).toMatchObject({ kind: 'unavailable', reason: 'locator-unverified' });
  });

  it('uses the Host-provided canonical locator for user identity across projects', () => {
    const cc = { permissions: { deny: ['Bash(git push:*)'] } };
    const first = readClaudePersonalRules(cc, registration('claude-code'));
    const alias = readClaudePersonalRules(cc, { ...registration('claude-code'), projectId: '/project/B' });
    const project = readClaudePersonalRules(cc, { ...registration('claude-code', 'project'), projectId: '/project/A' });
    expect(first.kind).toBe('available');
    expect(alias.kind).toBe('available');
    expect(project.kind).toBe('available');
    if (first.kind !== 'available' || alias.kind !== 'available' || project.kind !== 'available') return;
    expect(first.group.id).toBe(alias.group.id);
    expect(first.group.scope.projectId).toBeUndefined();
    expect(project.group.id).not.toBe(first.group.id);
  });

  it('returns unavailable for malformed runtime path metadata instead of throwing', () => {
    const source = { permissions: { deny: ['Bash(git push:*)'] } };
    for (const canonicalLocator of [undefined, null, 42, {}, false, 'relative/settings.json']) {
      const malformed = { ...registration('claude-code'), canonicalLocator } as unknown as NativeSourceRegistration;
      expect(readClaudePersonalRules(source, malformed))
        .toMatchObject({ kind: 'unavailable', reason: 'locator-unverified' });
    }
    for (const projectId of [undefined, null, 42, {}, false, 'relative/project']) {
      const malformed = { ...registration('codex', 'project'), projectId } as unknown as NativeSourceRegistration;
      expect(readCodexPersonalRules('prefix_rule(pattern=["git"],decision="forbidden")', malformed))
        .toMatchObject({ kind: 'unavailable', reason: 'project-unqualified' });
    }
  });

  it('leaves unverified Claude glob syntax residual instead of granting a program allow', () => {
    const result = readClaudePersonalRules({ permissions: {
      allow: ['Bash(git:*)', 'Bash(*push*)', 'Bash(git *:*)', 'Bash(:*)'],
    } }, registration('claude-code'));
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.group.clauses[0]).toMatchObject({ matcher: { mode: 'prefix', pattern: 'git' } });
    for (const clause of result.group.clauses.slice(1)) {
      expect(clause).toMatchObject({ reason: expect.any(String) });
      expect(clause.matcher).toBeUndefined();
    }
    expect(evaluateApprovalRules(snapshot(result.group), scope, 'git push', 'pi'))
      .toMatchObject({ status: 'uncovered', actionConstraint: 'literal-residual' });
  });

  it('keeps reader qualifications scoped to their proven harness and project', () => {
    const result = readCodexPersonalRules('prefix_rule(pattern=["git","push"],decision="forbidden")', {
      ...registration('codex', 'project'), harnesses: ['codex'],
    });
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    const rules = snapshot(result.group);
    const projectA: RuleScope = { ownerId: 'owner', executionHostId: 'host', projectId: '/project/A' };
    expect(evaluateApprovalRules(rules, projectA, 'git push main', 'codex'))
      .toMatchObject({ status: 'matched', decision: 'deny' });
    expect(evaluateApprovalRules(rules, { ...projectA, projectId: '/project/B' }, 'git push main', 'codex'))
      .toEqual({ status: 'unmatched' });
    expect(evaluateApprovalRules(rules, projectA, 'git push main', 'pi'))
      .toEqual({ status: 'unmatched' });
  });

  it('does not import unrelated Claude settings as personal rules', () => {
    const result = readClaudePersonalRules({
      env: { TOKEN: 'fixture-secret' }, hooks: { PreToolUse: ['not a rule'] },
      permissions: { deny: ['Bash(git push:*)'] },
    }, registration('claude-code'));
    expect(result.kind).toBe('available');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(JSON.stringify(result)).not.toContain('not a rule');
  });

  it('retains unknown Codex syntax beside a known wide allow as residual', () => {
    const result = readCodexPersonalRules(
      'prefix_rule(pattern=["git"],decision="allow")\ncustom_rule()\n', registration('codex'));
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.group.clauses).toHaveLength(2);
    expect(result.group.clauses[1]).toMatchObject({ original: 'custom_rule()', reason: expect.any(String) });
    expect(evaluateApprovalRules(snapshot(result.group), scope, 'git push', 'pi'))
      .toMatchObject({ status: 'uncovered', actionConstraint: 'literal-residual' });
  });

  it('parses multiline literal Codex rules and keeps contradictory native examples unresolved', () => {
    const result = readCodexPersonalRules(
      '# fixture\nprefix_rule(\n pattern=["git", ["push", "fetch"]],\n decision="forbidden",\n not_match=["git status"],\n)\nprefix_rule(pattern=["git"],decision="allow",match=["ls"])',
      registration('codex'));
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.group.clauses).toHaveLength(2);
    expect(result.group.clauses[0]).toMatchObject({ decision: 'deny', matcher: { kind: 'argv-prefix' } });
    expect(result.group.clauses[1]).toMatchObject({ reason: expect.any(String) });
    expect(evaluateApprovalRules(snapshot(result.group), scope, 'git push main', 'pi'))
      .toMatchObject({ status: 'matched', decision: 'deny' });
    expect(evaluateApprovalRules(snapshot(result.group), scope, 'git status', 'pi'))
      .toMatchObject({ status: 'uncovered', actionConstraint: 'literal-residual' });
  });
});

// Unit: neutral text is a distinct schema variant, indivisible from explicit
// known siblings. Minimal prior failure: Read(...) text discarded as non-exec,
// or a known allow sibling hiding unresolved text. No Desktop dependencies.
describe.each(['claude-code', 'pi', 'codex'] as const)('keyed verbatim personal requirements (%s)', harness => {
  const tool = harness === 'pi' ? 'bash' as const : harness === 'codex' ? 'exec' as const : 'Bash' as const;
  const ownScope: RuleScope = { ownerId: 'owner', executionHostId: 'host', harnesses: [harness] };
  const requirement = () => normalizeRuleGroup(requirementsOrigin('release-policy'), ownScope,
    [{ id: 'requirement', original: 'Read(private)\r\n  保留 🧪 e\u0301  ', decision: 'requirement',
      reason: 'user-authored-verbatim', tool: { domain: 'exec', name: tool } }]);
  it.each(['none', 'allow', 'ask', 'deny'] as const)('keeps text beside explicit %s without inventing a decision', decision => {
    const rule = requirement();
    if (decision !== 'none') rule.clauses.push({ id: 'known', original: 'Read(this is an explicit exec clause)', decision,
      tool: { domain: 'exec', name: tool }, matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' } });
    const parsed = parseApprovalRuleSnapshot(snapshot(rule));
    expect(parsed.groups[0]!.clauses).toEqual(rule.clauses);
    expect(evaluateApprovalRules(parsed, ownScope, 'pwd', harness)).toMatchObject(
      decision === 'deny' || decision === 'ask' ? { status: 'matched', decision } : { status: 'uncovered' });
    expect(evaluateApprovalRules(parsed, ownScope, 'git status', harness)).toMatchObject({ status: 'uncovered' });
    for (const target of ['claude-code', 'pi', 'codex'] as const) {
      const plan = compileRuleGroup(rule, target);
      expect(plan.nativeClauses).toEqual([]);
      expect(plan.residualRequirements).toContainEqual(expect.objectContaining({ original: rule.clauses[0]!.original }));
    }
  });
  it('enforces namespace identity, neutral shape and sixteen exact siblings at the schema boundary', () => {
    const valid = requirement();
    const known = { id: 'known', original: 'Bash(pwd)', decision: 'allow' as const,
      tool: { domain: 'exec' as const, name: tool }, matcher: { kind: 'cc-command' as const, mode: 'exact' as const, pattern: 'pwd' } };
    valid.clauses.push(...Array.from({ length: 16 }, (_, i) => ({ ...known, id: 'c' + i })));
    expect(parseApprovalRuleSnapshot(snapshot(valid)).groups[0]!.clauses).toHaveLength(17);
    const mutations: Array<(rule: UnifiedRule) => void> = [
      rule => { rule.clauses.push({ ...known, id: 'overflow' }); },
      rule => { rule.id = 'forged'; },
      rule => { Object.assign(rule.clauses[0]!, { tool: { domain: 'exec', name: harness === 'pi' ? 'Bash' : 'bash' } }); },
      rule => { rule.origin = { ...rule.origin, sourceId: 'not-requirements' }; },
      rule => { rule.origin.harness = 'claude-code'; },
      rule => { rule.scope.harnesses = [harness === 'pi' ? 'claude-code' : 'pi']; },
      rule => { rule.clauses[0] = { ...rule.clauses[0]!, decision: 'allow' }; },
      rule => { Object.assign(rule.clauses[0]!, { matcher: known.matcher }); },
      rule => { Object.assign(rule.clauses[0]!, { autoAskExceptions: [] }); },
      rule => { Object.assign(rule.clauses[0]!, { reason: 'native-qualified' }); },
      rule => { Object.assign(rule.clauses[0]!, { tool: { domain: 'other', name: 'Read' } }); },
      rule => { rule.clauses[1] = { ...known, autoAskExceptions: [] }; },
      rule => { Object.assign(rule.clauses[1]!, { decision: ['deny'] }); },
      rule => { rule.clauses[1] = { ...known, matcher: { ...known.matcher, mode: 'prefix' } }; },
      rule => { rule.clauses[1] = { ...known, matcher: { ...known.matcher, pattern: 'pwd && rm x' } }; },
    ];
    for (const mutate of mutations) {
      const rule = structuredClone(valid); mutate(rule);
      expect(() => parseApprovalRuleSnapshot(snapshot(rule))).toThrow();
    }
  });
});

// Shared authored text retains one identity and residual group for each consumer.
// Explicit restrictions still decide; unresolved text never becomes an allow.
describe('shared keyed personal requirements', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('retains full text and a verified deny for %s', harness => {
    const scope: RuleScope = { ownerId: 'owner', executionHostId: 'host', harnesses: ['claude-code', 'codex', 'pi'] };
    const group = normalizeRuleGroup(requirementsOrigin('shared-policy'), scope, [
      { id: 'requirement', original: '不要执行危险命令\r\n完整 🧪  ', decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec' } },
      { id: 'known', original: 'explicit deny', decision: 'deny', tool: { domain: 'exec' }, matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' } },
    ]);
    const parsed = parseApprovalRuleSnapshot(snapshot(group));
    expect(parsed.groups).toEqual([group]);
    expect(evaluateApprovalRules(parsed, scope, 'pwd', harness)).toMatchObject({ status: 'matched', decision: 'deny' });
    expect(evaluateApprovalRules(parsed, scope, 'git status', harness)).toMatchObject({ status: 'uncovered' });
    const plan = compileRuleGroup(group, harness);
    expect(plan.residualRequirements).toContainEqual(expect.objectContaining({ original: group.clauses[0]!.original }));
    expect(plan.nativeClauses).toEqual([]);
  });
});

// Unit: the program decision must use the same per-consumer whole-group priority
// as the store, including when given an unfiltered whole-owner snapshot.
it.each(['claude-code', 'codex', 'pi'] as const)('applies a single-target project replacement to shared user rules only for %s', harness => {
  const scope: RuleScope = { ownerId: 'owner', executionHostId: 'host', harnesses: ['claude-code', 'codex', 'pi'] };
  const user = normalizeRuleGroup(requirementsOrigin('same-key'), scope, [
    { id: 'requirement', decision: 'requirement', reason: 'user-authored-verbatim', original: 'user whole text', tool: { domain: 'exec' } },
    { id: 'deny', decision: 'deny', original: 'user explicit pwd restriction', tool: { domain: 'exec' }, matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' } },
  ]);
  const project = normalizeRuleGroup(requirementsOrigin('same-key'), { ...scope, harnesses: ['codex'], projectId: '/project' }, [
    { id: 'requirement', decision: 'requirement', reason: 'user-authored-verbatim', original: 'project whole text', tool: { domain: 'exec', name: 'exec' } },
  ]);
  const both = { ...snapshot(user), groups: [user, project] };
  expect(evaluateApprovalRules(both, { ...scope, projectId: '/project' }, 'pwd', harness)).toMatchObject(harness === 'codex'
    ? { status: 'uncovered', ruleIds: [project.id] } : { status: 'matched', decision: 'deny', ruleIds: [user.id] });
  expect(evaluateApprovalRules(both, { ...scope, projectId: '/elsewhere' }, 'pwd', harness)).toMatchObject({ status: 'matched', decision: 'deny' });
  expect(evaluateApprovalRules(snapshot(user), { ...scope, projectId: '/project' }, 'pwd', harness)).toMatchObject({ status: 'matched', decision: 'deny' });
});
