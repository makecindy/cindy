import { app } from 'electron';
import { createPiSubagentDeletion } from '@cindy/app-runtime/piSubagentDeletion';
import path from 'node:path';
export const { bindDeletedPiSubagentCleanupCancel, cancelDeletedPiSubagentCleanup, retireDeletedPiSubagentState } = createPiSubagentDeletion(() => path.join(app.getPath('userData'), 'pi-agent-home'));
