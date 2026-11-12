import * as SecureStore from "expo-secure-store";
import { accountVaultKey } from "@cindy/auth-client";
import {
  parsePluginOauthPeerIdentity,
  type PluginOauthAction,
} from "@cindy/device-link";
import type { MobileAuthOwnerGeneration } from "@/auth/authOwnerGeneration";
import { authenticateMobilePluginOauth } from "./pluginOauthClient";
import { pinMobilePluginIdentity } from "./pluginOauthPins";
import { pluginOauthPlatformCrypto } from "./pluginOauthPlatformCrypto";

/**
 * Verifies the execution computer belongs to this account, pins its identity,
 * and opens the signed v3 channel for one action. Shared by plugin setup and
 * 代输入 so both use the exact same trust path.
 */
export async function openMobilePluginOauthSession(input: {
  deviceId: string;
  peer: string;
  owner: MobileAuthOwnerGeneration;
  ghostId: string;
  action: PluginOauthAction;
  invoke(raw: unknown, cleanup?: boolean): Promise<unknown>;
  assertCurrent(): void;
}) {
  const target = parsePluginOauthPeerIdentity(
    await input.invoke({ op: "identity", version: 3 }),
  );
  input.assertCurrent();
  if (
    target.deviceId !== input.deviceId ||
    target.membershipId !== input.owner.accountId ||
    accountVaultKey(target.realm, target.membershipId) !==
      input.owner.accountKey
  )
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  return authenticateMobilePluginOauth({
    crypto: pluginOauthPlatformCrypto,
    target,
    peer: input.peer,
    ghostId: input.ghostId,
    action: input.action,
    assertCurrent: input.assertCurrent,
    invoke: input.invoke,
    trustIdentity: (identity, check) =>
      pinMobilePluginIdentity(
        {
          get: (key) => SecureStore.getItemAsync(key),
          set: (key, value) =>
            SecureStore.setItemAsync(key, value, {
              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            }),
        },
        identity,
        input.peer,
        check,
      ),
  });
}
