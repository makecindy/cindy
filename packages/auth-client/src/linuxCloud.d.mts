interface CloudGuest {
  protocol?: "tencent-init-key-v1";
  requestId: string;
  receipt: string;
  membershipId: string;
  organizationId: string;
}
interface CloudGuestCredentialStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  withLock<T>(task: () => Promise<T>): Promise<T>;
}
export function readCloudGuest(): Promise<CloudGuest | null>;
export function cloudGuestSaved(guest: CloudGuest): Promise<boolean>;
export function markCloudGuestSaved(guest: CloudGuest, store: CloudGuestCredentialStore): Promise<void>;
export function cloudGuestAuthorization(
  guest: CloudGuest,
  deviceId: string,
  authBase: string,
  store: CloudGuestCredentialStore,
  serviceFetch?: typeof fetch,
  options?: { persistent?: boolean; stopped?: () => boolean },
): Promise<{ code: string; verifier: string }>;
export function cloudGuestFailureReason(error: unknown): {
  reason: "refused" | "unavailable" | "stopped" | "timeout" | "failed";
  status?: number;
};
export function confirmCloudGuestWhenOnline(
  modelBase: () => string,
  token: () => string | null | undefined,
  serviceFetch?: typeof fetch,
): void;

export function initializeCloudHostAccess(userDataDir: string): Promise<void>;
