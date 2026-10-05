import {
  PLUGIN_OAUTH_TTL_MS,
  oauthExact,
  oauthId,
  oauthPublicKey,
  parsePluginSecretOffer,
  parsePluginSecretInput,
  parsePluginConnectionOffer,
  parsePluginConnectionInput,
  parsePluginAuthorizationOffer,
  parsePluginDeviceOffer,
  type PluginOauthRequest,
  type PluginOauthAction,
  type PluginSecretPresentation,
  type PluginConnectionPresentation,
} from "@cindy/device-link";
import { MobileOauthBox, type PluginOauthCrypto } from "./pluginOauthCrypto";
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  return v as Record<string, unknown>;
};
/** Presentation/inputs remain in a dedicated native form. The execution Host owns exchange, vault save and result. */
export async function runMobilePluginAuthorization(deps: {
  crypto: PluginOauthCrypto;
  invoke(request: PluginOauthRequest): Promise<unknown>;
  action: PluginOauthAction;
  kind: "oauth" | "secret" | "connection";
  secretPresentation?: PluginSecretPresentation;
  connectionPresentation?: PluginConnectionPresentation;
  inputSecret?: string;
  inputConnection?: { host: string; token: string };
  showAuthorization(
    url: string,
    code: string | undefined,
    expiresAt: number,
  ): Promise<void>;
  clearInput(): void;
  assertCurrent(): void;
  pause(): Promise<void>;
  now?(): number;
}): Promise<void> {
  const now = deps.now ?? Date.now,
    deadline = now() + PLUGIN_OAUTH_TTL_MS,
    key = new MobileOauthBox(deps.crypto);
  let id: string | undefined,
    finished = false;
  try {
    deps.assertCurrent();
    const caps = object(await deps.invoke({ op: "capabilities" }));
    if (
      caps.version !== 1 ||
      caps.encrypted !== true ||
      caps.callback !== "desktop-loopback" ||
      (deps.kind === "secret" && caps.secretSubmission !== true) ||
      (deps.kind === "connection" && caps.connectionSubmission !== true)
    )
      throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
    deps.assertCurrent();
    const start = object(
      await deps.invoke({
        op: "start",
        ...deps.action,
        publicKey: key.publicKey,
        ...(caps.deviceUserCode === true
          ? { deviceUserCode: true as const }
          : {}),
        ...(caps.authorizationV1 === true
          ? { authorizationV1: true as const }
          : {}),
        ...(deps.kind === "secret" ? { secretSubmission: true as const } : {}),
        ...(deps.kind === "connection"
          ? { connectionSubmission: true as const }
          : {}),
      }),
    );
    if (!oauthId(start.id) || !oauthPublicKey(start.publicKey))
      throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
    id = start.id;
    const peerKey = start.publicKey;
    let opened = false;
    const deliver = async (value: unknown) => {
      deps.assertCurrent();
      const box = await key.seal(peerKey, id!, "callback", value);
      deps.clearInput();
      deps.inputSecret = undefined;
      deps.inputConnection = undefined;
      deps.assertCurrent();
      const result = object(
        await deps.invoke({ op: "callback", id: id!, box }),
      );
      if (result.accepted !== true) throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
    };
    while (now() < deadline) {
      await deps.pause();
      deps.assertCurrent();
      const status = object(await deps.invoke({ op: "status", id }));
      deps.assertCurrent();
      if (status.phase === "succeeded") {
        finished = true;
        return;
      }
      if (
        !["starting", "authorizing", "exchanging"].includes(
          String(status.phase),
        )
      )
        throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
      if (status.phase !== "authorizing" || opened) continue;
      if (typeof status.offer !== "string")
        throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
      const raw = object(await key.open(peerKey, id, "offer", status.offer));
      if (deps.kind === "secret") {
        const offer = parsePluginSecretOffer(raw);
        if (
          JSON.stringify(offer.presentation) !==
          JSON.stringify(deps.secretPresentation)
        )
          throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
        const value = parsePluginSecretInput(deps.inputSecret);
        if (value.length > offer.presentation.maxLength)
          throw new Error("PLUGIN_SECRET_UNAVAILABLE");
        await deliver({ kind: "secret-value", state: offer.state, value });
      } else if (deps.kind === "connection") {
        const offer = parsePluginConnectionOffer(raw);
        if (
          JSON.stringify(offer.presentation) !==
          JSON.stringify(deps.connectionPresentation)
        )
          throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
        await deliver({
          kind: "connection-value",
          state: offer.state,
          value: parsePluginConnectionInput(deps.inputConnection),
        });
      } else if (raw.kind === "authorization") {
        if (caps.authorizationV1 !== true)
          throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
        const offer = parsePluginAuthorizationOffer(raw);
        // A computer loopback callback cannot be reinterpreted as the phone's localhost.
        if (offer.request.kind === "loopback")
          throw new Error("PLUGIN_AUTHORIZATION_COMPUTER_CALLBACK");
        await deps.showAuthorization(
          offer.request.url,
          offer.request.kind === "device" ? offer.request.userCode : undefined,
          Math.min(deadline, offer.request.expiresAt ?? deadline),
        );
        await deliver({ kind: "device-opened", state: offer.state });
      } else if (raw.kind === "device") {
        if (caps.deviceAuthorization !== true)
          throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
        const offer = parsePluginDeviceOffer(raw);
        await deps.showAuthorization(
          offer.authorizeUrl,
          offer.userCode,
          deadline,
        );
        await deliver({ kind: "device-opened", state: offer.state });
      } else {
        // Legacy PKCE loopback offers need the computer's callback listener.
        oauthExact(raw, [
          "authorizeUrl",
          "callbackUrl",
          "corsHosts",
          "corsOrigins",
          "state",
        ]);
        throw new Error("PLUGIN_AUTHORIZATION_COMPUTER_CALLBACK");
      }
      opened = true;
    }
    throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
  } finally {
    deps.clearInput();
    deps.inputSecret = undefined;
    deps.inputConnection = undefined;
    if (!finished && id)
      await deps.invoke({ op: "cancel", id }).catch(() => {});
    key.dispose();
  }
}
