import type {RequestTransformCtx,ResponseObserver} from '@cindy/anthropic-compat-proxy';
export interface ProviderProxyObservation { request(context:RequestTransformCtx,route:ResolvedRoute):void; response:ResponseObserver; }
import { randomBytes } from 'node:crypto';
import {
  createAnthropicCompatProxy,
  type ProxyHandle,
  type LocalRequestHandler,
} from '@cindy/anthropic-compat-proxy';
import { createResponsesHandler, type BridgeSessionPrefs } from '@cindy/anthropic-responses-bridge';
import { createResponsesAnthropicHandler } from '@cindy/responses-anthropic-bridge';
import { createResponsesChatHandler, type ChatBridgeCapabilities } from '@cindy/responses-chat-bridge';
import {
  providerRoutingForModel,
  providerModelRecord,
  type AgentKind,
  type ResolvedRoute,
} from '@cindy/model-providers';

/** A per-task credential boundary. Native CLIs only receive an expiring loopback
 * capability; the user's upstream key and custom headers stay in this process. */
async function createBoundProviderProxy(
  route: ResolvedRoute,
  kind: AgentKind,
  key: string | null,
  extraHeaders: Record<string, string>,
  authorize?: (model: string) => Promise<boolean>,
  onUnauthorized?: (key: string | null) => void,
  preferences?: (model: string) => BridgeSessionPrefs,
) {
  const token = randomBytes(32).toString('base64url');
  const handles: ProxyHandle[] = [];
  let closed = false;
  const protocol =
    route.routing.wireProtocol ??
    (kind === 'claude-code' ? 'anthropic-messages' : 'openai-responses');
  const thinkingFormat = providerModelRecord(route.model.id, route.routing.upstream, protocol)?.execution.pi.compat?.thinkingFormat;
  const chatCapabilities: ChatBridgeCapabilities = {
    ...(route.model.supportsImageInput ? { imageInput: 'image_url' as const } : {}),
    reasoningField: thinkingFormat === 'qwen' ? 'enable_thinking' : thinkingFormat === 'zai' ? 'thinking.type' : 'reasoning_effort',
  };
  // Account credentials publish the gateway root. Native SDKs differ: Claude
  // appends /v1/messages, while Codex and Pi append an unversioned resource.
  // Resolve the gateway path here; custom endpoints retain their exact paths.
  const requestPath =
    route.routing.requestPath ??
    (route.provider.id === 'xd'
      ? `${new URL(route.routing.upstream!).pathname.replace(/\/+$/, '').endsWith('/v1') ? '' : '/v1'}/${protocol === 'anthropic-messages' ? 'messages' : protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`
      : undefined);
  const modelIds = new Set(
    (route.provider.models[kind] ?? [])
      .filter((model) => !model.disabled)
      .map((model) => model.id),
  );
  const headers = () => ({
    ...(key
      ? protocol === 'anthropic-messages' &&
        route.provider.auth.method !== 'oauth'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : protocol === 'google-generative-ai'
          ? { 'x-goog-api-key': key }
          : { authorization: `Bearer ${key}` }
      : {}),
    ...(protocol === 'anthropic-messages'
      ? { 'anthropic-version': '2023-06-01' }
      : {}),
    ...extraHeaders,
  });
  const reportStatus = (status: number) => {
    if (!closed && status === 401) onUnauthorized?.(key);
  };
  const fetchObserved: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    reportStatus(response.status);
    return response;
  };
  const denied: LocalRequestHandler = async ({ res }) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'permission_error',
          message: 'Provider capability is unavailable',
        },
      }),
    );
  };
  async function proxy(
    upstream: string,
    handler?: LocalRequestHandler,
    secret = token,
  ) {
    const handle = await createAnthropicCompatProxy({
      upstream,
      responseObserver: (context) => reportStatus(context.status),
      transformRequest: [],
      routingTransform: async (body, ctx) => {
        const credential =
          ctx.headers.authorization ??
          ctx.headers['x-api-key'] ??
          ctx.headers['x-goog-api-key'];
        const model =
          body && typeof body === 'object'
            ? (body as { model?: unknown }).model
            : undefined;
        if (
          closed ||
          (credential !== secret && credential !== `Bearer ${secret}`) ||
          typeof model !== 'string' ||
          !modelIds.has(model)
        )
          return { localHandler: denied };
        if (authorize && !(await authorize(model)))
          return { localHandler: denied };
        if (closed) return { localHandler: denied };
        return handler
          ? { localHandler: handler, dispatchGenerationValid: () => !closed }
          : {
              ...(requestPath ? { pathOverride: requestPath } : {}),
              headerOverride: headers(),
              headerDelete: ['authorization', 'x-api-key', 'x-goog-api-key']
                .filter(
                  (name) =>
                    name !==
                    (protocol === 'anthropic-messages' &&
                    route.provider.auth.method !== 'oauth'
                      ? 'x-api-key'
                      : protocol === 'google-generative-ai'
                        ? 'x-goog-api-key'
                        : 'authorization'),
                )
                .concat('x-cindy-guest-route'),
              dispatchGenerationValid: () => !closed,
            };
      },
    });
    handles.push(handle);
    return handle;
  }
  try {
    const nativeProtocol =
      kind === 'claude-code'
        ? 'anthropic-messages'
        : kind === 'codex'
          ? 'openai-responses'
          : protocol;
    if (protocol === 'google-generative-ai' && kind !== 'pi')
      throw new Error('PROVIDER_PROTOCOL_REQUIRES_PI');
    let upstream = route.routing.upstream!;
    let handler: LocalRequestHandler | undefined;
    if (
      nativeProtocol === 'openai-responses' &&
      protocol === 'anthropic-messages'
    ) {
      const bridge = createResponsesAnthropicHandler(
        {
          upstreamBase: upstream,
          ...(requestPath ? { requestPath } : {}),
          buildHeaders: async () => headers(),
        },
        { fetchImpl: fetchObserved },
      );
      handler = (args) => bridge.handle(args);
    } else if (
      nativeProtocol === 'openai-responses' &&
      protocol === 'openai-chat'
    ) {
      const bridge = createResponsesChatHandler(
        {
          upstreamBase: upstream,
          capabilities: chatCapabilities,
          ...(requestPath ? { chatCompletionsPath: requestPath } : {}),
          buildHeaders: async () => headers(),
        },
        { fetchImpl: fetchObserved },
      );
      handler = (args) =>
        bridge.handle({ ...args, requestHeaders: args.ctx.headers });
    } else if (
      nativeProtocol === 'anthropic-messages' &&
      protocol !== 'anthropic-messages'
    ) {
      let bridgeHeaders = headers;
      if (protocol === 'openai-chat') {
        const bridge = createResponsesChatHandler(
          {
            upstreamBase: upstream,
            capabilities: chatCapabilities,
            ...(requestPath ? { chatCompletionsPath: requestPath } : {}),
            buildHeaders: async () => headers(),
          },
          { fetchImpl: fetchObserved },
        );
        const internal = await proxy(upstream, (args) =>
          bridge.handle({ ...args, requestHeaders: args.ctx.headers }),
        );
        upstream = internal.url;
        bridgeHeaders = () => ({ authorization: `Bearer ${token}` });
      }
      const bridge = createResponsesHandler({
        fetchImpl: fetchObserved,
        ...(requestPath && protocol === 'openai-responses'
          ? {
              fetchImpl: ((_url, init) =>
                fetchObserved(
                  upstream.replace(/\/+$/, '') + requestPath,
                  init,
                )) as typeof fetch,
            }
          : {}),
        providers: [
          {
            prefix: '',
            upstreamBase: upstream,
            buildHeaders: async () => bridgeHeaders(),
            maxOutputTokensSupported: true,
            supportsReasoning: () => Boolean(route.model.efforts?.length),
            supportedReasoningEfforts: () => route.model.efforts ?? [],
          },
        ],
      });
      handler = (args) => bridge.handle({ ...args, prefs: preferences?.(route.model.id) ?? {} });
    }
    const main = await proxy(upstream, handler);
    return {
      url: main.url,
      token,
      close: async () => {
        closed = true;
        await Promise.all(handles.map((handle) => handle.dispose()));
      },
    };
  } catch (error) {
    closed = true;
    await Promise.all(handles.map((handle) => handle.dispose()));
    throw error;
  }
}

/** Resolve each requested model through the shared per-model route logic. A
 * provider may legitimately expose different protocols for adjacent models. */
export async function createProviderProxy(
  route: ResolvedRoute,
  kind: AgentKind,
  key: string | null,
  extraHeaders: Record<string, string>,
  authorize?: (model: string) => Promise<boolean>,
  onUnauthorized?: (key: string | null) => void,
  resolveCredential?: () => Promise<string | null>,
  preferences?: (model: string) => BridgeSessionPrefs,
  observation?:ProviderProxyObservation,
) {
  const token = randomBytes(32).toString('base64url');
  let closed = false;
  const targets = new Map<
    string,
    Promise<Awaited<ReturnType<typeof createBoundProviderProxy>>>
  >();
  const denied: LocalRequestHandler = async ({ res }) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'permission_error',
          message: 'Provider capability is unavailable',
        },
      }),
    );
  };
  const outer = await createAnthropicCompatProxy({
    upstream: route.routing.upstream!,
    transformRequest: [],
    responseObserver:observation?.response,
    routingTransform: async (body, ctx) => {
      const credential =
        ctx.headers.authorization ??
        ctx.headers['x-api-key'] ??
        ctx.headers['x-goog-api-key'];
      const model =
        body && typeof body === 'object'
          ? (body as { model?: unknown }).model
          : undefined;
      if (
        closed ||
        (credential !== token && credential !== `Bearer ${token}`) ||
        typeof model !== 'string'
      )
        return { localHandler: denied };
      const entry = route.provider.models[kind]?.find(
        (item) => item.id === model && !item.disabled,
      );
      if (!entry || (authorize && !(await authorize(model))))
        return { localHandler: denied };
      const routing = providerRoutingForModel(route.provider, kind, model);
      if (!routing || closed) return { localHandler: denied };
      const dispatchKey = resolveCredential ? await resolveCredential() : key;
      if (closed || (resolveCredential && !dispatchKey))
        return { localHandler: denied };
      const targetKey = JSON.stringify([model, dispatchKey]);
      let target = targets.get(targetKey);
      if (!target) {
        target = createBoundProviderProxy(
          { ...route, model: entry, routing },
          kind,
          dispatchKey,
          extraHeaders,
          authorize,
          onUnauthorized,
          preferences,
        );
        targets.set(targetKey, target);
      }
      const resolved = await target;
      if (closed || (authorize && !(await authorize(model))))
        return { localHandler: denied };
      observation?.request(ctx,{...route,model:entry,routing});
      return {
        upstreamOverride: resolved.url,
        headerOverride: {
          authorization: `Bearer ${resolved.token}`,
          'x-api-key': resolved.token,
          'x-goog-api-key': resolved.token,
        },
        dispatchGenerationValid: () => !closed,
      };
    },
  });
  return {
    url: outer.url,
    token,
    close: async () => {
      closed = true;
      await outer.dispose();
      await Promise.all(
        [...targets.values()].map(async (target) => {
          try {
            await (await target).close();
          } catch {}
        }),
      );
    },
  };
}
