export * from '@cindy/plugin-runtime/store/ghostInstallReceipt';
import { GhostInstallReceiptStore as SharedStore } from '@cindy/plugin-runtime/store/ghostInstallReceipt';
import { mutateGhostSnapshotWithStableParent } from './ghostSnapshotCapability.js';

export class GhostInstallReceiptStore extends SharedStore {
  constructor(getRootDir: () => string, mutateSnapshot = mutateGhostSnapshotWithStableParent) {
    super(getRootDir, mutateSnapshot);
  }
}
