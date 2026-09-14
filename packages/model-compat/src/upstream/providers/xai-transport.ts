import type { OcxProviderConfig } from "../types";
/** The two hosts that serve xAI's Responses API: the public API and the Grok CLI proxy. */
const XAI_RESPONSES_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);

/**
 * True when this provider's Responses traffic terminates at xAI itself.
 *
 * Probed 2026-08-22 one field per request: the two hosts accept and refuse exactly the same
 * web_search fields, so they are one dialect rather than two. Matching is exact-host over
 * https, which keeps lookalikes (`api.x.ai.evil.test`) and nonstandard ports out.
 */
export function isXaiResponsesDestination(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === "https:"
      && XAI_RESPONSES_HOSTS.has(url.hostname.toLowerCase())
      && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

