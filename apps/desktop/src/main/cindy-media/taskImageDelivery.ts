import { createTaskImageDelivery } from '@cindy/app-runtime/taskImageDelivery';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { ingestMedia } from './ingest';
import * as ledger from './ledger';
import * as journal from './refCompensationJournal';
export { claudeScratchpadTempBase, claudeScratchpadPath, taskImageRoots, readTaskImage } from '@cindy/media-core/task-image-source';
export const { materializeTaskImageText, materializeTaskImageTextResult, restoreTaskImageRows } = createTaskImageDelivery({
  getCurrentDbClientSnapshot: () => getCurrentDbClientSnapshot(),
  ingestMedia: (...args) => ingestMedia(...args),
  ledger: {
    hasRef: (...args) => ledger.hasRef(...args),
    removeRefById: (...args) => ledger.removeRefById(...args),
    withSessionMediaRefLock: (...args) => ledger.withSessionMediaRefLock(...args),
  },
  journal: {
    captureMediaRefCompensationScope: (...args) => journal.captureMediaRefCompensationScope(...args),
    withMediaRefCompensation: (...args) => journal.withMediaRefCompensation(...args),
  },
});
