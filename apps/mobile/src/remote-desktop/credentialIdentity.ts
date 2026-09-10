import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
} from "@/auth/authOwnerGeneration";
import { ensureDeviceId } from "@/auth/deviceId";
import { getActiveMobileSessionRealm } from "@/config/env";
import { remoteCredentials } from "../../modules/cindy-remote-credentials/src";

let resetBarrier: Promise<void> = Promise.resolve();
subscribeMobileAuthOwner(() => {
  // Queue reset immediately on the native Main actor, before a new configure.
  resetBarrier = remoteCredentials?.reset() ?? Promise.resolve();
  void resetBarrier.catch(() => {});
});

export async function configureCredentialIdentity(
  token: string,
): Promise<void> {
  if (!remoteCredentials) return;
  const owner = getMobileAuthOwner(),
    realm = getActiveMobileSessionRealm();
  if (!owner.accountId || (realm !== "global" && realm !== "cn"))
    throw new Error("CREDENTIAL_INVALID_IDENTITY");
  await resetBarrier;
  const authDevice = await ensureDeviceId();
  if (!isMobileAuthOwnerCurrent(owner)) throw new Error("CREDENTIAL_CANCELLED");
  await remoteCredentials.configure(realm, owner.accountId, authDevice, token);
  if (!isMobileAuthOwnerCurrent(owner)) throw new Error("CREDENTIAL_CANCELLED");
}

export async function credentialPushHeaders(
  token: string,
  method: string,
  body: unknown,
): Promise<Record<string, string>> {
  if (!remoteCredentials) return {};
  if (method !== "PUT" && method !== "DELETE")
    throw new Error("CREDENTIAL_INVALID_MESSAGE");
  if (
    body !== undefined &&
    (!body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.values(body).some((value) => typeof value !== "string"))
  )
    throw new Error("CREDENTIAL_INVALID_MESSAGE");
  const owner = getMobileAuthOwner();
  await configureCredentialIdentity(token);
  const headers = await remoteCredentials.pushHeaders(
    method,
    (body ?? {}) as Record<string, string>,
  );
  if (!isMobileAuthOwnerCurrent(owner)) throw new Error("CREDENTIAL_CANCELLED");
  return headers;
}

export function updateCredentialAccessToken(token: string | null): void {
  const owner = getMobileAuthOwner(),
    realm = getActiveMobileSessionRealm(),
    native = remoteCredentials;
  if (!token || !owner.accountId || !native) return;
  // No configuration/enrollment here: token refresh must preserve the channel.
  void resetBarrier
    .then(async () => {
      if (isMobileAuthOwnerCurrent(owner))
        await native.updateToken(realm, owner.accountId, token);
    })
    .catch(() => {});
}
