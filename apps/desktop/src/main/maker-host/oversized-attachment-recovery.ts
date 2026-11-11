import * as blobs from '../cindy-media/blobStore.desktop.js';
import * as ingest from '../cindy-media/ingest.js';
import * as journal from '../cindy-media/refCompensationJournal.desktop.js';
/** Platform assembly for the shared service. */
import { app } from 'electron';
import { createAttachmentRecoveryService } from './oversizedAttachmentRecoveryCore.js';
export const { createAttachmentRecovery } = createAttachmentRecoveryService({ getUserDataDir: () => app.getPath('userData'), media: { ...blobs, ...ingest, ...journal } });
