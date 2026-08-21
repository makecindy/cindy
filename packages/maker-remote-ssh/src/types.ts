/**
 * Public wire/data types for @cindy/maker-remote-ssh.
 *
 * Kept narrow on purpose — Phase A only covers connection management.
 * Channel / exec / sftp types will live alongside their impls when added.
 */

export type RemoteStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'failed';

export type AuthMethod = 'agent' | 'key';

/** Canonical in-process identity for a remote host. */
export type HostRef = `ssh-config:${string}` | `cindy:${string}` | (string & {});
export type HostRefNamespace = 'ssh-config' | 'cindy';

export type ConfigOrigin = 'main' | 'include';

/** Namespace an SSH config alias without losing colons in the alias itself. */
export function sshHostRef(alias: string): string {
  return `ssh-config:${alias}`;
}

export function cindyHostRef(profileId: string): string {
  return `cindy:${profileId}`;
}

/**
 * Parse only the first colon. Unknown namespaces are deliberately left as
 * unknown instead of being treated as Cindy profiles.
 */
export function parseHostRef(value: string): { namespace: HostRefNamespace; id: string } | null {
  const index = value.indexOf(':');
  if (index <= 0) return null;
  const namespace = value.slice(0, index);
  if (namespace !== 'ssh-config' && namespace !== 'cindy') return null;
  return { namespace, id: value.slice(index + 1) };
}

/**
 * Return the historical bare-alias spelling for an SSH HostRef only when it
 * cannot be confused with another namespaced HostRef. For example,
 * `ssh-config:ci.example` may fall back to `ci.example`, while
 * `ssh-config:cindy:foo` and `ssh-config:ssh-config:foo` must not fall back:
 * those strings already identify different canonical hosts.
 */
export function legacySshAliasForHostRef(value: string): string | null {
  const parsed = parseHostRef(value);
  if (parsed?.namespace !== 'ssh-config' || parseHostRef(parsed.id)) return null;
  return parsed.id;
}

/** Bare values are legacy SSH aliases; known namespaces remain authoritative. */
export function canonicalHostRef(value: string): string {
  return parseHostRef(value) ? value : sshHostRef(value);
}

export function sameHostRef(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return canonicalHostRef(left) === canonicalHostRef(right);
}

/**
 * Source of truth for a host entry. `ssh-config` is parsed from the user's
 * OpenSSH configuration. `manual` is a Cindy-local profile kept for wire
 * compatibility with the Phase-A model; it is no longer written to SSH config.
 */
export type HostSource = 'ssh-config' | 'manual';

/**
 * One remote machine known to maker. `id` is the canonical HostRef for new
 * hosts (`ssh-config:<alias>` or `cindy:<profileId>`). Bare ids remain
 * accepted by tests and legacy callers and are resolved by ConnectionPool.
 */
export interface HostConfig {
  /** Canonical HostRef (legacy callers may still pass a bare alias). */
  id: string;
  /** SSH alias for imported config hosts. */
  alias?: string;
  /** Cindy-local display label. SSH hosts default to alias and override it via prefs. */
  displayName?: string;
  hostname: string;
  port: number;
  user: string;
  authMethod: AuthMethod;
  /** absolute path; only meaningful when authMethod === 'key'. */
  identityFile?: string;
  source: HostSource;
  /** Which file supplied the first matching SSH Host block. */
  configOrigin?: ConfigOrigin;
  /** Explicitly read-only for SSH config hosts; manual profiles are editable. */
  editable?: boolean;
  deletable?: boolean;
}

/** Snapshot of a host's runtime state for renderer. */
export interface HostSnapshot {
  config: HostConfig;
  status: RemoteStatus;
  lastError?: string;
  /**
   * Human-readable label for the credential that succeeded on the most
   * recent connect — e.g. "ssh-agent" or "key:id_ed25519". Undefined when
   * the host has never connected. UI surfaces this so the user can tell
   * whether their configured identityFile actually got used, or the
   * connection went through ssh-agent instead.
   */
  lastAuthLabel?: string;
  /** wall-clock ms when status last changed; renderer uses for "X s ago". */
  statusChangedAt: number;
}

export interface AddHostInput {
  /** Legacy form field: alias for old callers, displayName for Cindy profiles. */
  id: string;
  hostname: string;
  port?: number;
  user: string;
  authMethod?: AuthMethod;
  identityFile?: string;
}
