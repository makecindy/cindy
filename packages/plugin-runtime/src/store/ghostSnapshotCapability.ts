import type { GhostInstallReceipt } from './ghostInstallReceipt.js';
import type { GhostSnapshotParentIdentity } from './ghostSnapshotIdentity.js';
export interface GhostSnapshotMutationRequest {
  parentDir: string;
  expectedParent: GhostSnapshotParentIdentity;
  operation: 'ensure' | 'remove';
  targetName: string;
  sourceDir?: string;
  receipt?: GhostInstallReceipt;
}
export type GhostSnapshotTestMutation = (request: GhostSnapshotMutationRequest) => Promise<void>;
/** Each host must provide a separate cwd-bound worker; never mutate the host cwd. */
export async function mutateGhostSnapshotWithStableParent(_request: GhostSnapshotMutationRequest): Promise<void> {
  throw new Error('GHOST_SNAPSHOT_HOST_ADAPTER_REQUIRED');
}
