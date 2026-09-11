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
  /** Commit of the upstream baseline ref the personal branch was created from or last updated to. */
  baseCommit?: string;
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
  phase?: 'checking' | 'cloning' | 'fetching' | 'checkingOut' | 'preparingBranch';
  progress?: MakeSourceGitProgress;
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
}

/** Persisted summary of the managed Cindy source checkout. */
export interface MakeSourceStatus {
  status: 'missing' | 'preparing' | 'ready' | 'failed' | 'cancelled';
  path: string;
  channel?: 'dev' | 'beta' | 'release';
  version?: string;
  ref?: string;
  commit?: string;
  branch?: string;
  baseCommit?: string;
  error?: MakeSourcePreparation['error'];
  phase?: MakeSourcePreparation['phase'];
  progress?: MakeSourceGitProgress;
}

export interface MakeUpstreamItem {
  number: number;
  title: string;
  state: 'open';
  kind: 'issue' | 'pr';
  htmlUrl: string;
  author?: string;
  updatedAt?: string;
  summary?: string;
}

export interface MakeUpstreamQuery {
  status: 'pending' | 'needsRequest' | 'searching' | 'notFound' | 'found' | 'failed' | 'cancelled';
  items: MakeUpstreamItem[];
  terms?: string[];
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
