/** Local Desktop worker project selection. Never sent through device-link. */
export interface WorkerWorktreeRequest {
  sourceBranch: string;
}
/** Metadata registered under the Worker session, never inferred from its cwd. */
export interface WorkerOwnedWorktree {
  path: string;
  branch: string;
}
export interface WorkerProjectInfo {
  directory: string;
  baseRepo: string | null;
  branch: string | null;
  /** Main-process HEAD probe; branch retains the full commit ID when detached. */
  headState?: 'branch' | 'detached' | 'unborn';
  exists: boolean;
  dirty: boolean;
  isWorktree: boolean;
  /** Checkout root name, even when telemetry points into a subdirectory. */
  worktreeName?: string;
}
export interface WorkerProjectContext {
  recordedDirectory: string;
  inherited: WorkerProjectInfo;
  selected: WorkerProjectInfo;
  dialogue: boolean;
  projects: Array<{ path: string; name: string; description: string; missing: boolean }>;
}

/** Actual revision used to create a Worker checkout, including a rejected preference. */
export interface WorkerWorktreeSourceSelection {
  sourceBranch: string;
  source: 'memory' | 'current' | 'explicit';
  fallbackReason?: string;
}
