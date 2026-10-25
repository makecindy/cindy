import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createAnthropicCompatProxy,
  sanitizeXaiModelInputBody,
  type LocalRequestHandler,
} from "@cindy/anthropic-compat-proxy";
import { createResponsesHandler, type BridgeSessionPrefs } from "@cindy/anthropic-responses-bridge";
import { createModelFastMode } from '@cindy/model-providers/modelFastMode';
import { buildChatgptBridgeHeaders } from "@cindy/model-providers/provider-auth/chatgpt-bridge-headers";
import type { AgentKind, ResolvedRoute } from "@cindy/model-providers";
import { xaiServerSideTools } from "@cindy/model-providers/provider-auth/xai-server-side-tools";
import { withNativeXaiServerSideTools } from "@cindy/model-providers/provider-auth/xai-native-tools";
import type { TerminalGrokLogin } from "./grok-login.js";
import type { TerminalNativeAccounts } from "./native-accounts.js";

type CommonOptions = {
  route: ResolvedRoute;
  kind: AgentKind;
  taskId: string;
  authorize?: (model: string) => Promise<boolean>;
  fetch?: typeof fetch;
  preferences?: (model: string) => BridgeSessionPrefs;
};
export function createChatgptProxy(
  options: CommonOptions & { accounts: TerminalNativeAccounts },
) {
  return createSubscriptionProxy({ ...options, provider: "openai" });
}
export function createGrokProxy(
  options: CommonOptions & { accounts: TerminalGrokLogin },
) {
  return createSubscriptionProxy({ ...options, provider: "xai" });
}

/** Native engines receive only a local capability. Subscription headers,
 * account revocation and upstream recovery stay in the owner process. */
async function createSubscriptionProxy(
  options: CommonOptions &
    (
      | { provider: "openai"; accounts: TerminalNativeAccounts }
      | { provider: "xai"; accounts: TerminalGrokLogin }
    ),
) {
  const grok = options.provider === "xai";
  const upstream = grok
    ? "https://api.x.ai/v1"
    : "https://chatgpt.com/backend-api/codex";
  // Pi's native Codex transport parses a JWT-shaped API key before dispatch.
  // This is only a random loopback capability with a synthetic account claim;
  // it has no validity at OpenAI and carries none of the owner's identity.
  const token = [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "cindy-terminal-proxy",
        },
      }),
    ).toString("base64url"),
    randomBytes(32).toString("base64url"),
  ].join(".");
  const abort = new AbortController();
  let closed = false;
  const models = options.route.provider.models[options.kind] ?? [];
  const fast = createModelFastMode(() => ({ providers: [options.route.provider] }));
  const allowed = (id: string) =>
    models.find(
      (model) =>
        !model.disabled &&
        (model.id === id ||
          (options.kind === "pi" && model.id === `chatgpt/${id}`) ||
          (grok &&
            model.id.replace(/^xai\//, "") === id.replace(/^xai\//, ""))),
    );
  const denied: LocalRequestHandler = async ({ res }) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end('{"error":{"message":"Provider authorization is unavailable"}}');
  };
  const dispatch: typeof fetch = async (url, init) => {
    if (closed) throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
    const auth = await options.accounts.credential();
    if (closed || !auth.canDispatch())
      throw new Error("PROVIDER_AUTHORIZATION_CHANGED");
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(
      grok
        ? { authorization: `Bearer ${auth.accessToken}` }
        : buildChatgptBridgeHeaders({
            accessToken: auth.accessToken,
            accountId:
              "accountId" in auth && typeof auth.accountId === "string"
                ? auth.accountId
                : null,
            sessionId: options.taskId,
          }),
    ))
      headers.set(name, value);
    headers.delete("x-api-key");
    headers.delete("x-cindy-guest-route");
    const response = await (options.fetch ?? fetch)(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([
        abort.signal,
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    if (response.status === 401 || response.status === 403) {
      const reader = response.clone().body?.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (reader && size < 8192) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const kept = Buffer.from(chunk.value.subarray(0, 8192 - size));
          chunks.push(kept);
          size += kept.length;
        }
      } finally {
        void reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
      const failure = {
        status: response.status,
        body: Buffer.concat(chunks).toString("utf8"),
        failedAccessToken: auth.accessToken,
      };
      if (options.provider === "openai") await options.accounts.invalidateFailure(failure);
      else await options.accounts.invalidate(failure);
    }
    return response;
  };
  const bridge = createResponsesHandler({
    fetchImpl: dispatch,
    providers: [
      {
        prefix: grok ? "xai/" : "chatgpt/",
        wireProtocol: "openai-responses",
        upstreamBase: upstream,
        ...(grok
          ? {
              maxOutputTokensSupported: true,
              supportsReasoning: (model: string) =>
                !(
                  model.startsWith("grok-code") ||
                  model.startsWith("grok-build")
                ),
              strictFunctionTools: () => true,
              serverSideTools: xaiServerSideTools,
              fastModel: (model: string) => fast.fastModelId(options.route.provider.id, options.kind, `xai/${model}`)?.replace(/^xai\//, ''),
            }
          : { fastServiceTier: "priority" }),
        supportedReasoningEfforts: (model) =>
          models.find(
            (entry) => entry.id === `${grok ? "xai" : "chatgpt"}/${model}`,
          )?.efforts,
        buildHeaders: async () => ({}),
      },
    ],
  });
  const native: LocalRequestHandler = async (args) => {
    const { rawBody, parsedBody, ctx, res } = args;
    const pathname = new URL(ctx.url, "http://127.0.0.1").pathname;
    if (
      ctx.method !== "POST" ||
      ![
        "/responses",
        "/codex/responses",
        "/v1/responses",
        ...(grok && options.kind === "pi"
          ? ["/chat/completions", "/v1/chat/completions"]
          : []),
      ].includes(pathname)
    ) {
      res.writeHead(404).end();
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown =
        parsedBody ??
        (ctx.headers["content-encoding"] === "zstd"
          ? JSON.parse(
              (
                await promisify(zstdDecompress)(rawBody, {
                  maxOutputLength: 64 * 1024 * 1024,
                })
              ).toString("utf8"),
            )
          : undefined);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end('{"error":{"message":"Invalid subscription request"}}');
      return;
    }
    const entry =
      typeof body.model === "string" ? allowed(body.model) : undefined;
    if (
      !entry ||
      !options.accounts.connected() ||
      (options.authorize && !(await options.authorize(entry.id)))
    ) {
      await denied(args);
      return;
    }
    const request = new AbortController();
    const cancel = () => request.abort();
    res.once("close", cancel);
    try {
      const protocol = pathname.endsWith("/chat/completions")
        ? "openai-chat"
        : "openai-responses";
      let outgoing: Record<string, unknown> = {
        ...body,
        model: String(body.model)
          .replace(grok ? /^xai\// : /^chatgpt\//, "")
          .replace(/\[1m\]$/, ""),
      };
      const prefs = options.preferences?.(entry.id);
      if (!grok && prefs) {
        if (prefs.fast === true) outgoing.service_tier = 'priority';
        else if (prefs.fast === 'ultrafast' && entry.supportsUltrafastMode) outgoing.service_tier = 'ultrafast';
        else if (outgoing.service_tier === 'priority' || outgoing.service_tier === 'ultrafast') delete outgoing.service_tier;
      }
      if (grok) {
        const rewritten = fast.rewriteFastModel(options.route.provider.id, options.kind, { ...outgoing, model: entry.id }, prefs?.fast ?? false);
        if (rewritten) outgoing = { ...rewritten, model: String(rewritten.model).replace(/^xai\//, '') };
        outgoing = sanitizeXaiModelInputBody(outgoing) ?? outgoing;
        outgoing = withNativeXaiServerSideTools(outgoing, protocol) ?? outgoing;
      }
      const response = await dispatch(
        `${upstream}/${protocol === "openai-chat" ? "chat/completions" : "responses"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          // Pi's specialized transport already supplies the full Codex contract.
          // The UI namespace is never a model name understood by the backend.
          body: JSON.stringify(outgoing),
          signal: request.signal,
        },
      );
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (
          [
            "content-type",
            "cache-control",
            "retry-after",
            "x-request-id",
          ].includes(name) ||
          name.startsWith("x-ratelimit-") ||
          name.startsWith("openai-")
        )
          headers[name] = value;
      });
      res.writeHead(response.status, headers);
      if (response.body)
        await pipeline(
          Readable.fromWeb(
            response.body as Parameters<typeof Readable.fromWeb>[0],
          ),
          res,
        );
      else res.end();
    } finally {
      res.off("close", cancel);
    }
  };
  const handle = await createAnthropicCompatProxy({
    upstream,
    transformRequest: [],
    routingTransform: async (body, ctx) => {
      const credential = ctx.headers.authorization ?? ctx.headers["x-api-key"];
      const model =
        body && typeof body === "object"
          ? (body as { model?: unknown }).model
          : null;
      const entry = typeof model === "string" ? allowed(model) : undefined;
      if (
        closed ||
        (credential !== token && credential !== `Bearer ${token}`) ||
        (!entry &&
          !(
            options.kind === "pi" &&
            body === undefined &&
            ctx.headers["content-encoding"] === "zstd"
          )) ||
        !options.accounts.connected() ||
        (entry && options.authorize && !(await options.authorize(entry.id)))
      )
        return { localHandler: denied };
      return {
        localHandler:
          options.kind === "claude-code"
            ? (args) => bridge.handle({ ...args, prefs: options.preferences?.(entry!.id) ?? {} })
            : native,
        dispatchGenerationValid: () => !closed && options.accounts.connected(),
      };
    },
  });
  return {
    url: handle.url,
    token,
    async close() {
      closed = true;
      abort.abort();
      await handle.dispose();
    },
  };
}
