import { getDbClient } from '../localDb/client/current.js';
import { createSessionStorage } from '@cindy/runtime-db/sessionStorage';
export const { RuntimeSessionStorage: DesktopSessionStorage, sessionStorage: desktopSessionStorage, markSessionUsedProjectContext, readCodexHistoryHasProductPrompt, writeCodexHistoryHasProductPrompt, readSessionWorkingDirFromDb, readSessionWorkingDirRow, readSessionExtraDirsFromDb, readSessionWritableDirsFromDb, listVisibleActiveSessionDirectoryGrants } = createSessionStorage(getDbClient);
export type DesktopSessionStorage = InstanceType<typeof DesktopSessionStorage>;
