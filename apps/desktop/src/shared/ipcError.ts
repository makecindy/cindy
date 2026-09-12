import { isIpcError, isIpcErrorCode, type IpcError } from './ipc-errors';

const IPC_ERROR_MESSAGE_RE = /(?:^|: Error: )\[([A-Z0-9_]+)\]\s*([\s\S]*)$/;

export function extractIpcError(err: unknown): IpcError | null {
  if (isIpcError(err)) {
    return { code: err.code, message: err.message };
  }
  if (!(err instanceof Error)) return null;
  const match = IPC_ERROR_MESSAGE_RE.exec(err.message);
  if (!match) return null;
  const code = match[1];
  if (!isIpcErrorCode(code)) return null;
  return { code, message: match[2] };
}

export function mapIpcErrorToI18nKey(
  err: unknown,
  options?: { namespace?: string; fallback?: string },
): string {
  const ipcError = extractIpcError(err);
  if (!ipcError) return options?.fallback ?? 'ipcError.unknown';
  return `${options?.namespace ?? 'ipcError'}.${ipcError.code}`;
}
