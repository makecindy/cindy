


export function createSessionArchiveSync() {

let requestSync: (() => void) | null = null;

/** Native storage is a projection. Failed work remains recoverable from sessions.status. */
function setSessionArchiveSyncRequester(request: (() => void) | null): void {
  requestSync = request;
}

function requestSessionArchiveSync(): void {
  requestSync?.();
}
return {
  setSessionArchiveSyncRequester,
  requestSessionArchiveSync
};
}
