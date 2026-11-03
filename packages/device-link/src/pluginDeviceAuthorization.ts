/** Device/CLI authorization: the initiating Host polls; the controller only opens a URL. */
export interface PluginDeviceOffer {
  kind: "device";
  authorizeUrl: string;
  state: string;
  /** Private offer only; never card/message metadata. Requires deviceUserCode capability. */
  userCode?: string;
}
export interface PluginDeviceOpened {
  kind: "device-opened";
  state: string;
}
const fail = () => new Error("OAUTH_BRIDGE_UNAVAILABLE");

export function parseDeviceAuthorizationUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /[\x00-\x20\\]/.test(value)
  )
    throw fail();
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[a-z0-9.-]+$/i.test(url.hostname) ||
    !url.hostname.includes(".") ||
    /^(?:\d+\.)+\d+$/.test(url.hostname) ||
    url.hostname.endsWith(".localhost")
  )
    throw fail();
  return url.toString();
}
export function parsePluginDeviceOffer(value: unknown): PluginDeviceOffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !==
      (v.userCode === undefined
        ? "authorizeUrl,kind,state"
        : "authorizeUrl,kind,state,userCode") ||
    (v.userCode !== undefined &&
      (typeof v.userCode !== "string" ||
        !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(v.userCode))) ||
    v.kind !== "device" ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state)
  )
    throw fail();
  return {
    kind: "device",
    authorizeUrl: parseDeviceAuthorizationUrl(v.authorizeUrl),
    state: v.state,
    ...(v.userCode !== undefined ? { userCode: v.userCode as string } : {}),
  };
}
export function parsePluginDeviceOpened(
  value: unknown,
): PluginDeviceOpened | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(",") === "kind,state" &&
    v.kind === "device-opened" &&
    typeof v.state === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(v.state)
    ? { kind: "device-opened", state: v.state }
    : null;
}
