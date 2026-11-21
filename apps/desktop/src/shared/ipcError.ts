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

/**
 * A Cindy Host refuses with PRECONDITION_FAILED and this reason marker while a Cindy desktop app
 * running on its own uses the same data (the Host's coexistence plan A): `HOST_PROFILE_IN_USE_BY_DESKTOP`
 * while it runs, `HOST_PROFILE_IN_USE_BY_DESKTOP_AT_START` when its start was refused
 * (host-ipc-proxy.ts). Only the marker at the start of the message counts.
 */
const HOST_PROFILE_IN_USE_RE = /^(?:\[PRECONDITION_FAILED\]\s*)?HOST_PROFILE_IN_USE_BY_DESKTOP(_AT_START)?(?::|$)/;

/**
 * The i18n key for that refusal, or null for any other error. `send` words the running case for a
 * failed send ("then send again"); anything else gets "then try again".
 */
export function hostProfileInUseI18nKey(err: unknown, use: 'send' | 'other' = 'other'): string | null {
  const ipcError = extractIpcError(typeof err === 'string' ? new Error(err) : err);
  if (ipcError?.code !== 'PRECONDITION_FAILED') return null;
  const match = HOST_PROFILE_IN_USE_RE.exec(ipcError.message);
  if (!match) return null;
  if (match[1]) return 'logic.errors.hostProfileInUseByDesktopAtStart';
  return use === 'send' ? 'logic.errors.hostProfileInUseByDesktop' : 'logic.errors.hostProfileInUseByDesktopRetry';
}

export function mapIpcErrorToI18nKey(
  err: unknown,
  options?: { namespace?: string; fallback?: string },
): string {
  const held = hostProfileInUseI18nKey(err);
  if (held) return held;
  const ipcError = extractIpcError(err);
  if (!ipcError) return options?.fallback ?? 'ipcError.unknown';
  return `${options?.namespace ?? 'ipcError'}.${ipcError.code}`;
}
