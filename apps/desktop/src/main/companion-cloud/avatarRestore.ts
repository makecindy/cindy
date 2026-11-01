/**
 * Turn a cloud companion avatar into something a local profile can store.
 *
 * A download that will never succeed must not keep the take-over demoted: other
 * devices would keep opening a task this computer cannot run. A failure that may
 * still succeed leaves the copy demoted for the next automatic attempt.
 */
import { BOT_AVATAR_MAX_BYTES, portableBotAvatarOrFallback } from '../../shared/botAvatarValue.js';
import { fetchPublicImageBytes } from '../im/publicImageFetch.js';
import { validateBotAvatarBuffer } from '../localDb/ipc/botAvatarSelection.js';
import { isUnreachable } from './types.js';

const AVATAR_FETCH_TIMEOUT_MS = 15_000;

export type RestoredCloudAvatar = { portable: string; fallback?: boolean } | { imageBase64: string };

const TRANSIENT_FETCH = /^(fetch failed|network error|terminated)$/;

/** Undici hides connect failures under `cause`, and happy-eyeballs lists one error per address family. */
function walkDownloadErrors(error: unknown, visit: (error: unknown) => boolean, depth = 0): boolean {
  if (depth > 4 || !(error instanceof Error)) return false;
  if (visit(error) || walkDownloadErrors(error.cause, visit, depth + 1)) return true;
  const nested = (error as { errors?: unknown }).errors;
  return Array.isArray(nested) && nested.some((item) => walkDownloadErrors(item, visit, depth + 1));
}

function transportMaySucceedLater(error: Error): boolean {
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message === 'OWNER_CHANGED') return true;
  if (TRANSIENT_FETCH.test(error.message)) return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^(ECONN|ENET|EAI_|ETIMEDOUT|EHOST|EPIPE|UND_ERR_)/.test(code);
}

/** Network, timeout and temporary server failures can still yield the image. A refused or invalid file cannot. */
export function avatarDownloadMaySucceedLater(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  // The guarded download reports HTTP status only on the top error. A 404 must not become
  // retryable because a nested connect error happens to carry a status-like field.
  if (isUnreachable(error)) return true;
  if (error instanceof Error) {
    const status = Number(/^remote image request failed: HTTP (\d+)$/.exec(error.message)?.[1]);
    if (status) return status >= 500 || status === 408 || status === 429;
  }
  return walkDownloadErrors(error, (nested) => nested instanceof Error && transportMaySucceedLater(nested));
}

export async function restoreCloudAvatar(avatar: string | null, signal?: AbortSignal): Promise<RestoredCloudAvatar> {
  if (!avatar?.startsWith('https://')) {
    const portable = portableBotAvatarOrFallback(avatar);
    return portable === avatar ? { portable } : { portable, fallback: true };
  }
  try {
    const { buffer } = await fetchPublicImageBytes(avatar, BOT_AVATAR_MAX_BYTES, undefined, { signal, timeoutMs: AVATAR_FETCH_TIMEOUT_MS, allowProxyFakeIp: true });
    validateBotAvatarBuffer(Buffer.from(buffer));
    return { imageBase64: Buffer.from(buffer).toString('base64') };
  } catch (error) {
    if (avatarDownloadMaySucceedLater(error, signal)) throw new Error('AVATAR_UNAVAILABLE');
    return { portable: portableBotAvatarOrFallback(null), fallback: true };
  }
}
