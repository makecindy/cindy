/** Desktop-local environment checks and tool preparation. No source checkout or account required. */
export type MakeDoctorCheckId =
  'platform' | 'git' | 'gitLfs' | 'node' | 'pnpm' | 'python' | 'native' | 'storage';
export type MakeDoctorCheckStatus =
  | 'pending'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'passed'
  | 'missing'
  | 'incompatible'
  | 'failed'
  | 'warning'
  | 'cancelled';
export type MakeToolId = 'git' | 'gitLfs' | 'node' | 'pnpm' | 'python';
export type MakeDoctorReason =
  | 'detected'
  | 'unsupported'
  | 'notFound'
  | 'version'
  | 'probeFailed'
  | 'timeout'
  | 'dependency'
  | 'nativeWindows'
  | 'nativeMac'
  | 'nativeLinux'
  | 'storage'
  | 'lowDisk'
  | 'downloadFailed'
  | 'checksum'
  | 'installFailed'
  | 'busy'
  | 'cancelled';

export interface MakeDoctorCheck {
  id: MakeDoctorCheckId;
  status: MakeDoctorCheckStatus;
  reason?: MakeDoctorReason;
  version?: string;
  /** Resolved executable, never arbitrary tool output. */
  path?: string;
  freeGiB?: number;
  source?: 'system' | 'managed';
  progress?: { loaded: number; total: number | null; percent: number | null };
}

export interface MakeDoctorReport {
  runId: string;
  platform: string;
  arch: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  checks: MakeDoctorCheck[];
  mode?: 'check' | 'prepare';
  /** Dev test: ignores portable system tools and simulates missing Windows native tools. */
  forceManagedTools?: boolean;
  upstream?: MakeUpstreamQuery;
  source?: MakeSourcePreparation;
  task?: CindyMakeTaskPreparation;
}

export interface CindyMakeTaskPreparation {
  title?: string;
  request?: string;
  sessionId: string;
  originSessionId?: string;
  phase:
    'waiting' | 'environment' | 'source' | 'workspace' | 'dependencies' | 'starting' | 'completed';
  dependencies?: MakeDependencyProgress;
  /** Settings projection; preparation completion is not production completion. */
  sessionStatus?: 'active' | 'archived' | 'deleted';
  executing?: boolean;
  /** Live file comparison for Settings, never inferred from preparation or build success. */
  integration?: 'integrated' | 'unintegrated' | 'unknown';
  /** An explicitly confirmed end left cleanup unfinished; restart never replays deletion. */
  cleanupPending?: boolean;
  /** Persisted only after the task directory and branch have both been reclaimed. */
  finished?: boolean;
}

export interface MakeDependencyProgress {
  /** Absent when pnpm only emits lifecycle activity (e.g. an up-to-date install). */
  resolved?: number;
  reused?: number;
  downloaded?: number;
  added?: number;
  activity?: 'packages' | 'scripts';
}

export interface CindyMakeTaskOptions {
  agentKind?: 'cc' | 'codex' | 'pi';
  model?: string;
  effort?: string;
  providerId?: string | null;
  permissionMode?: string;
  fastMode?: boolean;
  planModeEnabled?: boolean;
}

export interface CindyMakeTaskStart {
  originSessionId?: string;
  /** Home/settings entry has no origin task before the user chooses Continue. */
  createOptions?: CindyMakeTaskOptions;
  runId: string;
  request: string;
  title: string;
}

/** Main-owned snapshots for all Cindy Make resources. Renderer only subscribes. */
export interface CindyMakeOperationSnapshot {
  active: boolean;
  report: MakeDoctorReport;
}

export const CINDY_MAKE_TASK_ERROR_CODES = [
  'busy',
  'dirty',
  'conflict',
  'cleanupFailed',
  'unavailable',
  'directoryBusy',
] as const;
export type CindyMakeTaskError = (typeof CINDY_MAKE_TASK_ERROR_CODES)[number];
export interface CindyMakeTaskActionState {
  /** Legacy finish/delete callers retain their existing semantics. */
  action: 'end' | 'finish' | 'delete';
  status: 'running' | 'failed';
  error?: CindyMakeTaskError;
}

export interface CindyMakeGlobalState {
  upstreamMerge?: import('./cindyMakeMerge').CindyMakeMergeState;
  ownerStamp?: import('./dataOwnerPush').DataOwnerPushStamp;
  environmentCheck?: CindyMakeOperationSnapshot;
  environmentPrepare?: CindyMakeOperationSnapshot;
  sourcePrepare?: CindyMakeOperationSnapshot;
  sourceClear?: CindyMakeOperationSnapshot;
  source?: MakeSourceStatus;
  reports?: Record<string, MakeDoctorReport>;
  tasks?: Record<string, MakeDoctorReport>;
  /** Live build owners only; absent after the job (including stop cleanup) settles. */
  personalBuildSessionIds?: string[];
  /** Current-owner cleanup jobs, keyed by session ID; independent of Settings lifetime. */
  taskActions?: Record<string, CindyMakeTaskActionState>;
}

export interface MakeSourcePreparation {
  status: 'pending' | 'preparing' | 'missing' | 'ready' | 'failed' | 'cancelled';
  path: string;
  channel?: 'dev' | 'beta' | 'release';
  version?: string;
  /** Upstream baseline ref (main or a version tag) that Cindy fetched. */
  ref?: string;
  /** HEAD of the managed checkout, i.e. the personal baseline branch. */
  commit?: string;
  /** Local branch holding the user's verified personal changes; every task branches from it. */
  branch?: string;
  currentBranch?: string | null;
  /** Commit of the upstream baseline ref the personal branch was created from or last updated to. */
  baseCommit?: string;
  mainCommit?: string;
  mainRemoteCommit?: string;
  mainBehind?: number;
  mainAhead?: number;
  /** Commits unique to cindy-personal / main, respectively. */
  personalBehind?: number;
  personalAhead?: number;
  error?:
    | 'unsupportedVersion'
    | 'tagNotFound'
    | 'dirty'
    | 'localCommits'
    | 'environmentNotReady'
    | 'gitUnavailable'
    | 'gitFailed'
    | 'installFailed'
    | 'locked'
    | 'cancelled';
  phase?:
    | 'waiting'
    | 'checking'
    | 'checkingRemote'
    | 'checkingLocal'
    | 'cloning'
    | 'fetching'
    | 'checkingOut'
    | 'preparingBranch'
    | 'caching'
    | 'installing';
  progress?: MakeSourceGitProgress;
  dependencies?: MakeDependencyProgress;
}

/** A per-task worktree branched from the personal baseline; the code task's working directory. */
export interface MakeTaskWorkspace {
  path: string;
  branch: string;
  /** Personal baseline commit the task branch started from. */
  baseCommit: string;
}

/** Git reports a separate percentage for each operation, not an overall download percentage. */
export interface MakeSourceGitProgress {
  stage: 'counting' | 'compressing' | 'receiving' | 'resolving' | 'checkingOut';
  percent: number;
  /** Latest sanitized Git progress line for user-visible activity feedback. */
  message?: string;
}

/** Live upstream lookup; never inferred from a cached origin/main ref or persisted on disk. */
export type MakeSourceLatestVersion = {
  channel: 'dev' | 'beta' | 'release';
} & (
  | { status: 'unavailable' }
  | { status: 'ready'; ref: string; commit: string; ahead?: number; behind?: number }
);

/** Persisted summary of the managed Cindy source checkout. */
export interface MakeSourceStatus {
  status: 'missing' | 'preparing' | 'ready' | 'failed' | 'cancelled';
  path: string;
  channel?: 'dev' | 'beta' | 'release';
  version?: string;
  ref?: string;
  commit?: string;
  branch?: string;
  currentBranch?: string | null;
  baseCommit?: string;
  mainCommit?: string;
  mainRemoteCommit?: string;
  mainBehind?: number;
  mainAhead?: number;
  /** Commits unique to cindy-personal / main, respectively. */
  personalBehind?: number;
  personalAhead?: number;
  latestVersion?: MakeSourceLatestVersion;
  error?: MakeSourcePreparation['error'];
  phase?: MakeSourcePreparation['phase'];
  progress?: MakeSourceGitProgress;
  dependencies?: MakeDependencyProgress;
}

export interface MakeUpstreamItem {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed' | 'unknown';
  kind: 'issue' | 'pr';
  htmlUrl: string;
  author?: string;
  updatedAt?: string;
  summary?: string;
  inclusion?: MakeUpstreamInclusion;
  draft?: boolean;
}

export type MakeUpstreamInclusion = 'included' | 'notIncluded' | 'unknown';

export interface MakeRuntimeVersion {
  channel: 'dev' | 'beta' | 'release';
  version: string;
  commit?: string;
  confidence: 'exact' | 'unknown';
}

export interface MakeUpstreamQuery {
  status: 'pending' | 'needsRequest' | 'searching' | 'notFound' | 'found' | 'failed' | 'cancelled';
  items: MakeUpstreamItem[];
  terms?: string[];
  runtime?: MakeRuntimeVersion;
  excludedIncluded?: number;
  hasMore?: boolean;
  failure?: 'network' | 'rateLimit' | 'timeout' | 'invalidResponse';
}

/** User's explicit choice after preparation and lookup; personal creates the code task. */
export type MakeUpstreamDecision = 'wait' | 'personal';

export function isMakeEnvironmentReady(report: MakeDoctorReport): boolean {
  return (
    MAKE_DOCTOR_CHECK_IDS.every((id) =>
      report.checks.some((check) => check.id === id && check.status === 'passed'),
    ) && report.checks.every((check) => check.status === 'passed')
  );
}

export interface MakeDoctorCommandContext {
  doctorRunId?: string;
  doctorAction?: 'cancel';
  remoteHostId?: string;
  /** Dev-only: use managed portable tools and simulate missing Windows native prerequisites. */
  forceManagedTools?: boolean;
  /** Original /cindy-make request, used only for the explicit upstream search step. */
  makeRequest?: string;
  /** Source-only operations used by Settings and historical workflow cards. */
  makeAction?: 'prepare-source' | 'clear-source';
}

export const MAKE_DOCTOR_CHECK_IDS: readonly MakeDoctorCheckId[] = [
  'platform',
  'git',
  'gitLfs',
  'node',
  'pnpm',
  'python',
  'native',
  'storage',
];
