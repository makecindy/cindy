import { net, safeStorage } from "electron";
import {
  CindyAuthClient,
  AuthApiError,
  type AuthRegion,
  type AuthTokenPair,
} from "@cindy/auth-client";
import { getInstanceConfig, type InstanceAuthProtocol } from "./config.js";
import { createInstanceStore, readBootstrapFile } from "./store.js";
import { InstanceSession } from "./session.js";

let session: InstanceSession | null = null;
let sessionBaseUrl: string | null = null;
let sessionProtocol: InstanceAuthProtocol | null = null;

export function getInstanceSession(
  baseUrl: string,
  region: AuthRegion,
  hasNoLegacyCredentials: () => boolean,
): InstanceSession {
  const config = getInstanceConfig();
  if (!config) throw new Error("INSTANCE_NOT_CONFIGURED");
  if (session && sessionBaseUrl !== baseUrl)
    throw new Error("INSTANCE_AUTH_ENDPOINT_CHANGED");
  if (session && sessionProtocol !== config.authProtocol)
    throw new Error("INSTANCE_AUTH_PROTOCOL_CHANGED");
  if (!session) {
    const store = createInstanceStore(config.userDataDir, safeStorage);
    store.preflight();
    if (store.read() === null && !hasNoLegacyCredentials())
      throw new Error("INSTANCE_PROFILE_MIGRATION_REQUIRED");
    const client = new CindyAuthClient({
      baseUrl,
      region,
      deviceId: config.deviceId,
      clientType: "desktop",
      fetch: (url, init) => net.fetch(url, { ...init, redirect: "error" }),
    });
    session = new InstanceSession({
      config: {
        deviceId: config.deviceId,
        membershipId: config.membershipId,
        authProtocol: config.authProtocol,
        credentialSource: config.credentialSource,
      },
      authBaseUrl: baseUrl,
      store,
      readBootstrap: () =>
        config.bootstrapFile === null
          ? null
          : readBootstrapFile(config.bootstrapFile, config.authProtocol),
      exchange: (token) => client.refresh(token),
    });
    sessionBaseUrl = baseUrl;
    sessionProtocol = config.authProtocol;
  }
  return session;
}

export function instanceAuthReady(token: string | null): boolean {
  return session?.isReady(token) ?? false;
}

export function acknowledgeInstanceLogin(pair: AuthTokenPair): void {
  if (getInstanceConfig()) {
    if (!session) throw new Error("INSTANCE_NOT_CONFIGURED");
    session.acknowledge(pair);
  }
}

export function assertInstanceAuthMutationAllowed(pair?: AuthTokenPair): void {
  if (getInstanceConfig() && (!pair || !session?.owns(pair))) {
    throw new AuthApiError(
      "INSTANCE_AUTH_MANAGED_BY_CIS",
      403,
      "Instance identity is managed by CIS",
    );
  }
}

export function instanceLoginRequired() { return session?.needsLogin() ?? false; }
export function instanceLoginRecovered(requestId: string, credential: string) { return session?.recovered(requestId, credential) ?? false; }
