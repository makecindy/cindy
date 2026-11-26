import path from "node:path";

export type InstanceAuthProtocol = "instance-v1" | "resource-v1";
export type InstanceCredentialSource = "bootstrap" | "canonical";

export interface InstanceConfig {
  deviceId: string;
  membershipId: string;
  authProtocol: InstanceAuthProtocol;
  credentialSource: InstanceCredentialSource;
  deviceName: string;
  userDataDir: string;
  bootstrapFile: string | null;
  keyringPasswordFile: string;
  endpointFile: string;
  statusFile: string;
}

let current: InstanceConfig | null = null;

export function resolveInstanceConfig(
  argv: string[],
  env: NodeJS.ProcessEnv,
  platform: string,
): InstanceConfig | null {
  if (!argv.includes("--cloud-instance")) return null;
  if (platform !== "linux") throw new Error("INSTANCE_PLATFORM_INVALID");
  const required = (name: string): string => {
    const value = env[name];
    if (!value || value !== value.trim())
      throw new Error("INSTANCE_CONFIG_INCOMPLETE");
    return value;
  };
  const location = (name: string, expected: string): string => {
    const value = required(name);
    if (!path.isAbsolute(value) || value !== expected)
      throw new Error("INSTANCE_PATH_INVALID");
    return value;
  };
  const deviceId = required("CINDY_POD_DEVICE_ID");
  const membershipId = required("CINDY_POD_MEMBERSHIP_ID");
  const deviceName = required("CINDY_POD_DEVICE_NAME");
  const authProtocol = env.CINDY_POD_AUTH_PROTOCOL ?? "instance-v1";
  if (authProtocol !== "instance-v1" && authProtocol !== "resource-v1")
    throw new Error("INSTANCE_AUTH_PROTOCOL_INVALID");
  const credentialSource = env.CINDY_POD_CREDENTIAL_SOURCE ?? "bootstrap";
  if (
    !["bootstrap", "canonical"].includes(credentialSource) ||
    (credentialSource === "canonical" &&
      (authProtocol !== "resource-v1" ||
        env.CINDY_POD_RESOURCE_REFRESH_TOKEN_FILE !== undefined))
  )
    throw new Error("INSTANCE_CREDENTIAL_SOURCE_INVALID");
  if (
    !/^cloud-device-[a-f0-9]{24}$/.test(deviceId) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(membershipId) ||
    deviceName.length > 128 ||
    // eslint-disable-next-line no-control-regex
    /[\r\n\x00]/.test(deviceName)
  ) {
    throw new Error("INSTANCE_IDENTITY_INVALID");
  }
  if (
    env.XDT_ENDPOINTS_CDN === "1" ||
    env.XDT_ISOLATED === "1" ||
    argv.some((arg) => arg === "--no-sandbox" || arg.startsWith("--isolated"))
  ) {
    throw new Error("INSTANCE_OVERRIDE_FORBIDDEN");
  }
  return {
    deviceId,
    membershipId,
    authProtocol,
    credentialSource: credentialSource as InstanceCredentialSource,
    deviceName,
    userDataDir: location("XDT_USER_DATA_DIR", "/var/lib/cindy/user-data"),
    bootstrapFile:
      credentialSource === "canonical"
        ? null
        : location(
            "CINDY_POD_RESOURCE_REFRESH_TOKEN_FILE",
            "/run/secrets/resource-refresh-token",
          ),
    keyringPasswordFile: location(
      "CINDY_POD_KEYRING_PASSWORD_FILE",
      "/run/secrets/credential-store-key",
    ),
    endpointFile: location(
      "XDT_ENDPOINT_MANIFEST_FILE",
      "/run/config/endpoint.json",
    ),
    statusFile: location(
      "CINDY_CLOUD_STATUS_FILE",
      "/var/lib/cindy/status/status.json",
    ),
  };
}

export function initializeInstanceConfig(): InstanceConfig | null {
  current = resolveInstanceConfig(process.argv, process.env, process.platform);
  return current;
}

export function getInstanceConfig(): InstanceConfig | null {
  return current;
}

export function instanceRefreshDelay(token: string, now = Date.now()): number {
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  const lifetime = (payload.exp - payload.iat) * 1000;
  if (!Number.isFinite(lifetime) || lifetime <= 0)
    throw new Error("INSTANCE_TOKEN_INVALID");
  return Math.max(
    1_000,
    payload.exp * 1000 - now - Math.min(300_000, lifetime / 5),
  );
}
