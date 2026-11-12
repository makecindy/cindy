import { parseDeviceAuthorizationUrl } from "./pluginDeviceAuthorization.js";

/**
 * Private Host/Node authorization requests. These values never belong in tool
 * results, card snapshots or ordinary device-link invokes.
 */
export type PluginAuthorizationRequest =
  | { kind: "device"; url: string; userCode?: string; expiresAt?: number }
  | { kind: "browser"; url: string; expiresAt?: number }
  | { kind: "loopback"; url: string; callbackUrl: string; state: string };

/** Additive offer, used only after both Hosts negotiate authorizationV1. */
export interface PluginAuthorizationOffer {
  kind: "authorization";
  state: string;
  request: PluginAuthorizationRequest;
}

/** Private bootstrap return, never a JSON-RPC tool result. Opened is not connected. */
export type PluginAuthorizationResult =
  | { kind: "opened" }
  | { kind: "callback"; state: string; code: string }
  | { kind: "callback"; state: string; error: string };

const fail = () => new Error("PLUGIN_AUTHORIZATION_INVALID");
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail();
  return v as Record<string, unknown>;
};
function exact(v: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw fail();
}

/** Human-entered code, not device_code or an access token. Never normalize it. */
export function parseAuthorizationUserCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,30}[A-Za-z0-9])?$/.test(value)
  )
    throw fail();
  return value;
}

function publicUrl(raw: unknown): string {
  const url = new URL(parseDeviceAuthorizationUrl(raw));
  if (url.port) throw fail();
  return url.toString();
}

/** A listener address, never an address the Host may fetch or forward a port to. */
export function parseAuthorizationCallbackUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048 || /[\x00-\x20\\]/.test(raw))
    throw fail();
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw fail();
  return url.toString();
}

export function parsePluginAuthorizationRequest(
  raw: unknown,
): PluginAuthorizationRequest {
  const v = object(raw);
  const url = publicUrl(v.url);
  if (v.kind === "device" || v.kind === "browser") {
    exact(v, [
      "kind",
      "url",
      ...(v.userCode === undefined ? [] : ["userCode"]),
      ...(v.expiresAt === undefined ? [] : ["expiresAt"]),
    ]);
    if (v.kind === "browser" && v.userCode !== undefined) throw fail();
    if (
      v.expiresAt !== undefined &&
      (!Number.isSafeInteger(v.expiresAt) || (v.expiresAt as number) <= 0)
    )
      throw fail();
    return {
      kind: v.kind,
      url,
      ...(v.userCode === undefined
        ? {}
        : { userCode: parseAuthorizationUserCode(v.userCode) }),
      ...(v.expiresAt === undefined
        ? {}
        : { expiresAt: v.expiresAt as number }),
    };
  }
  if (v.kind === "loopback") {
    exact(v, ["kind", "url", "callbackUrl", "state"]);
    if (
      typeof v.state !== "string" ||
      !/^[A-Za-z0-9._~-]{16,512}$/.test(v.state)
    )
      throw fail();
    const callbackUrl = parseAuthorizationCallbackUrl(v.callbackUrl);
    const params = new URL(url).searchParams;
    for (const key of [
      "state",
      "redirect_uri",
      "response_type",
      "client_id",
      "code_challenge",
      "code_challenge_method",
    ])
      if (params.getAll(key).length !== 1) throw fail();
    // The CLI owns the PKCE verifier and token exchange. The bridge only delivers
    // one callback; it cannot turn itself into an implicit grant or open proxy.
    if (
      params.get("state") !== v.state ||
      params.get("redirect_uri") !== callbackUrl ||
      params.get("response_type") !== "code" ||
      !params.get("client_id") ||
      params.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "")
    )
      throw fail();
    return { kind: v.kind, url, callbackUrl, state: v.state };
  }
  throw fail();
}

export function parsePluginAuthorizationOffer(
  raw: unknown,
): PluginAuthorizationOffer {
  const v = object(raw);
  exact(v, ["kind", "state", "request"]);
  if (
    v.kind !== "authorization" ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state)
  )
    throw fail();
  return {
    kind: v.kind,
    state: v.state,
    request: parsePluginAuthorizationRequest(v.request),
  };
}

export function parsePluginAuthorizationResult(
  raw: unknown,
): PluginAuthorizationResult {
  const v = object(raw);
  if (v.kind === "opened") {
    exact(v, ["kind"]);
    return { kind: "opened" };
  }
  if (
    v.kind !== "callback" ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9._~-]{16,512}$/.test(v.state)
  )
    throw fail();
  if (v.code !== undefined) {
    exact(v, ["kind", "state", "code"]);
    if (
      typeof v.code !== "string" ||
      !v.code ||
      v.code.length > 8192 ||
      /[\x00-\x1f]/.test(v.code)
    )
      throw fail();
    return { kind: v.kind, state: v.state, code: v.code };
  }
  exact(v, ["kind", "state", "error"]);
  if (typeof v.error !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(v.error))
    throw fail();
  return { kind: v.kind, state: v.state, error: v.error };
}
