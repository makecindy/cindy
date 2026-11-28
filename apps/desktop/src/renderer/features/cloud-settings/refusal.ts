import { extractIpcError } from '../../../shared/ipcError';
import { isCloudRefusal } from '../../../shared/cloudSettingsErrors';

/** The message key when CIS refused the request for a reason the owner can act on (not
 * authorized, suspended, over a limit, transferred); null for any other failure. Errors arrive
 * as IPC errors on the desktop and as plain codes in the cloud web page. */
export function cloudRefusalKey(error: unknown): string | null {
  const code = extractIpcError(error)?.code ?? (error instanceof Error ? error.message : null);
  return isCloudRefusal(code) ? `cloudSettings.refusal.${code}` : null;
}
