import {createSessionArchiveSync} from '@cindy/app-runtime/sessionArchiveSync';
export type * from '@cindy/app-runtime/sessionArchiveSync';

export const {setSessionArchiveSyncRequester, requestSessionArchiveSync}=createSessionArchiveSync();
