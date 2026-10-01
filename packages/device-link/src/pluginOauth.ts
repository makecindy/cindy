/** Host-to-Host OAuth control only. Never expose its replies to a Renderer. */
export const PLUGIN_OAUTH_CHANNEL = "device-link:plugin-oauth:v3";
export const PLUGIN_OAUTH_LOCAL_CHANNEL = "plugin-oauth:assist";
export const PLUGIN_OAUTH_TTL_MS = 5 * 60_000;

export interface PluginOauthAction {
  requestId: string;
  actionId: string;
  expectedRevision: number;
}

export type PluginOauthRequest =
  | { op: "capabilities" }
  | ({
      op: "start";
      publicKey: string;
      deviceUserCode?: true;
      authorizationV1?: true;
      secretSubmission?: true;
      connectionSubmission?: true;
    } & PluginOauthAction)
  | { op: "status"; id: string }
  | { op: "cancel"; id: string }
  | { op: "callback"; id: string; box: string };

export type PluginOauthPhase =
  | "starting"
  | "authorizing"
  | "exchanging"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface PluginOauthOffer {
  authorizeUrl: string;
  callbackUrl: string;
  state: string;
  corsOrigins: string[];
  corsHosts: string[];
}
export type PluginOauthCallback =
  { state: string; code: string } | { state: string; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(v: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
export function oauthId(v: unknown): v is string {
  return typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
}
export function parsePluginOauthAction(
  value: unknown,
): PluginOauthAction | null {
  if (
    !record(value) ||
    !exact(value, ["requestId", "actionId", "expectedRevision"]) ||
    !oauthId(value.requestId) ||
    typeof value.actionId !== "string" ||
    !value.actionId ||
    value.actionId.length > 256 ||
    /[\x00-\x1f]/.test(value.actionId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  )
    return null;
  return {
    requestId: value.requestId,
    actionId: value.actionId,
    expectedRevision: value.expectedRevision as number,
  };
}
export function parsePluginOauthRequest(
  value: unknown,
): PluginOauthRequest | null {
  if (!record(value)) return null;
  if (value.op === "capabilities" && exact(value, ["op"]))
    return { op: value.op };
  if (
    value.op === "start" &&
    exact(value, [
      "op",
      "publicKey",
      "requestId",
      "actionId",
      "expectedRevision",
      ...(value.deviceUserCode === true ? ["deviceUserCode"] : []),
      ...(value.authorizationV1 === true ? ["authorizationV1"] : []),
      ...(value.secretSubmission === true ? ["secretSubmission"] : []),
      ...(value.connectionSubmission === true ? ["connectionSubmission"] : []),
    ])
  ) {
    const action = parsePluginOauthAction({
      requestId: value.requestId,
      actionId: value.actionId,
      expectedRevision: value.expectedRevision,
    });
    if (
      action &&
      typeof value.publicKey === "string" &&
      /^[A-Za-z0-9_-]{59}$/.test(value.publicKey)
    )
      return {
        op: "start",
        publicKey: value.publicKey,
        ...action,
        ...(value.deviceUserCode === true ? { deviceUserCode: true } : {}),
        ...(value.authorizationV1 === true ? { authorizationV1: true } : {}),
        ...(value.secretSubmission === true ? { secretSubmission: true } : {}),
        ...(value.connectionSubmission === true
          ? { connectionSubmission: true }
          : {}),
      };
  }
  if (
    (value.op === "status" || value.op === "cancel") &&
    exact(value, ["op", "id"]) &&
    oauthId(value.id)
  )
    return { op: value.op, id: value.id };
  if (
    value.op === "callback" &&
    exact(value, ["op", "id", "box"]) &&
    oauthId(value.id) &&
    typeof value.box === "string" &&
    /^[A-Za-z0-9_-]{40,48000}$/.test(value.box)
  )
    return { op: value.op, id: value.id, box: value.box };
  return null;
}
export function parsePluginOauthCallback(
  value: unknown,
): PluginOauthCallback | null {
  if (
    !record(value) ||
    typeof value.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.state)
  )
    return null;
  if (
    exact(value, ["state", "code"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    value.code.length <= 8192 &&
    !/[\x00-\x1f]/.test(value.code)
  )
    return { state: value.state, code: value.code };
  if (
    exact(value, ["state", "error"]) &&
    typeof value.error === "string" &&
    /^[a-zA-Z0-9_.-]{1,128}$/.test(value.error)
  )
    return { state: value.state, error: value.error };
  return null;
}
