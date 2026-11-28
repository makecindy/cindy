/** SQLite result codes are authoritative; arbitrary error prose is not. */
export function isSqliteCorruption(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^SQLITE_CORRUPT(?:_(?:VTAB|SEQUENCE|INDEX))?$/.test(code);
}

/** Only new/unexecuted work uses NOT_SENT. Never relabel the failing operation. */
export function createCorruptDbUnavailableError(cause: unknown): Error & { code: string; cause: unknown } {
  return Object.assign(new Error('Database access stopped after SQLite corruption. Restart the application to check the database again.'), {
    code: 'DB_TRANSPORT_NOT_SENT', cause,
  });
}
