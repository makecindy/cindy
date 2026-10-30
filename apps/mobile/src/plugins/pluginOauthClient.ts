import {
  PLUGIN_OAUTH_TTL_MS,
  oauthExact,
  parsePluginOauthHelloReply,
  pluginOauthTranscript,
  type PluginOauthAction,
  type PluginOauthPeerIdentity,
  type PluginOauthHello,
  type PluginOauthRequest,
} from "@cindy/device-link";
import {
  MobileOauthBox,
  encodeOauthBytes,
  verifyOauthSignature,
  type PluginOauthCrypto,
} from "./pluginOauthCrypto";
const fail = () => new Error("OAUTH_BRIDGE_UNAVAILABLE");
/** Dedicated native channel client; no URL, token, offer or plaintext is returned to a plugin page. */
export async function authenticateMobilePluginOauth(deps: {
  crypto: PluginOauthCrypto;
  target: PluginOauthPeerIdentity;
  trustIdentity(
    target: PluginOauthPeerIdentity,
    assertCurrent: () => void,
  ): Promise<void>;
  peer: string;
  action: PluginOauthAction;
  ghostId: string;
  invoke(raw: unknown, cleanup?: boolean): Promise<unknown>;
  assertCurrent(): void;
  now?(): number;
}) {
  const now = deps.now ?? Date.now;
  deps.assertCurrent();
  if (
    deps.target.observedAtMs > now() + 1000 ||
    now() - deps.target.observedAtMs > 60000 ||
    deps.target.expiresAtMs <= now() ||
    deps.target.expiresAtMs > deps.target.observedAtMs + 60000
  )
    throw fail();
  const key = new MobileOauthBox(deps.crypto);
  try {
    const hello: PluginOauthHello = {
      op: "hello",
      version: 3,
      nonce: encodeOauthBytes(deps.crypto.random(32)),
      publicKey: key.publicKey,
      action: deps.action,
    };
    const reply = parsePluginOauthHelloReply(await deps.invoke(hello));
    deps.assertCurrent();
    if (
      deps.target.expiresAtMs <= now() ||
      reply.bootId !== deps.target.bootId ||
      reply.ghostId !== deps.ghostId ||
      reply.expiresAtMs <= now() ||
      reply.expiresAtMs > now() + PLUGIN_OAUTH_TTL_MS + 1000 ||
      !verifyOauthSignature(
        deps.target.publicKey,
        reply.signature,
        pluginOauthTranscript(hello, reply, deps.target, deps.peer),
      )
    )
      throw fail();
    await deps.trustIdentity(deps.target, deps.assertCurrent);
    deps.assertCurrent();
    return {
      dispose: () => key.dispose(),
      request: async (request: PluginOauthRequest) => {
        if (request.op !== "cancel") deps.assertCurrent();
        if (now() >= reply.expiresAtMs) throw fail();
        const nonce = encodeOauthBytes(deps.crypto.random(32));
        const response = oauthExact(
          await deps.invoke(
            {
              op: "exchange",
              id: reply.id,
              box: await key.seal(
                reply.publicKey,
                `authenticated-plugin-oauth-v3:${reply.id}`,
                "callback",
                { nonce, request },
              ),
            },
            request.op === "cancel",
          ),
          ["box"],
        );
        if (request.op !== "cancel") deps.assertCurrent();
        if (typeof response.box !== "string") throw fail();
        const opened = (await key.open(
          reply.publicKey,
          `authenticated-plugin-oauth-v3:${reply.id}`,
          "offer",
          response.box,
        )) as { ok?: unknown };
        const value = oauthExact(
          opened,
          opened?.ok === true ? ["nonce", "ok", "result"] : ["nonce", "ok"],
        );
        if (value.nonce !== nonce || value.ok !== true) throw fail();
        return value.result;
      },
    };
  } catch (e) {
    key.dispose();
    throw e;
  }
}
