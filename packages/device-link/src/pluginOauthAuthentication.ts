import {
  oauthId,
  parsePluginOauthAction,
  type PluginOauthAction,
} from "./pluginOauth.js";

/** Host-only protocol. First keys use the authenticated account route; controllers persist pins after verifying the signed handshake. */
export interface PluginOauthPublicIdentity {
  version: 1;
  publicKey: string;
  bootId: string;
}
export interface PluginOauthPeerIdentity extends PluginOauthPublicIdentity {
  realm: "cn" | "global";
  deviceId: string;
  membershipId: string;
  observedAtMs: number;
  expiresAtMs: number;
}
export interface PluginOauthHello {
  op: "hello";
  version: 3;
  nonce: string;
  publicKey: string;
  action: PluginOauthAction;
}
export interface PluginOauthHelloReply {
  version: 3;
  id: string;
  publicKey: string;
  bootId: string;
  ghostId: string;
  expiresAtMs: number;
  signature: string;
}
export function oauthExact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...fields].sort().join(",")
  )
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  return value as Record<string, unknown>;
}
export const oauthNonce = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
export const oauthPublicKey = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{59}$/.test(v);
export function parsePluginOauthPublicIdentity(
  value: unknown,
): PluginOauthPublicIdentity {
  const v = oauthExact(value, ["version", "publicKey", "bootId"]);
  if (v.version !== 1 || !oauthPublicKey(v.publicKey) || !oauthId(v.bootId))
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  return v as unknown as PluginOauthPublicIdentity;
}
export function parsePluginOauthPeerIdentity(
  value: unknown,
): PluginOauthPeerIdentity {
  const v = oauthExact(value, [
    "version",
    "publicKey",
    "bootId",
    "realm",
    "deviceId",
    "membershipId",
    "observedAtMs",
    "expiresAtMs",
  ]);
  parsePluginOauthPublicIdentity({
    version: v.version,
    publicKey: v.publicKey,
    bootId: v.bootId,
  });
  if (
    ![v.deviceId, v.membershipId].every(oauthId) ||
    !["cn", "global"].includes(String(v.realm)) ||
    !Number.isSafeInteger(v.observedAtMs) ||
    !Number.isSafeInteger(v.expiresAtMs)
  )
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  return v as unknown as PluginOauthPeerIdentity;
}
export function parsePluginOauthHello(value: unknown): PluginOauthHello {
  const v = oauthExact(value, [
    "op",
    "version",
    "nonce",
    "publicKey",
    "action",
  ]);
  const action = parsePluginOauthAction(v.action);
  if (
    v.op !== "hello" ||
    v.version !== 3 ||
    !oauthNonce(v.nonce) ||
    !oauthPublicKey(v.publicKey) ||
    !action
  )
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  return { ...v, action } as unknown as PluginOauthHello;
}
export function parsePluginOauthHelloReply(
  value: unknown,
): PluginOauthHelloReply {
  const v = oauthExact(value, [
    "version",
    "id",
    "publicKey",
    "bootId",
    "ghostId",
    "expiresAtMs",
    "signature",
  ]);
  if (
    v.version !== 3 ||
    ![v.id, v.bootId, v.ghostId].every(oauthId) ||
    !oauthPublicKey(v.publicKey) ||
    !Number.isSafeInteger(v.expiresAtMs) ||
    typeof v.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(v.signature)
  )
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  return v as unknown as PluginOauthHelloReply;
}
