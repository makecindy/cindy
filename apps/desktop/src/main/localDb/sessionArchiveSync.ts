let requestSync: (() => void) | null = null;

/** Native storage is a projection. Failed work remains recoverable from sessions.status. */
export function setSessionArchiveSyncRequester(request: (() => void) | null): void {
  requestSync = request;
}

export function requestSessionArchiveSync(): void {
  requestSync?.();
}
