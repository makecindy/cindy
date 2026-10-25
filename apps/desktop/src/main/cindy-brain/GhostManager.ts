export * from '@cindy/plugin-runtime/store/ghostManager';
import { GhostManager as SharedGhostManager, type GhostManagerOptions } from '@cindy/plugin-runtime/store/ghostManager';
import { mutateGhostSnapshotWithStableParent } from './ghostSnapshotCapability.js';
import { GhostInstallReceiptStore } from './ghostInstallReceipt.js';

/** Desktop retains its existing cwd-bound Electron worker adapter. */
export class GhostManager extends SharedGhostManager {
  constructor(options: GhostManagerOptions) {
    super({ ...options, mutateSnapshot: options.mutateSnapshot ?? mutateGhostSnapshotWithStableParent, createReceiptStore: options.createReceiptStore ?? ((root, mutate) => new GhostInstallReceiptStore(root, mutate)) });
  }
}
