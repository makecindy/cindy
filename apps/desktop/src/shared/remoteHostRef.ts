/**
 * Browser-safe HostRef entry point for Desktop main and renderer. The source
 * of truth lives in maker-remote-ssh's pure types module; importing its package
 * root here would also pull Node-only SSH modules into the renderer graph.
 */
export {
  canonicalHostRef as canonicalRemoteHostRef,
  parseHostRef as parseRemoteHostRef,
  sameHostRef as sameRemoteHostRef,
} from '@cindy/maker-remote-ssh/host-ref';
export type { HostRefNamespace as RemoteHostNamespace } from '@cindy/maker-remote-ssh/host-ref';

import {
  canonicalHostRef,
  parseHostRef,
} from '@cindy/maker-remote-ssh/host-ref';

/** Minimal renderer-safe candidate shape for resolving persisted remote IDs. */
export interface RemoteHostRefCandidate {
  id: string;
  alias?: string;
  source?: 'ssh-config' | 'manual' | string;
}

/**
 * Resolve a persisted remote host value against the currently discovered
 * hosts. Exact HostRefs win. A bare value is an SSH alias; the one historical
 * ambiguity is an old SSH alias that itself starts with `cindy:` or
 * `ssh-config:`. For that case an exact Cindy profile still wins, otherwise
 * an active SSH alias is allowed to recover the pre-namespace spelling.
 */
export function resolveRemoteHostRefAgainstCandidates(
  value: string,
  candidates: readonly RemoteHostRefCandidate[],
): string {
  const exact = candidates.find((candidate) => candidate.id === value);
  if (exact) return exact.id;

  // Same order as ConnectionPool.resolveId: a complete HostRef already won
  // above. Otherwise a live SSH alias may still be the pre-namespace spelling
  // (`cindy:build`, `ssh-config:foo`). Returning early on any `ssh-config:`
  // string would hide that alias behind the namespace of the stored value.
  const sshAlias = candidates.find(
    (candidate) => candidate.source === 'ssh-config' && candidate.alias === value,
  );
  if (sshAlias) return sshAlias.id;

  if (parseHostRef(value)) return value;
  return canonicalHostRef(value);
}
