/** Additive envelope in the existing remote-desktop invoke channel. */
export type RemoteCredentialRequest =
  | {
      op: "credential";
      version: 1;
      kind: "open";
      offer: string;
      descriptor?: string;
    }
  | {
      op: "credential";
      version: 1;
      kind: "exchange";
      handle: string;
      ciphertext: string;
    };

export function parseRemoteCredentialRequest(
  value: unknown,
): RemoteCredentialRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DESKTOP_AUTHENTICATION_REQUIRED");
  const v = value as Record<string, unknown>;
  if (v.op !== "credential" || v.version !== 1)
    throw new Error("DESKTOP_AUTHENTICATION_REQUIRED");
  if (
    v.kind === "open" &&
    typeof v.offer === "string" &&
    v.offer.length > 0 &&
    v.offer.length <= 4096
  ) {
    if (
      v.descriptor !== undefined &&
      (typeof v.descriptor !== "string" ||
        !v.descriptor ||
        v.descriptor.length > 4096)
    )
      throw new Error("CREDENTIAL_INVALID_MESSAGE");
    return {
      op: "credential",
      version: 1,
      kind: "open",
      offer: v.offer,
      ...(typeof v.descriptor === "string" ? { descriptor: v.descriptor } : {}),
    };
  }
  if (
    v.kind === "exchange" &&
    typeof v.handle === "string" &&
    /^[0-9a-f-]{36}$/.test(v.handle) &&
    typeof v.ciphertext === "string" &&
    v.ciphertext.length > 0 &&
    v.ciphertext.length <= 2 * 1024 * 1024
  ) {
    return {
      op: "credential",
      version: 1,
      kind: "exchange",
      handle: v.handle,
      ciphertext: v.ciphertext,
    };
  }
  throw new Error("CREDENTIAL_INVALID_MESSAGE");
}
