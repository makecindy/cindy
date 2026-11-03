import { oauthUtf8Bytes } from "./pluginOauthCrypto";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { PluginOauthPeerIdentity } from "@cindy/device-link";

type PinStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};
const pending = new Map<string, Promise<void>>();
/** Native secure storage only. A changed pin can never be approved by an authorization card. */
export async function pinMobilePluginIdentity(
  store: PinStore,
  identity: PluginOauthPeerIdentity,
  localDeviceId: string,
  assertCurrent: () => void,
): Promise<void> {
  const scope = JSON.stringify([
    identity.realm,
    identity.membershipId,
    localDeviceId,
    identity.deviceId,
  ]);
  const key = `cindy.pluginOauthIdentity.v1.${bytesToHex(sha256(oauthUtf8Bytes(scope)))}`;
  const previousOperation = pending.get(key) ?? Promise.resolve();
  const operation = previousOperation
    .catch(() => {})
    .then(async () => {
      assertCurrent();
      const previous = await store.get(key); // A failed read is never an empty pin.
      assertCurrent();
      if (previous !== null) {
        if (previous !== identity.publicKey)
          throw new Error("PLUGIN_AUTHORIZATION_IDENTITY_CHANGED");
        return;
      }
      await store.set(key, identity.publicKey);
      assertCurrent();
    });
  pending.set(key, operation);
  try {
    await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
}
