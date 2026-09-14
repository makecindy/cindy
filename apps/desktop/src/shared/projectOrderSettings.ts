import {
  parseSyncedProjectOrderSnapshot,
  type SyncedProjectOrderMode,
  type SyncedProjectOrderSnapshot,
} from '@cindy/maker-shared/project-order-sync';

export const SIDEBAR_GET_PROJECT_ORDER_CHANNEL = 'sidebar-settings:get-project-order';
export const SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL = 'sidebar-settings:apply-project-order';
export const SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL = 'sidebar-settings:project-order-changed';

export type { SyncedProjectOrderMode, SyncedProjectOrderSnapshot };

export interface ProjectOrderApplyRequest {
  manualProjectOrder: readonly string[];
  projectOrder: SyncedProjectOrderMode;
}

export function parseProjectOrderSnapshot(value: unknown): SyncedProjectOrderSnapshot {
  return parseSyncedProjectOrderSnapshot(value);
}
