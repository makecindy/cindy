/**
 * Interface preferences that live in this window's localStorage. Only the shared whitelist
 * (theme, language, notifications, chat preferences…) is read for another computer or
 * written from one; window layout, device pickers and model memories never move.
 */
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { isPortableRendererPrefKey } from '../../../shared/setupMigration';

const MAX_VALUE_LENGTH = 32 * 1024;
const USER_PROMPT_KEY_PREFIX = 'userPrompt.value.';

/**
 * The personal prompt is kept per account in this storage, and accounts that once signed in
 * here keep theirs. Only the signed-in account's own prompt moves.
 */
function isMovablePrefKey(key: string, ownerId: string | null): boolean {
  if (!isPortableRendererPrefKey(key)) return false;
  if (!key.startsWith(USER_PROMPT_KEY_PREFIX)) return true;
  return ownerId !== null && key === `${USER_PROMPT_KEY_PREFIX}${ownerId}`;
}

export function readPortableRendererPrefs(
  storage: Storage = window.localStorage,
  ownerId: string | null = getDataOwnerGeneration().dataOwnerId,
): Record<string, string> {
  const prefs: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isMovablePrefKey(key, ownerId)) continue;
    const value = storage.getItem(key);
    if (value !== null && value.length <= MAX_VALUE_LENGTH) prefs[key] = value;
  }
  return prefs;
}

/**
 * Writes the selected values this computer has not set itself; a preference already chosen
 * here (before or after the preview) is kept. Returns how many were written.
 */
export function applyPortableRendererPrefs(
  values: Record<string, string>,
  storage: Storage = window.localStorage,
  ownerId: string | null = getDataOwnerGeneration().dataOwnerId,
): number {
  let changed = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!isMovablePrefKey(key, ownerId) || typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) continue;
    if (storage.getItem(key) !== null) continue;
    storage.setItem(key, value);
    changed += 1;
  }
  return changed;
}
