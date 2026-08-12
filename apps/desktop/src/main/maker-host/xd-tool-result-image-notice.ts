import {
  replaceToolResultImagesWithNotice,
  type RequestTransform,
} from '@cindy/anthropic-compat-proxy';

const XD_TOOL_RESULT_IMAGE_MODELS = new Set(['codex/gpt-5.6-sol', 'gpt-5.6-sol']);
const XD_TOOL_RESULT_IMAGE_NOTICE =
  '[image omitted: this tool returned an image, but the current route cannot deliver ' +
  'images inside tool results. Do NOT guess or fabricate what the image contains. ' +
  'Tell the user the image could not be delivered through the current route, and ask ' +
  'them to attach it directly to the conversation.]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeUpstreamBase(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.protocol}//${url.hostname}:${port}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Keep XD's known tool-result image limitation non-silent without changing other
 * providers or the subscription bridge, which have different transport semantics.
 */
export function createXdToolResultImageNoticeTransform(
  readXdUpstream: () => string,
): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body) || typeof body.model !== 'string') return null;
    const model = body.model.endsWith('[1m]') ? body.model.slice(0, -4) : body.model;
    if (!XD_TOOL_RESULT_IMAGE_MODELS.has(model)) return null;
    const actualUpstream = ctx.upstreamBase ? normalizeUpstreamBase(ctx.upstreamBase) : null;
    const xdUpstream = normalizeUpstreamBase(readXdUpstream());
    if (!actualUpstream || actualUpstream !== xdUpstream) return null;
    return replaceToolResultImagesWithNotice(body, XD_TOOL_RESULT_IMAGE_NOTICE);
  };
}
