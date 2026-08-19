/**
 * Pi runtime capability facts.
 *
 * This is deliberately separate from customization discovery: a filesystem
 * scanner can report `discovered`, while only Pi's `get_commands` response can
 * report `loaded`.
 */

export type PiRuntimeCapabilityStatus =
  | 'discovered'
  | 'approved'
  | 'loaded'
  | 'failed'
  | 'unknown';

export type PiRuntimeCapabilitySource = 'pi:get_commands';

export type PiRuntimeCapabilityErrorStage = 'ready' | 'switch_session' | 'fork';

export interface PiRuntimeCapabilityError {
  stage: PiRuntimeCapabilityErrorStage;
  code:
    | 'unsupported'
    | 'timeout'
    | 'process_unavailable'
    | 'rpc_failed'
    | 'malformed_response';
  /** Bounded, provider/auth/path-redacted diagnostic text. */
  message: string;
}

/** Stable provenance fields exposed by Pi's command catalog. */
export interface PiRuntimeCommandSourceInfo {
  path?: string;
  scope?: string;
  baseDir?: string;
  source?: string;
  origin?: string;
}

export interface PiRuntimeCommand {
  name: string;
  description?: string;
  source: string;
  sourceInfo: PiRuntimeCommandSourceInfo;
}

/** Launch-time Cindy-managed skill snapshot for one Pi runtime. */
export interface PiManagedPackageSkillRuntimeSnapshot {
  sourcePath: string;
  name: string;
  description?: string;
  /** Present only when this session's get_commands proves the skill loaded. */
  runtimeCommandName?: string;
}

/** Startup-only Cindy approval/assembly fact for this isolated Pi runtime. */
export interface PiProjectResourceRuntimeDiagnostic {
  status: import('./pi-project-trust.js').PiProjectTrustStatus;
  reason: string;
  approvalRevision: string | null;
  requestedSkillCount: number;
  /** Present only when this session's get_commands returned a valid catalog. */
  loadedSkillCount?: number;
  /** Exact source↔snapshot mappings confirmed by this session's get_commands. */
  loadedSkills?: readonly {
    sourcePath: string;
    runtimePath: string;
    commandName: string;
    /** Present for PR4 immutable project snapshots; absent only on older manifests. */
    snapshotDigest?: string;
    /** Launch-time source-tree identity; current sessions require it before reporting loaded. */
    sourceFingerprint?: string;
    /** Approval-time boundary used to fingerprint the current source fail closed. */
    canonicalRepoRoot?: string;
  }[];
}

/**
 * Per-session runtime catalog snapshot. All fields are optional at call sites
 * through the AgentSessionHandle contract, so old consumers remain compatible.
 */
export interface PiRuntimeCapabilityManifest {
  /** Existing Cindy business session key, when the caller supplied one. */
  sessionId?: string;
  /** Existing Pi SDK/session file key; no new cross-layer identity is created. */
  sdkSessionId?: string;
  capturedAt: string;
  generation: number;
  status: PiRuntimeCapabilityStatus;
  source: PiRuntimeCapabilitySource;
  commands: readonly PiRuntimeCommand[];
  /** Commands whose get_commands provenance resolves inside an enabled Cindy-managed Pi package. */
  managedPackageCommandNames?: readonly string[];
  /** Exact managed skills passed to this runtime at launch; never re-read from the global store. */
  managedPackageSkills?: readonly PiManagedPackageSkillRuntimeSnapshot[];
  error?: PiRuntimeCapabilityError;
  /** Does not imply loaded; only `commands` from this session's get_commands can do that. */
  projectResources?: PiProjectResourceRuntimeDiagnostic;
}
