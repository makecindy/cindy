/**
 * Cindy Make code task identity shared by Main and Renderer.
 *
 * A code task created from the /cindy-make dialog is persisted as
 * `sessions.source = 'cindy-make'`; Main derives everything else from that row
 * (the `cindy_make` MCP server, the per-turn task note, the completion card).
 * Ordinary tasks never carry the marker, even inside the same source checkout.
 */
export const CINDY_MAKE_SESSION_SOURCE = 'cindy-make' as const;

/**
 * Session-scoped `vendorOptions` marker hydrated from the persisted source at
 * every start. Scalar on purpose: queued-item sanitisation keeps only scalars.
 */
export const CINDY_MAKE_VENDOR_OPTION_KEY = 'cindyMakeSession' as const;

export const CINDY_MAKE_MCP_SERVER_NAME = 'cindy_make' as const;
export const CINDY_MAKE_REPORT_COMPLETE_TOOL = 'report_complete' as const;

export function isCindyMakeVendorOptions(
  vendorOptions: Readonly<Record<string, unknown>> | undefined | null,
): boolean {
  return vendorOptions?.[CINDY_MAKE_VENDOR_OPTION_KEY] === true;
}

/**
 * Persisted on an empty assistant row once the turn that called
 * `report_complete` has ended; Renderer derives the completion card from it.
 * Only code-verified facts: the model no longer supplies a summary.
 */
export interface CindyMakeCompletionMeta {
  reportedAt: number;
  /** Explicitly returned to editing; this completion must not replace input again. */
  continuedAt?: number;
  test?: CindyMakeTestState;
  personal?: CindyMakePersonalBuildState;
  lastAction?: 'test' | 'build';
  /** Changed files in the task workspace; absent when Git could not answer. */
  changedFiles?: number;
  /** Local task commit after completion; older records may contain a file-only base HEAD. */
  commit?: string;
  /** File-content tree, distinct from commit history. */
  tree?: string;
  /** Creation baseline, used to distinguish a completed no-op from a feature waiting for integration. */
  baseTree?: string;
  /** Task branch owning this completed change. */
  branch?: string;
}

export interface CindyMakeTestState {
  status: 'starting' | 'ready' | 'failed' | 'stopped';
  error?: 'unavailable' | 'changed' | 'environment' | 'launchFailed' | 'timeout' | 'interrupted';
}

export interface CindyMakePersonalBuildState {
  status: 'waiting' | 'checking' | 'merging' | 'packaging' | 'publishing' | 'ready' | 'failed';
  /** Optional detail within checking; old records/clients retain the broad status. */
  checkStep?: 'dependencies' | 'tests' | 'types';
  /** Cancellation is pending until owned processes and disposable outputs are cleaned. */
  stopping?: boolean;
  startedAt?: number;
  /** Verified packaged snapshot, adopted by the personal baseline on success. */
  commit?: string;
  /** File-content tree, distinct from commit history. */
  tree?: string;
  artifactDirectory?: string;
  artifactName?: string;
  sha256?: string;
  /** Complete runnable snapshot, absent on legacy installer-only builds. */
  versionId?: string;
  /** Exact feature operations captured under the source lock for this build. */
  includedFeatures?: Array<{ runId: string; operationId: string }>;
  generatedAt?: number;
  buildId?: string;
  error?:
    | 'unavailable'
    | 'changed'
    | 'environment'
    | 'missingShell'
    | 'checksFailed'
    | 'conflict'
    | 'baselineChanged'
    | 'buildFailed'
    | 'cancelled'
    | 'cleanupFailed'
    | 'interrupted';
}

/** Only known failure codes may cross from build processes or saved records into UI. */
export function parseCindyMakeBuildError(
  value: unknown,
): NonNullable<CindyMakePersonalBuildState['error']> {
  switch (value) {
    case 'unavailable':
    case 'changed':
    case 'environment':
    case 'missingShell':
    case 'checksFailed':
    case 'conflict':
    case 'baselineChanged':
    case 'interrupted':
    case 'cancelled':
    case 'cleanupFailed':
      return value;
    default:
      return 'buildFailed';
  }
}

export type CindyMakeTestAction = 'start' | 'continue' | 'status' | 'build' | 'open-build';
