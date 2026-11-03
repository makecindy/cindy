import { normalizeRuleGroup } from '../normalize.js';
import type { RuleClause, RuleDecision } from '../types.js';
import type { SDKPermissionRuleEntry } from '@anthropic-ai/claude-agent-sdk';
import { qualifyNativeSource, type NativeReadResult, type NativeSourceRegistration } from './registration.js';

function selectorClause(original: string, decision: RuleDecision, index: number): RuleClause {
  const body = /^Bash\(([^\r\n]+)\)$/.exec(original)?.[1];
  const mode = body?.endsWith(':*') ? 'prefix' : 'exact';
  const pattern = mode === 'prefix' ? body?.slice(0, -2) : body;
  return { id: decision + ':' + index, original, decision,
    ...(pattern && !pattern.includes('*') ? { matcher: { kind: 'cc-command' as const, pattern, mode } }
      : { reason: 'Selector syntax or tool domain is not verified' }),
  };
}

/** A same-Query observation, not a canonical file registration or durable ID. */
export type ClaudeLiveSource = 'userSettings' | 'projectSettings' | 'localSettings';
export type ClaudeLiveRules<S extends ClaudeLiveSource = ClaudeLiveSource> = {
  kind: 'available'; source: S; originalCwd: string;
  rules: Array<Pick<SDKPermissionRuleEntry, 'source' | 'behavior' | 'rule' | 'editability'>>;
  clauses: RuleClause[];
} | { kind: 'unavailable'; reason:
  | 'source-excluded' | 'source-empty' | 'source-not-in-effect' | 'managed-only'
  | 'settings-errors' | 'state-invalid' | 'capability-unavailable' | 'read-failed' | 'stale' };

export type ClaudeLiveUserRules = ClaudeLiveRules<'userSettings'>;
export type ClaudeLiveSourceContents = { [S in ClaudeLiveSource]: ClaudeLiveRules<S> };

/** Native policy/flag/session rows stay native.
 * An absent or ignored source is never a successful empty replacement. */
function readClaudeLiveSource<S extends ClaudeLiveSource>(response: unknown, source: S, enabled: boolean): ClaudeLiveRules<S> {
  if (!enabled) return { kind: 'unavailable', reason: 'source-excluded' };
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(response) || !object(response.state)) return { kind: 'unavailable', reason: 'state-invalid' };
  const state = response.state;
  if (!Array.isArray(state.rules) || typeof state.managedOnly !== 'boolean'
    || typeof state.originalCwd !== 'string' || !state.originalCwd
    || (state.errors !== undefined && !Array.isArray(state.errors)))
    return { kind: 'unavailable', reason: 'state-invalid' };
  if (state.errors?.length) return { kind: 'unavailable', reason: 'settings-errors' };
  if (state.managedOnly) return { kind: 'unavailable', reason: 'managed-only' };
  const rules: Extract<ClaudeLiveRules<S>, { kind: 'available' }>['rules'] = [];
  for (const entry of state.rules) {
    if (!object(entry) || typeof entry.source !== 'string' || !entry.source
      || (entry.behavior !== 'allow' && entry.behavior !== 'ask' && entry.behavior !== 'deny') || typeof entry.rule !== 'string'
      || (entry.editability !== 'persistent' && entry.editability !== 'session' && entry.editability !== 'readonly')
      || (entry.notInEffect !== undefined && typeof entry.notInEffect !== 'boolean'))
      return { kind: 'unavailable', reason: 'state-invalid' };
    if (entry.source !== source) continue;
    if (entry.notInEffect) return { kind: 'unavailable', reason: 'source-not-in-effect' };
    if (entry.editability !== 'persistent') return { kind: 'unavailable', reason: 'state-invalid' };
    rules.push({ source, behavior: entry.behavior,
      rule: entry.rule, editability: 'persistent' });
  }
  if (!rules.length) return { kind: 'unavailable', reason: 'source-empty' };
  return { kind: 'available', source, originalCwd: state.originalCwd, rules,
    clauses: rules.map((rule, index) => selectorClause(rule.rule, rule.behavior, index)) };
}

/** Parse the same immutable control response per enabled source. No raw-file
 * supplementation: e.g. untrusted project allow rows may be absent natively. */
export function readClaudeLiveSourceContents(response: unknown, enabled: Record<ClaudeLiveSource, boolean>): ClaudeLiveSourceContents {
  return {
    userSettings: readClaudeLiveSource(response, 'userSettings', enabled.userSettings),
    projectSettings: readClaudeLiveSource(response, 'projectSettings', enabled.projectSettings),
    localSettings: readClaudeLiveSource(response, 'localSettings', enabled.localSettings),
  };
}

export function readClaudeLiveUserRules(response: unknown, userSourceEnabled: boolean): ClaudeLiveUserRules {
  return readClaudeLiveSource(response, 'userSettings', userSourceEnabled);
}

/** Parse one Host-qualified effective settings file as data. Hooks, env, native
 * defaults and managed policy never enter this personal permission reader. */
export function readClaudePersonalRules(
  settings: unknown, registration?: NativeSourceRegistration,
): NativeReadResult {
  const qualified = qualifyNativeSource(registration, 'claude-code');
  if (qualified.kind !== 'qualified') return qualified;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return { kind: 'unavailable', reason: 'source-invalid' };
  const permissions = (settings as Record<string, unknown>).permissions;
  if (permissions !== undefined && (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)))
    return { kind: 'unavailable', reason: 'source-invalid' };
  const values = permissions as Record<string, unknown> | undefined;
  const clauses: RuleClause[] = [];
  for (const decision of ['allow', 'ask', 'deny'] as const) {
    const selectors = values?.[decision] ?? [];
    if (!Array.isArray(selectors) || selectors.some(value => typeof value !== 'string'))
      return { kind: 'unavailable', reason: 'source-invalid' };
    for (const original of selectors as string[]) {
      clauses.push(selectorClause(original, decision, clauses.length));
    }
  }
  return { kind: 'available', group: normalizeRuleGroup(qualified.origin, qualified.scope, clauses) };
}
