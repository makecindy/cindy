import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  parseSsoOrgHistory,
  rememberSsoOrgIdentifier as mergeSsoOrgIdentifier,
  serializeSsoOrgHistory,
} from "@cindy/auth-client";

const STORAGE_KEY = "cindy.mobile.auth.sso-org-history.v1";

let cache: string[] = [];
let hydrated = false;
let hydrating: Promise<string[]> | null = null;
let writeChain: Promise<void> = Promise.resolve();

export function getSsoOrgHistorySnapshot(): string[] {
  return [...cache];
}

export function hydrateSsoOrgHistory(): Promise<string[]> {
  if (hydrated) return Promise.resolve(getSsoOrgHistorySnapshot());
  if (hydrating) return hydrating;
  hydrating = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      cache = parseSsoOrgHistory(raw);
      hydrated = true;
      return getSsoOrgHistorySnapshot();
    })
    .catch(() => {
      return getSsoOrgHistorySnapshot();
    })
    .finally(() => {
      hydrating = null;
    });
  return hydrating;
}

/** Serializes writes so concurrent successful discoveries cannot overwrite one another. */
export function rememberSsoOrgIdentifier(
  identifier: string,
): Promise<string[]> {
  let result: string[] = [];
  const operation = writeChain.then(async () => {
    await hydrateSsoOrgHistory();
    // A failed read leaves hydration retryable and must not turn an empty cache
    // into an authoritative record that overwrites previously saved entries.
    if (!hydrated) {
      result = getSsoOrgHistorySnapshot();
      return;
    }
    cache = mergeSsoOrgIdentifier(cache, identifier);
    result = getSsoOrgHistorySnapshot();
    await AsyncStorage.setItem(
      STORAGE_KEY,
      serializeSsoOrgHistory(cache),
    ).catch(() => undefined);
  });
  writeChain = operation.catch(() => undefined);
  return operation.then(() => result);
}

export const __testing = {
  storageKey: STORAGE_KEY,
  reset(): void {
    cache = [];
    hydrated = false;
    hydrating = null;
    writeChain = Promise.resolve();
  },
};
