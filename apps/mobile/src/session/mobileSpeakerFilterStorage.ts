import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { deleteSecureItem } from '@/auth/secureStorage';

/*
 * Storage keys of "recognize my voice", kept apart from the service so sign-out
 * can clear them without loading the file system or the native module.
 */

const PREFS_PREFIX = 'cindy.mobile.voice-speaker-filter.v1.';
// SecureStore keys only allow [A-Za-z0-9._-]; the account key is hashed.
const PROFILE_PREFIX = 'xdt.voiceSpeakerProfile.v1.';
const CLEANUP_PREFIX = 'cindy.mobile.voice-speaker-filter.cleanup.v1.';
const pending = new Map<string, Promise<unknown>>();
// Also retain failures in memory if AsyncStorage cannot write the retry marker.
const pendingCleanup = new Set<string>();

function enqueue<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
  const run = (pending.get(accountKey) ?? Promise.resolve()).catch(() => undefined).then(operation);
  pending.set(accountKey, run);
  const clear = () => {
    if (pending.get(accountKey) === run) pending.delete(accountKey);
  };
  void run.then(clear, clear);
  return run;
}

/** Finish a previous sign-out's cleanup before this account can read or write again. */
export function serializeSpeakerFilterStorage<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
  return enqueue(accountKey, async () => {
    await retryAccountCleanup(accountKey);
    return operation();
  });
}

export function speakerFilterPrefsKey(accountKey: string): string {
  return PREFS_PREFIX + accountKey;
}

export function speakerProfileKey(accountKey: string): string {
  return PROFILE_PREFIX + bytesToHex(sha256(utf8ToBytes(accountKey))).slice(0, 32);
}

/**
 * Sign-out cleanup: the voiceprint and its settings are this account's
 * biometric data and leave with its other local data. The account-free
 * model files stay. The in-memory copy resets itself when the owner clears.
 */
export async function clearMobileSpeakerFilterForAccount(accountKey: string): Promise<void> {
  if (!accountKey) return;
  pendingCleanup.add(accountKey);
  await enqueue(accountKey, () => clearStoredAccount(accountKey));
}

/** Called at startup and on foreground, even while signed out. */
export async function retryPendingMobileSpeakerFilterCleanup(): Promise<void> {
  const accounts = new Set(pendingCleanup);
  const errors: unknown[] = [];
  try {
    for (const key of await AsyncStorage.getAllKeys()) {
      if (key.startsWith(CLEANUP_PREFIX) && key.length > CLEANUP_PREFIX.length) {
        accounts.add(key.slice(CLEANUP_PREFIX.length));
      }
    }
  } catch (error) {
    errors.push(error);
  }
  const results = await Promise.allSettled([...accounts].map(accountKey =>
    // Recheck inside the queue: an earlier retry may already have cleared the
    // marker and allowed a newly enrolled profile to be saved.
    enqueue(accountKey, () => retryAccountCleanup(accountKey)),
  ));
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  if (errors.length) throw new AggregateError(errors, 'Speaker filter cleanup pending');
}

async function retryAccountCleanup(accountKey: string): Promise<void> {
  if (pendingCleanup.has(accountKey) || await AsyncStorage.getItem(CLEANUP_PREFIX + accountKey) !== null) {
    await clearStoredAccount(accountKey);
  }
}

// Only called under the account queue, shared with enrollment and preferences.
async function clearStoredAccount(accountKey: string): Promise<void> {
  pendingCleanup.add(accountKey);
  const marker = CLEANUP_PREFIX + accountKey;
  // The marker contains no voiceprint. Keep trying both deletions even if the
  // disk cannot persist it; the in-memory entry still enables a later retry.
  await AsyncStorage.setItem(marker, '1').catch(() => undefined);
  const results = await Promise.allSettled([
    deleteSecureItem(speakerProfileKey(accountKey)),
    AsyncStorage.removeItem(speakerFilterPrefsKey(accountKey)),
  ]);
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Speaker filter cleanup pending');
  await AsyncStorage.removeItem(marker);
  pendingCleanup.delete(accountKey);
}
