import type { RoutingDecision, RequestTransformCtx } from '@cindy/anthropic-compat-proxy';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, zstdDecompress } from 'node:zlib';
import { standardSpeedRequest } from '@cindy/maker-core';
import { supportsSubscriptionFastPolicy } from '@cindy/model-providers';
import { getActiveCatalog } from './active-catalog.js';
import { createSubscriptionFastPolicy } from './subscription-fast-policy.js';

const decompressors: Record<string, (bytes: Uint8Array) => Promise<Buffer>> = {
  zstd: promisify(zstdDecompress),
  gzip: promisify(gunzip),
  br: promisify(brotliDecompress),
};

export function subscriptionRequestAllowsFast(
  sessionId: string | null | undefined,
  providerId: string | null | undefined,
): boolean {
  const policy = createSubscriptionFastPolicy(sessionId ?? '', () => providerId);
  return policy.isRequestAllowed?.() ?? policy.isAllowed();
}

export function restrictSubscriptionRequest(
  body: unknown,
  sessionId: string | null | undefined,
  providerId: string | null | undefined,
): unknown | null {
  if (
    !supportsSubscriptionFastPolicy(getActiveCatalog().providers.find((p) => p.id === providerId))
  )
    return null;
  if (subscriptionRequestAllowsFast(sessionId, providerId)) return null;
  return standardSpeedRequest(body);
}

/** Apply after route selection, before every HTTP/handler dispatch; API routes keep their original object. */
export function withSubscriptionFastRequestPolicy(
  decision: RoutingDecision | null,
  identity: { sessionId?: string | null; providerId?: string | null },
  ctx?: RequestTransformCtx,
): RoutingDecision | null {
  if (
    ctx &&
    (ctx.method !== 'POST' ||
      !/\/(?:responses|messages|chat\/completions)\/?(?:\?.*)?$/.test(ctx.url))
  )
    return decision;
  if (
    !supportsSubscriptionFastPolicy(
      getActiveCatalog().providers.find((p) => p.id === identity.providerId),
    )
  )
    return decision;
  const policy = createSubscriptionFastPolicy(identity.sessionId ?? '', () => identity.providerId);
  const allowsRequest = () => policy.isRequestAllowed?.() ?? policy.isAllowed();
  let dispatchedWithFastAllowed = allowsRequest();
  const encoding = ctx?.headers['content-encoding']?.toLowerCase();
  const decodeForwarded =
    encoding && Object.hasOwn(decompressors, encoding) ? decompressors[encoding] : undefined;
  const restrict = async (body: Buffer) => {
    dispatchedWithFastAllowed = allowsRequest();
    if (!body.length || (dispatchedWithFastAllowed && !decodeForwarded)) return body;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch (error) {
      if (!decodeForwarded) throw error;
      parsed = JSON.parse((await decodeForwarded(body)).toString('utf8'));
    }
    // Re-read after asynchronous decompression too.
    dispatchedWithFastAllowed = allowsRequest();
    const next = dispatchedWithFastAllowed ? parsed : (standardSpeedRequest(parsed) ?? parsed);
    return Buffer.from(JSON.stringify(next));
  };
  if (decision?.localHandler) {
    const handler = decision.localHandler;
    return {
      ...decision,
      localHandler: async (args) => {
        if (allowsRequest() || !args.rawBody.length) return handler(args);
        let parsedBody = args.parsedBody;
        if (parsedBody === undefined) {
          const encoding = args.ctx.headers['content-encoding']?.toLowerCase();
          const decode =
            encoding && Object.hasOwn(decompressors, encoding)
              ? decompressors[encoding]
              : undefined;
          const bytes = decode ? await decode(args.rawBody) : args.rawBody;
          parsedBody = JSON.parse(bytes.toString('utf8'));
        }
        parsedBody = standardSpeedRequest(parsedBody) ?? parsedBody;
        const headers = { ...args.ctx.headers };
        delete headers['content-encoding'];
        delete headers['content-length'];
        return handler({
          ...args,
          rawBody: Buffer.from(JSON.stringify(parsedBody)),
          parsedBody,
          ctx: { ...args.ctx, headers },
        });
      },
    };
  }
  return {
    ...decision,
    ...(decodeForwarded
      ? {
          headerDelete: [
            ...new Set([...(decision?.headerDelete ?? []), 'content-encoding', 'content-length']),
          ],
        }
      : {}),
    // If policy changes during asynchronous routing/forwarding or a transparent retry,
    // reject a previously admitted Fast payload rather than leaking it to the upstream.
    dispatchGenerationValid: () =>
      decision?.dispatchGenerationValid?.() !== false &&
      (!dispatchedWithFastAllowed || allowsRequest()),
    transformRequestBody: async (body, ctx) => {
      const rewritten = decision?.transformRequestBody
        ? await decision.transformRequestBody(body, ctx)
        : { body };
      return { ...rewritten, body: await restrict(rewritten.body) };
    },
  };
}
