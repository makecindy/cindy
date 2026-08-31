import {
  isCindyProviderCodexRemoteCompactionRoute,
} from '@cindy/maker-core';
import type {
  RequestTransform,
  RequestTransformCtx,
} from '@cindy/anthropic-compat-proxy';

const PI_SESSION_ID_HEADER = 'x-cindy-pi-session-id';
const PI_SESSION_TOKEN_HEADER = 'x-cindy-pi-session-token';
const CODEX_GPT5_MODEL_RE = /^codex\/gpt-5(?:[.\-]|$)/;
const RESPONSES_PATH_RE = /(?:^|\/)responses(?:\?|$)/;

type TextVerbosity = 'low' | 'medium' | 'high';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExplicitVerbosity(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return value.verbosity === 'low' || value.verbosity === 'medium' || value.verbosity === 'high';
}

/**
 * Pi's generic `openai-responses` adapter does not currently serialize
 * `text.verbosity`. Add the Cindy GPT-5 default at the local proxy boundary,
 * while preserving any explicit value supplied by a newer Pi runtime.
 *
 * The model + provider checks keep this field away from third-party
 * OpenAI-compatible endpoints that may reject the OpenAI-only option.
 */
export function createPiResponsesVerbosityTransform(
  resolveProviderId: (sessionId: string, sessionToken: string | null) => string | null,
  defaultVerbosity: TextVerbosity = 'low',
): RequestTransform {
  return (body: unknown, ctx: RequestTransformCtx): unknown | null => {
    if (!RESPONSES_PATH_RE.test(ctx.url) || !isPlainObject(body)) return null;

    const sessionId = ctx.headers[PI_SESSION_ID_HEADER]?.trim();
    const sessionToken = ctx.headers[PI_SESSION_TOKEN_HEADER]?.trim() || null;
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!sessionId || !CODEX_GPT5_MODEL_RE.test(model)) return null;
    // Resolve from the authenticated Pi process binding. A subagent-route
    // token may intentionally freeze a provider that differs from its mutable
    // parent session selection.
    if (!isCindyProviderCodexRemoteCompactionRoute({
      providerId: resolveProviderId(sessionId, sessionToken),
      model,
    })) return null;
    if (hasExplicitVerbosity(body.text)) return null;

    return {
      ...body,
      text: {
        ...(isPlainObject(body.text) ? body.text : {}),
        verbosity: defaultVerbosity,
      },
    };
  };
}
