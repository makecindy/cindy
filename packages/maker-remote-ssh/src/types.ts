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

/**
 * `manual` remains only for older in-memory fixtures. Hosts hydrated from
 * disk always use `ssh-config`; ownership is represented independently by
 * `managedByCindy`.
 */
export type HostSource = 'ssh-config' | 'manual';

/**
 * Effective OpenSSH authentication metadata consumed by Cindy's agent path.
 *
 * `identityFile` on HostConfig remains reserved for an explicit Cindy marker:
 * a private key for `auth=key`, or an explicit agent pin for `auth=agent`.
 * Ordinary OpenSSH IdentityFile entries live here so an external host can be
 * Agent-first without accidentally reading an encrypted private key or
 * guessing a sibling `.pub` filename.
 */
export interface SshAuthenticationMetadata {
  /** Marker from the first concrete Host declaration, if Cindy wrote one. */
  marker?: AuthMethod;
  /** Effective first-value-wins IdentitiesOnly value. */
  identitiesOnly: boolean;
  /** Effective first-value-wins IdentityAgent token, before endpoint expansion. */
  identityAgent?: string;
  /** Effective explicit/default identity paths, excluding the `none` sentinel. */
  configuredIdentityFiles: string[];
  /** True when any matching IdentityFile directive appeared, including `none`. */
  identityFileDirectiveSeen: boolean;
  /** True when a matching case-insensitive IdentityFile `none` sentinel appeared. */
  identityFileNoneSeen: boolean;
  /** Ordered, de-duplicated public-key fingerprints used to filter ssh-agent. */
  allowedAgentFingerprints?: string[];
  /** Cindy subset limitation. Kept on the host so LIST succeeds; CONNECT fails. */
  unsupportedReason?: string;
}

/**
 * One remote machine known to maker. `id` doubles as the SSH alias
 * (the concrete `Host <id>` declaration discovered from OpenSSH config).
 */
export interface HostConfig {
  /** alias / unique key. Also the concrete OpenSSH `Host` name. */
  id: string;
  /** Desktop may project a local preference here; never participates in SSH lookup. */
  displayName?: string;
  hostname: string;
  port: number;
  user: string;
  authMethod: AuthMethod;
  /** Absolute key path; direct key for `key`, optional agent pin for `agent`. */
  identityFile?: string;
  /** Effective OpenSSH agent metadata; never overloaded as a private-key path. */
  sshAuthentication?: SshAuthenticationMetadata;
  source: HostSource;
  /** True only for a unique single-alias block in Cindy's managed SSH file. */
  managedByCindy: boolean;
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
  id: string;
  hostname: string;
  port?: number;
  user: string;
  authMethod?: AuthMethod;
  identityFile?: string;
}
