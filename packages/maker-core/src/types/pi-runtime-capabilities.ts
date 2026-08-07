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
  error?: PiRuntimeCapabilityError;
}
