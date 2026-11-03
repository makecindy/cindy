import { subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { NewSessionAgentKind, NewSessionRuntime } from './newSession';

export interface NewSessionHostDefaults {
  deviceId: string;
  byAgent: Partial<Record<NewSessionAgentKind, NewSessionRuntime | null>>;
}

// Display/default-selection snapshots only. Provider availability and submission
// still use the live catalog. Refresh on each visit without hiding cached values.
const cache = new Map<string, NewSessionHostDefaults>();
subscribeMobileAuthOwner(() => cache.clear());

export function getNewSessionHostDefaults(deviceId: string): NewSessionHostDefaults | null {
  return cache.get(deviceId) ?? null;
}

export function cacheNewSessionHostDefaults(
  next: NewSessionHostDefaults,
  expected: NewSessionHostDefaults | null,
): NewSessionHostDefaults {
  const current = getNewSessionHostDefaults(next.deviceId);
  // Only the engines changed during this read outrank its response. A manual
  // Codex choice must not discard fresh Pi/Claude defaults from the same read.
  const byAgent = { ...next.byAgent };
  if (current && current !== expected) {
    for (const agent of Object.keys(current.byAgent) as NewSessionAgentKind[]) {
      if (current.byAgent[agent] !== expected?.byAgent[agent]) {
        byAgent[agent] = current.byAgent[agent];
      }
    }
  }
  const merged = { ...next, byAgent };
  cache.set(next.deviceId, merged);
  return merged;
}

export function rememberNewSessionHostRuntime(deviceId: string, runtime: NewSessionRuntime): void {
  const current = cache.get(deviceId);
  cache.set(deviceId, {
    deviceId,
    byAgent: { ...current?.byAgent, [runtime.agentKind]: runtime },
  });
}
