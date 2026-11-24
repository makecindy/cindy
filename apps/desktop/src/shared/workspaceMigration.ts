export const WORKSPACE_MIGRATION_STARTUP_PROGRESS_CHANGED_CHANNEL =
  'local-db:bots:workspace-migration-startup-progress-changed';

export type WorkspaceMigrationPhase =
  | 'none'
  | 'pending'
  | 'copying'
  | 'prepared'
  | 'switching'
  | 'linked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkspaceMigrationStartupPhase =
  | 'preparing'
  | 'copying'
  | 'verifying'
  | 'switching'
  | 'cleaning';

/** Renderer-safe startup projection shown on SplashScreen during cold-start workspace migration. */
export interface WorkspaceMigrationStartupProgress {
  requestId: string;
  phase: WorkspaceMigrationStartupPhase;
  progress: number;
  copiedBytes: number;
  totalBytes: number;
  currentIndex: number;
  totalCount: number;
  startedAt: number;
  updatedAt: number;
}

export interface WorkspaceMigrationStatus {
  botId: string;
  source: string;
  workspaceAvailable: boolean;
  startupWarning?: string;
  phase: WorkspaceMigrationPhase;
  target?: string;
  error?: string;
  backupRemaining?: boolean;
  backup?: string;
  canSchedule: boolean;
}

export interface WorkspaceMigrationPreview {
  grantId: string;
  source: string;
  target: string;
  bytes: string;
  files: number;
  links: number;
}

export type WorkspaceMigrationChooseTargetResult =
  | { selected: false }
  | { selected: true; preview: WorkspaceMigrationPreview }
  | { selected: true; errorCode: string; candidateTarget?: string };

export interface WorkspaceMigrationScheduleInput {
  botId: string;
  grantId: string;
  restartNow: boolean;
}

export interface WorkspaceMigrationScheduleResult {
  status: WorkspaceMigrationStatus;
  relaunching: boolean;
}
