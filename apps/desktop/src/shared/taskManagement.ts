/** Owner-local task housekeeping. No message content crosses this protocol. */
export const TASK_MANAGEMENT_CHANNEL = 'task-management:request';
export const TASK_MANAGEMENT_CHANGED = 'task-management:changed';
export const TASK_ARCHIVE_NOTICE = 'task-management:archived';
export const DEFAULT_TASK_ARCHIVE_SETTINGS = { enabled: false, days: 7 } as const;
export const TASK_ARCHIVE_DAY_MS = 86_400_000;
export interface TaskArchiveSettings {
  enabled: boolean;
  days: number;
}
export type TaskArchiveKeepReason =
  | 'recent'
  | 'restored'
  | 'pinned'
  | 'viewed'
  | 'draft'
  | 'running'
  | 'pending'
  | 'automation'
  | 'goal'
  | 'managed'
  | 'shared'
  | 'worktree'
  | 'unknown';
export interface TaskArchivePreview {
  candidateCount: number;
  keptCount: number;
  /** Aggregate counts only; task identities and content stay in the host. */
  lastCheckAt: number | null;
}
export interface TaskArchiveNotice {
  ownerId: string;
  batchId: string;
  count: number;
}
export interface TaskArchiveOwner {
  ownerId: string;
  ownerGeneration: number;
}
export interface TaskArchiveProtection extends TaskArchiveOwner {
  viewed: string[];
  drafts: string[];
}
export type TaskManagementRequest =
  | { operation: 'read' }
  | { operation: 'reset'; owner: TaskArchiveOwner }
  | { operation: 'update'; patch: Partial<TaskArchiveSettings>; owner: TaskArchiveOwner }
  | { operation: 'preview'; days?: number }
  | { operation: 'undo'; batchId: string; owner: TaskArchiveOwner }
  | { operation: 'protect'; value: TaskArchiveProtection };
export interface TaskManagementApi {
  read(): Promise<TaskArchiveSettings>;
  update(
    patch: Partial<TaskArchiveSettings>,
    owner: TaskArchiveOwner,
  ): Promise<TaskArchiveSettings>;
  reset(owner: TaskArchiveOwner): Promise<TaskArchiveSettings>;
  preview(days?: number): Promise<TaskArchivePreview>;
  undo(batchId: string, owner: TaskArchiveOwner): Promise<{ restored: number }>;
  protect(value: TaskArchiveProtection): Promise<void>;
  onChanged(callback: () => void): () => void;
  onArchived(callback: (notice: TaskArchiveNotice) => void): () => void;
}
