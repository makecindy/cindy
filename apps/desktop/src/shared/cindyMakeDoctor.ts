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

/** A view-only choice until source preparation is implemented. Never authorizes a build. */
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
