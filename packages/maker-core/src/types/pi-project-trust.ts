/**
 * Cindy-managed Pi project trust contract.
 *
 * This is deliberately a host-facing contract, not a Pi runtime manifest. It
 * contains no filesystem access and never writes trust.json or starts Pi.
 */

export type PiProjectTrustStatus =
  | 'approved'
  | 'unapproved'
  | 'revoked'
  | 'stale'
  | 'unavailable';

export type PiProjectTrustScope = 'working-dir' | 'repo-root';

export type PiProjectWindowsCaseComparison = 'ordinal-insensitive' | 'case-sensitive' | 'unavailable';

export type PiProjectResourceKind = 'skills' | 'settings' | 'packages' | 'extensions';

export type PiProjectResourceDisposition = 'eligible' | 'discovered' | 'blocked';

/** Canonical paths are supplied by the host's audited resolver. */
export interface PiProjectIdentityResolution {
  workingDir: string;
  /** realpath(workingDir), or null when it cannot be resolved. */
  canonicalWorkingDir: string | null;
  /** realpath(git repository root), or null when resolution failed. */
  canonicalRepoRoot: string | null;
  /** A resolved root is required; raw git output is not sufficient. */
  repoRootStatus: 'resolved' | 'unavailable';
  /** Trusted host platform semantics; callers must not infer this from a path string. */
  platform: 'posix' | 'win32';
  /** Must match the platform and round-trip without replacement; otherwise fail closed. */
  canonicalPathEncoding: 'utf8-lossless' | 'utf16-lossless' | 'unavailable';
  /** Host-provided filesystem comparison identity; required for usable win32 keys. */
  windowsCaseComparison?: PiProjectWindowsCaseComparison;
}
/**
 * Result returned by Cindy's existing project-approval authority. The
 * authority owns persistence, audit history and revocation; this package only
 * consumes its immutable snapshot.
 */
export type PiProjectApprovalSnapshot =
  | {
      status: 'approved';
      scope: PiProjectTrustScope;
      scopeKey: string;
      revision: string;
      approvedAt?: string;
    }
  | {
      status: 'revoked' | 'stale';
      scope?: PiProjectTrustScope;
      scopeKey?: string;
      revision?: string;
      reason?: string;
    }
  | {
      status: 'unapproved';
      revision?: string;
      reason?: string;
    }
  | {
      status: 'unavailable';
      revision?: string;
      reason: string;
    };

export interface PiProjectDiscoveredResources {
  skills: readonly string[];
  /** Legacy canonical skill paths are retained for additive compatibility but are not eligible evidence. */
  canonicalSkills?: readonly string[];
  /** Host evidence pairing each discovered skill path with its realpath. */
  canonicalSkillEvidence?: readonly PiProjectCanonicalPathEvidence[];
  settings: readonly string[];
  /** Host evidence pairing each discovered settings path with its realpath. */
  canonicalSettings?: readonly PiProjectCanonicalPathEvidence[];
  packages: readonly string[];
  extensions: readonly string[];
}

export interface PiProjectCanonicalPathEvidence {
  /** Exact lexical path present in the corresponding discovered array entry. */
  readonly discoveredPath: string;
  /** Host-resolved realpath used for repo-boundary checks and assembly. */
  readonly canonicalPath: string;
}

/** Capabilities proven by the pinned Pi fixture and the PR4 assembler. */
export interface PiProjectTrustCapabilities {
  /** PR4 can pass individual skill paths without enabling project trust; omitted/false is fail-closed. */
  explicitSkills: boolean;
  /** PR4 has a reviewed projection for safe project settings fields; omitted/false is fail-closed. */
  projectedSettings: boolean;
  /** Explicit hard-gate proof: project package installation is prevented. */
  packagesDisabled: boolean;
  /** Explicit hard-gate proof: project extensions are not loaded or executed. */
  extensionsDisabled: boolean;
}

export interface PiProjectSettingsValues {
  /** Pinned Pi v0.83.0 compaction thresholds; no resource-loading fields are permitted. */
  readonly compaction?: {
    readonly reserveTokens?: number;
    readonly keepRecentTokens?: number;
  };
}

/** Reviewed settings fields that PR4 may pass to Pi. Raw settings files are never eligible. */
export interface PiProjectSettingsProjection {
  /** The discovered settings source represented by this projection. */
  readonly sourcePath: string;
  /** Exact field allowlist; unknown and future Pi settings fail closed. */
  readonly values: Readonly<PiProjectSettingsValues>;
  /** Approval/discovery revision used to audit the projection, when available. */
  readonly revision?: string;
}

/** Immutable startup input supplied by the host's project-approval authority. */
export interface PiProjectTrustInputSnapshot {
  readonly identity: PiProjectIdentityResolution;
  readonly approval: PiProjectApprovalSnapshot | null;
  readonly discovered: PiProjectDiscoveredResources;
}

export interface PiProjectTrustDecision {
  status: PiProjectTrustStatus;
  /** `${canonicalRepoRoot}\0${canonicalWorkingDir}`; null when unavailable. */
  projectKey: string | null;
  canonicalWorkingDir: string | null;
  canonicalRepoRoot: string | null;
  approvalRevision: string | null;
  reason: string;
  /** Eligible inputs for PR4. None of these means Pi reported "loaded". */
  eligibleSkillPaths: readonly string[];
  /** Deprecated compatibility field; contains only the reviewed projection source path. */
  eligibleSettingsPaths: readonly string[];
  /** Reviewed settings data for PR4; null means no settings may be assembled. */
  settingsProjection: PiProjectSettingsProjection | null;
  resources: Record<PiProjectResourceKind, PiProjectResourceDisposition>;
  /** Required launch policy; assembly details remain owned by PR4. */
  launch: {
    approve: false;
    writeTrustJson: false;
    inheritUserPiHome: false;
    allowPackages: false;
    allowExtensions: false;
  };
  /** Trust inputs are startup-only; this contract conservatively requires a fresh Pi session for every decision. */
  requiresNewSession: boolean;
}
