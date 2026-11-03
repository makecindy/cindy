import path from 'node:path';
import type { RuleHarness, RuleOrigin, RuleScope, UnifiedRule } from '../types.js';

/** Injected by a future trusted Host boundary for this exact runtime query.
 * A directory's existence, HOME, or an effective merged config is not proof.
 * No production caller is wired in stage one reader work. */
export type NativeSourceRegistration = {
  kind: 'host-effective-native-source';
  harness: 'claude-code' | 'codex';
  layer: 'user' | 'project' | 'local';
  /** Host-resolved real path for the exact source file, not a caller alias. */
  canonicalLocator: string;
  ownerId: string;
  executionHostId: string;
  projectId?: string;
  layerState: 'enabled' | 'disabled' | 'unknown';
  locatorState: 'canonical' | 'unknown';
  projectState: 'qualified' | 'unqualified' | 'unknown' | 'not-applicable';
  /** Every additional consumer needs its own trusted Host qualification. */
  harnesses: RuleHarness[];
};
export type NativeReadResult =
  | { kind: 'available'; group: UnifiedRule }
  | { kind: 'unavailable'; reason: 'registration-missing' | 'registration-invalid' | 'layer-disabled'
      | 'layer-unknown' | 'locator-unverified' | 'project-unqualified' | 'source-invalid' };

export function qualifyNativeSource(
  registration: NativeSourceRegistration | undefined,
  harness: 'claude-code' | 'codex',
): { kind: 'qualified'; origin: RuleOrigin; scope: RuleScope }
  | Extract<NativeReadResult, { kind: 'unavailable' }> {
  if (!registration) return { kind: 'unavailable', reason: 'registration-missing' };
  if (registration.kind !== 'host-effective-native-source' || registration.harness !== harness
    || !['user', 'project', 'local'].includes(registration.layer)
    || typeof registration.ownerId !== 'string' || !registration.ownerId
    || typeof registration.executionHostId !== 'string' || !registration.executionHostId
    || !Array.isArray(registration.harnesses) || !registration.harnesses.includes(harness)
    || registration.harnesses.some(value => !['claude-code', 'codex', 'pi'].includes(value)))
    return { kind: 'unavailable', reason: 'registration-invalid' };
  if (registration.layerState !== 'enabled')
    return { kind: 'unavailable', reason: registration.layerState === 'disabled' ? 'layer-disabled' : 'layer-unknown' };
  if (registration.locatorState !== 'canonical' || typeof registration.canonicalLocator !== 'string'
    || !path.isAbsolute(registration.canonicalLocator))
    return { kind: 'unavailable', reason: 'locator-unverified' };
  if (registration.layer === 'user') {
    if (registration.projectState !== 'not-applicable')
      return { kind: 'unavailable', reason: 'registration-invalid' };
  } else if (registration.projectState !== 'qualified' || typeof registration.projectId !== 'string'
    || !path.isAbsolute(registration.projectId)) {
    return { kind: 'unavailable', reason: 'project-unqualified' };
  }
  const locator = registration.canonicalLocator;
  return { kind: 'qualified',
    origin: { harness, layer: registration.layer, locator,
      sourceId: harness + ':' + registration.layer + ':' + locator,
      dialectVersion: harness === 'claude-code' ? 'permissions-v1' : 'prefix-rule-v1',
      decisionDomain: 'personal-approval' },
    scope: { ownerId: registration.ownerId, executionHostId: registration.executionHostId,
      ...(registration.layer === 'user' ? {} : { projectId: registration.projectId }),
      harnesses: [...new Set(registration.harnesses)] },
  };
}
