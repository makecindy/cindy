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
  /** Optional startup detail; older completions retain the broad status. */
  step?: CindyMakeTestStep;
  error?:
    | 'unavailable'
    | 'changed'
    | 'environment'
    | 'launchFailed'
    | 'timeout'
    | 'interrupted'
    | 'stopFailed';
}

export type CindyMakeTestStep =
  'waiting' | 'environment' | 'workspace' | 'stopping' | 'dependencies' | 'assets' | 'launching';

export interface CindyMakePersonalBuildState {
  status: 'waiting' | 'checking' | 'merging' | 'packaging' | 'publishing' | 'ready' | 'failed';
  /** Optional preparation detail; older clients still display waiting. */
  preparationStep?: 'environment' | 'original';
  /** Optional detail within checking; old records/clients retain the broad status. */
  checkStep?: 'dependencies' | 'tests' | 'types';
  /** Bounded, structured progress records; raw process output never crosses into the UI. */
  logs?: CindyMakeBuildLogEntry[];
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

export type CindyMakeBuildLogStep =
  | 'environment'
  | 'original'
  | 'merging'
  | 'checking-dependencies'
  | 'checking-tests'
  | 'checking-types'
  | 'packaging'
  | 'publishing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface CindyMakeBuildLogEntry {
  step: CindyMakeBuildLogStep;
  at: number;
}

const CINDY_MAKE_BUILD_LOG_STEPS = new Set<CindyMakeBuildLogStep>([
  'environment',
  'original',
  'merging',
  'checking-dependencies',
  'checking-tests',
  'checking-types',
  'packaging',
  'publishing',
  'ready',
  'failed',
  'cancelled',
]);

/** Validate persisted log entries before they cross the Main/Renderer boundary. */
export function parseCindyMakeBuildLogs(value: unknown): CindyMakeBuildLogEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const logs = value
    .filter(
      (entry): entry is { step: unknown; at: unknown } => !!entry && typeof entry === 'object',
    )
    .filter(
      (entry): entry is CindyMakeBuildLogEntry =>
        typeof entry.step === 'string' &&
        CINDY_MAKE_BUILD_LOG_STEPS.has(entry.step as CindyMakeBuildLogStep) &&
        typeof entry.at === 'number' &&
        Number.isFinite(entry.at),
    )
    .map((entry) => ({ step: entry.step, at: entry.at }))
    .slice(-80);
  return logs.length ? logs : undefined;
}

/** Add one stable, localizable entry when a build crosses a visible stage. */
export function appendCindyMakeBuildLog(
  previous: CindyMakePersonalBuildState | undefined,
  next: CindyMakePersonalBuildState,
  at = Date.now(),
): CindyMakePersonalBuildState {
  const step: CindyMakeBuildLogStep | undefined =
    next.status === 'waiting'
      ? next.preparationStep
      : next.status === 'checking'
        ? next.checkStep
          ? (('checking-' + next.checkStep) as CindyMakeBuildLogStep)
          : 'checking-dependencies'
        : next.status === 'failed'
          ? next.error === 'cancelled'
            ? 'cancelled'
            : 'failed'
          : next.status;
  if (!step) return next;
  const logs = previous?.logs ?? next.logs ?? [];
  if (logs.at(-1)?.step === step) return { ...next, logs };
  return {
    ...next,
    logs: [...logs, { step, at }].slice(-80),
  };
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
