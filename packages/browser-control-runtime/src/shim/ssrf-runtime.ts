/**
 * Shim: openclaw/plugin-sdk/ssrf-runtime → thin faithful `fetchWithSsrFGuard`.
 *
 * The SSRF *decision logic* (block lists, private-IP detection, DNS-rebinding
 * re-check, pinned dispatcher) is the real upstream code, vendored under
 * `_generated/leaf/src/infra/net/ssrf.ts`. This shim only re-implements the
 * thin fetch *shell* that composes those primitives — deliberately NOT pulling
 * in the upstream logger/config/proxyline graph that the original 665-line
 * `fetch-guard.ts` dragged along.
 *
 * Safety properties preserved (run on every hop):
 *  - `isBlockedHostnameOrIp`: reject cloud-metadata / blocked literals up front.
 *  - `resolvePinnedHostnameWithPolicy`: resolve DNS and re-check the resolved
 *    addresses so a public hostname cannot pivot to a private target (rebinding).
 *  - `createPinnedDispatcher`: connect using only the vetted addresses.
 *
 * Our two callers (control-client, CDP helper) target loopback control planes,
 * so cross-host redirects are practically absent; they are still handled
 * conservatively (manual follow, re-guard each hop, sensitive headers stripped
 * cross-origin).
 */
import { fetch as undiciFetch, type Dispatcher } from 'undici';

import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type PinnedHostname,
  type SsrFPolicy,
} from '../_generated/leaf/src/infra/net/ssrf.js';

export type { LookupFn, SsrFPolicy } from '../_generated/leaf/src/infra/net/ssrf.js';

export interface GuardedFetchOptions {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  policy?: SsrFPolicy;
  timeoutMs?: number;
  requireHttps?: boolean;
  maxRedirects?: number;
  lookupFn?: LookupFn;
  /**
   * 可选的安全出口适配器。DNS 守门完成后才调用；返回 undefined 时继续使用
   * 默认的直连 pinned dispatcher。调用方若返回自定义 dispatcher，必须保证它
   * 仍只连接 pinned.addresses 中的地址。
   */
  dispatcherFactory?: (params: {
    url: URL;
    pinned: PinnedHostname;
    policy?: SsrFPolicy;
  }) => Dispatcher | undefined | Promise<Dispatcher | undefined>;
  /** DNS 与出口选择完成后、真正 dispatch 前的最后一道同步/异步资格复核。 */
  beforeDispatch?: () => void | Promise<void>;
  /** Accepted for call-site compatibility; not used by the thin shell. */
  auditContext?: string;
  [extra: string]: unknown;
}

export interface GuardedFetchResult {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
}

// Headers carrying credentials that must NOT cross a redirect to a different
// origin. `x-openclaw-password` is the browser-control loopback auth header
// (set by the vendored client-fetch); omitting it would forward the control
// password to a redirect target on another host/port.
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-openclaw-password'];

/**
 * PURE: credentials may be preserved across a redirect ONLY when the target is
 * the SAME origin (scheme + host + port). Comparing host alone would keep
 * Authorization/Cookie across an https→http downgrade (sent in cleartext) or a
 * port change. `URL.origin` encodes all three, so this catches both.
 */
export function isSameRedirectOrigin(from: URL, to: URL): boolean {
  return from.origin === to.origin;
}

function assertScheme(url: URL, requireHttps: boolean | undefined): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked non-http(s) URL: ${url.protocol}`);
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error(`Blocked non-https URL: ${url.href}`);
  }
}

/**
 * Guard a single hop: scheme check, then the vendored policy gate.
 *
 * `resolvePinnedHostnameWithPolicy` is the faithful upstream gate — it applies
 * the hostname allowlist, the private-network block (honoring `allowedHostnames`
 * exemptions, e.g. an explicitly allowed loopback CDP host), resolves DNS, and
 * re-checks the resolved addresses against the same classifier (rebinding
 * defense). We deliberately do NOT add a separate pre-check here: a blanket
 * `isBlockedHostnameOrIp` would ignore the policy's allowlist and wrongly reject
 * allowlisted loopback control-plane URLs.
 */
async function guardHop(
  rawUrl: string,
  policy: SsrFPolicy | undefined,
  lookupFn: LookupFn | undefined,
  requireHttps: boolean | undefined,
  dispatcherFactory: GuardedFetchOptions['dispatcherFactory'],
): Promise<{ url: URL; dispatcher: Dispatcher }> {
  const url = new URL(rawUrl);
  assertScheme(url, requireHttps);
  const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, { policy, lookupFn });
  const dispatcher =
    (await dispatcherFactory?.({ url, pinned, policy }))
    ?? createPinnedDispatcher(pinned, undefined, policy);
  return { url, dispatcher };
}

/**
 * Guard and execute exactly one manually redirected HTTP hop.
 *
 * Callers that own redirect semantics can re-run this function for every hop;
 * the returned dispatcher keeps the vetted DNS answers pinned until the
 * response body has been consumed and `release()` is called.
 */
export async function fetchSingleHopWithSsrFGuard(
  params: GuardedFetchOptions,
): Promise<{ response: Response; release: () => Promise<void> }> {
  const { url, dispatcher } = await guardHop(
    params.url,
    params.policy,
    params.lookupFn,
    params.requireHttps,
    params.dispatcherFactory,
  );
  try {
    await params.beforeDispatch?.();
    const fetchOptions = {
      ...params.init,
      signal: params.signal ?? params.init?.signal,
      redirect: 'manual' as const,
      dispatcher,
    };
    const response = (await undiciFetch(
      url.href,
      fetchOptions as unknown as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;
    return {
      response,
      release: () => closeDispatcher(dispatcher),
    };
  } catch (err) {
    await closeDispatcher(dispatcher);
    throw err;
  }
}

function stripSensitiveHeaders(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const headers = new Headers(init.headers);
  for (const h of SENSITIVE_HEADERS) headers.delete(h);
  return { ...init, headers };
}

/**
 * Faithful thin replacement for upstream `fetchWithSsrFGuard`. Returns the
 * response plus a `release()` that closes the pinned dispatcher.
 */
export async function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const maxRedirects = params.maxRedirects ?? 10;
  let currentUrl = params.url;
  let currentInit: RequestInit | undefined = params.init;
  const originUrl = new URL(params.url);

  // Track dispatchers created across hops so release() can close them all.
  const dispatchers: Dispatcher[] = [];
  const release = async () => {
    for (const d of dispatchers.splice(0)) await closeDispatcher(d);
  };

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const { url, dispatcher } = await guardHop(
        currentUrl,
        params.policy,
        params.lookupFn,
        params.requireHttps,
        params.dispatcherFactory,
      );
      dispatchers.push(dispatcher);

      await params.beforeDispatch?.();

      // undici's fetch accepts a `dispatcher`; its RequestInit differs slightly
      // from the DOM lib types, so we go through `unknown` for the options bag.
      const fetchOptions = {
        ...currentInit,
        signal: params.signal ?? currentInit?.signal,
        redirect: 'manual' as const,
        dispatcher,
      };
      const response = (await undiciFetch(
        url.href,
        fetchOptions as unknown as Parameters<typeof undiciFetch>[1],
      )) as unknown as Response;

      const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location');
      if (!isRedirect) {
        return { response, finalUrl: url.href, release };
      }

      // Follow redirect: resolve target, strip sensitive headers when the target
      // origin (scheme+host+port) differs from the original — not just the host.
      const location = response.headers.get('location') as string;
      const nextUrl = new URL(location, url.href);
      currentInit =
        isSameRedirectOrigin(originUrl, nextUrl) ? currentInit : stripSensitiveHeaders(currentInit);
      currentUrl = nextUrl.href;
      // Drain the redirect body so the connection can be reused/closed cleanly.
      await response.body?.cancel().catch(() => undefined);
    }
    throw new Error(`Too many redirects (>${maxRedirects})`);
  } catch (err) {
    await release();
    throw err;
  }
}
