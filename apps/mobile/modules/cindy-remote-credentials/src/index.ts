import { requireOptionalNativeModule } from "expo-modules-core";

/** No password argument/getter: the native module owns entry and vault access. */
export interface RemoteCredentialsNative {
  savedUnlockSettings?(
    realm: string,
    membership: string,
    authDevice: string,
    target: string,
  ): Promise<{
    autoUnlock: boolean;
    biometricVerification: boolean;
    biometricAvailable?: boolean;
    biometricPreferred?: boolean;
  }>;
  forgetSavedUnlock?(
    realm: string,
    membership: string,
    authDevice: string,
    target: string,
  ): Promise<void>;
  setSavedUnlockBiometric?(
    realm: string,
    membership: string,
    authDevice: string,
    target: string,
    enabled: boolean,
    locale: string,
  ): Promise<void>;
  beginUnlock?(
    target: string,
    setup: boolean,
    biometric: boolean,
    descriptor: string,
  ): Promise<{ handle: string; offer: string; descriptor: string }>;
  configure(
    realm: "global" | "cn",
    membership: string,
    authDevice: string,
    token: string,
  ): Promise<string>;
  updateToken(realm: string, membership: string, token: string): Promise<void>;
  relayHeaders(): Promise<Record<string, string>>;
  pushHeaders(
    method: "PUT" | "DELETE",
    body: Record<string, string>,
  ): Promise<Record<string, string>>;
  begin(target: string): Promise<{ handle: string; offer: string }>;
  accept(handle: string, offer: string): Promise<string>;
  receive(handle: string, ciphertext: string): Promise<string>;
  password(
    handle: string,
    useSaved: boolean,
    locale: string,
    theme: "light" | "dark",
  ): Promise<string>;
  authenticationStatus(handle: string): Promise<string>;
  request(
    handle: string,
    body: string,
  ): Promise<{ id: string; ciphertext: string }>;
  abandonRequest(handle: string, id: string): Promise<void>;
  forget(handle: string): Promise<void>;
  end(handle: string): Promise<string | null>;
  close(handle: string): Promise<void>;
  reset(): Promise<void>;
  addListener(
    event: "invalidated",
    listener: (event: { handle: string }) => void,
  ): { remove(): void };
}

export const remoteCredentials =
  requireOptionalNativeModule<RemoteCredentialsNative>(
    "CindyRemoteCredentials",
  );
