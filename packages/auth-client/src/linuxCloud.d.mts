interface CloudGuest {
  protocol?: "tencent-init-key-v1";
  requestId: string;
  receipt: string;
  membershipId: string;
  organizationId: string;
}
export function readCloudGuest(): Promise<CloudGuest | null>;
export function cloudGuestSaved(guest: CloudGuest): Promise<boolean>;
export function markCloudGuestSaved(guest: CloudGuest): Promise<void>;
export function cloudGuestAuthorization(
  guest: CloudGuest,
  deviceId: string,
  authBase: string,
  serviceFetch?: typeof fetch,
): Promise<{ code: string; verifier: string }>;
export function confirmCloudGuestWhenOnline(
  modelBase: () => string,
  token: () => string | null | undefined,
  serviceFetch?: typeof fetch,
): void;

export function initializeCloudHostAccess(userDataDir: string): Promise<void>;
