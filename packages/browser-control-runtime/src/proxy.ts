import {
  isBlockedHostnameOrIp,
  matchesHostnameAllowlist,
  normalizeHostname,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
} from './shim/security-runtime.js';

export type { LookupFn };

/**
 * Browser proxy routes accepted by the neutral browser-control contract.
 *
 * The credential fields are intentionally in-memory only. Callers must use
 * `server` for launch arguments and safe reporting; username/password are
 * consumed by an authentication coordinator and are never serialized.
 */
export interface BrowserProxyRoute {
  readonly mode: 'direct' | 'proxied';
  readonly server?: string;
  readonly username?: string;
  readonly password?: string;
  /** Public navigation hostnames explicitly permitted while this proxy is active. */
  readonly allowedHostnames?: readonly string[];
}

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);
const MAX_ALLOWED_HOSTNAMES = 32;
// DNS limits (RFC 1035): 253 chars per name, 63 per label. WHATWG URL accepts
// far longer hostnames, and oversized input is not merely invalid — parsing
// succeeds, `startInRoute` stops the running browser, and only then does the
// PAC/argv built from it risk exceeding the platform command-line limit,
// losing the user's tabs to a launch failure. Reject at the parse boundary,
// before anything destructive happens.
const MAX_HOSTNAME_LENGTH = 253;
const MAX_DNS_LABEL_LENGTH = 63;
const MAX_PROXY_SERVER_LENGTH = 2_048;
// LDH (RFC 952/1123): letters, digits, hyphen; a label must not start or end
// with a hyphen. Both call sites see lowercase input (allowlist entries are
// lowercased before this check, proxy hosts come from URL.hostname), and IDNs
// arrive here already punycoded, so the ASCII form is the complete alphabet.
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function assertValidDnsName(hostname: string, what: string): void {
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    throw invalidProxy(`${what} must be at most ${MAX_HOSTNAME_LENGTH} characters`);
  }
  for (const label of hostname.split('.')) {
    // WHATWG URL preserves empty and non-LDH labels (`example..com`,
    // `_foo.example.com`, `-foo.example.com`), so length checks alone would
    // pass names that later fail PAC/DNS matching — after the route switch has
    // already stopped the running browser. Reject them here, fail-closed.
    if (label.length === 0) {
      throw invalidProxy(`${what} must not contain empty DNS labels`);
    }
    if (label.length > MAX_DNS_LABEL_LENGTH) {
      throw invalidProxy(`${what} labels must be at most ${MAX_DNS_LABEL_LENGTH} characters`);
    }
    if (!DNS_LABEL_PATTERN.test(label)) {
      throw invalidProxy(
        `${what} labels must contain only letters, digits, and non-edge hyphens`,
      );
    }
  }
}

function invalidProxy(message: string): Error {
  return new Error(`invalid proxyServer: ${message}`);
}

function parseAllowedProxyHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw invalidProxy('allowed hostnames must be non-empty DNS names without whitespace');
  }
  const wildcard = value.startsWith('*.');
  const hostname = wildcard ? value.slice(2) : value;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw invalidProxy('allowed hostnames must be public DNS names');
  }
  assertValidDnsName(hostname, 'allowed hostnames');
  let parsed: URL;
  try {
    parsed = new URL(`https://${hostname}`);
  } catch {
    throw invalidProxy('allowed hostnames must be valid DNS names');
  }
  if (
    parsed.hostname !== hostname
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw invalidProxy('allowed hostnames must not include a scheme, port, path, or credentials');
  }
  if (
    !hostname.includes('.')
    || hostname.startsWith('.')
    || hostname.endsWith('.')
    || /^\d+(?:\.\d+){3}$/.test(hostname)
    || hostname.includes(':')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    throw invalidProxy('allowed hostnames must be public DNS names, not IP or local-network targets');
  }
  return wildcard ? `*.${hostname}` : hostname;
}

function parseAllowedProxyHostnames(raw: unknown): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ALLOWED_HOSTNAMES) {
    throw invalidProxy(`allowed hostnames must contain 1-${MAX_ALLOWED_HOSTNAMES} DNS patterns`);
  }
  const normalized = Array.from(new Set(raw.map((value) => {
    if (typeof value !== 'string') {
      throw invalidProxy('allowed hostnames must be strings');
    }
    return parseAllowedProxyHostname(value);
  })));
  return normalized.toSorted();
}

/** Parse and canonicalize a per-start proxy route without exposing credentials. */
export function parseBrowserProxyServer(
  raw: unknown,
  rawAllowedHostnames?: unknown,
): BrowserProxyRoute {
  if (raw === undefined || raw === null) {
    if (rawAllowedHostnames !== undefined && rawAllowedHostnames !== null) {
      throw invalidProxy('allowed hostnames require proxyServer');
    }
    return { mode: 'direct' };
  }
  if (typeof raw !== 'string') {
    throw invalidProxy('expected a URL string');
  }
  const value = raw.trim();
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw invalidProxy('must be a non-empty URL without whitespace');
  }
  if (value.length > MAX_PROXY_SERVER_LENGTH) {
    throw invalidProxy(`must be at most ${MAX_PROXY_SERVER_LENGTH} characters`);
  }
  if (value.includes(',') || value.includes(';') || value.includes('"') || value.includes("'")) {
    throw invalidProxy('proxy lists and argument quoting are not supported');
  }

  // Validate the caller's spelling before WHATWG URL canonicalization. Inputs
  // such as `/.` and `/%2e` normalize to `/`; accepting them would violate the
  // authority-only contract while looking indistinguishable after parsing.
  const schemeSeparator = value.indexOf('://');
  const authorityAndSuffix = schemeSeparator >= 0 ? value.slice(schemeSeparator + 3) : '';
  const authority = authorityAndSuffix.endsWith('/')
    ? authorityAndSuffix.slice(0, -1)
    : authorityAndSuffix;
  if (!authority || /[/?#]/.test(authority)) {
    throw invalidProxy('path, query, and fragment are not supported');
  }
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) {
    const closingBracket = hostPort.indexOf(']');
    if (closingBracket < 0) throw invalidProxy('port is malformed');
    const suffix = hostPort.slice(closingBracket + 1);
    if (suffix !== '' && !/^:\d+$/.test(suffix)) {
      throw invalidProxy('port is malformed');
    }
  } else {
    const colon = hostPort.lastIndexOf(':');
    if (colon >= 0 && !/^\d+$/.test(hostPort.slice(colon + 1))) {
      throw invalidProxy('port is malformed');
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidProxy('must use a supported proxy URL format');
  }
  if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
    throw invalidProxy('scheme must be http, https, socks, socks4, or socks5');
  }
  if (!parsed.hostname || parsed.host === '') {
    throw invalidProxy('host is required');
  }
  // IPv6 literals are bracketed by URL.hostname and carry no DNS labels.
  if (!parsed.hostname.startsWith('[')) {
    assertValidDnsName(parsed.hostname, 'proxy host');
  }
  if (parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) > 65535)) {
    throw invalidProxy('port is malformed');
  }
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw invalidProxy('path, query, and fragment are not supported');
  }

  // Authenticated proxies are NOT supported: the only mechanism that answers a
  // proxy challenge over connectOverCDP (Playwright's context-wide
  // setHTTPCredentials) also sends the credentials to any origin that returns
  // WWW-Authenticate, and allowlisted page content is untrusted — a visited
  // site could harvest the proxy credentials (verified against Chrome 151).
  // Reject userinfo at the parse boundary so this is a loud, fail-closed error
  // rather than a browser that silently launches without working auth. See the
  // authenticated-proxy follow-up before re-enabling.
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidProxy('authenticated proxies are not supported; omit the username and password');
  }
  const allowedHostnames = parseAllowedProxyHostnames(rawAllowedHostnames);

  // URL.host is already normalized (including bracketed IPv6 literals and a
  // canonicalized port).
  const server = `${parsed.protocol}//${parsed.host}`;
  return {
    mode: 'proxied',
    server,
    ...(allowedHostnames ? { allowedHostnames } : {}),
  };
}

/** Return a stable route key suitable for idempotence checks. */
export function browserProxyRouteKey(route: BrowserProxyRoute): string {
  return JSON.stringify([
    route.mode,
    route.server ?? null,
    route.username ?? null,
    route.password ?? null,
    route.allowedHostnames ?? null,
  ]);
}

/** Safe status/result representation; credentials are deliberately omitted. */
export function redactBrowserProxyRoute(route: BrowserProxyRoute | undefined): {
  mode: 'direct' | 'proxied' | 'unknown';
  server?: string;
} {
  if (!route) return { mode: 'unknown' };
  return route.mode === 'direct'
    ? { mode: 'direct' }
    : { mode: 'proxied', server: route.server };
}

/**
 * Whether a page request URL is permitted while a proxied route is active.
 *
 * Mirrors the vendored navigation guard's fail-closed explicit-proxy policy at
 * the request level: HTTPS only, hostname must match the launch allowlist, and
 * an absent/empty allowlist permits nothing. Uses the same normalization and
 * wildcard semantics (`*.example.com` matches subdomains, not the apex) as the
 * navigation-time checks so both layers agree.
 */
export function isBrowserProxyRequestUrlAllowed(
  rawUrl: string,
  route: BrowserProxyRoute,
): boolean {
  if (route.mode !== 'proxied') return true;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const hostname = normalizeHostname(parsed.hostname);
  // An allowlist entry is only a NAME, so matching it does not prove the target
  // is public. Apply the same host/IP policy the navigation guard uses, which
  // rejects loopback/RFC1918/metadata literals and known-internal names.
  //
  // This name-only check is the first half of the gate; callers on the request
  // path use `isBrowserProxyRequestUrlAllowedAsync`, which adds DNS-answer
  // verification for names that only reveal a private address on resolution.
  if (isBlockedHostnameOrIp(hostname)) return false;
  const allowlist = (route.allowedHostnames ?? []).map((pattern) => normalizeHostname(pattern));
  if (allowlist.length === 0) return false;
  return matchesHostnameAllowlist(hostname, allowlist);
}

const dnsVerdictCache = new Map<string, { allowed: boolean; expiresAt: number }>();
const DNS_VERDICT_TTL_MS = 30_000;
const DNS_VERDICT_CACHE_MAX = 256;

/**
 * Request-level gate including DNS-answer verification.
 *
 * Extends {@link isBrowserProxyRequestUrlAllowed} by resolving the destination
 * and rejecting private/special-use answers, so a name that passes the textual
 * allowlist but resolves inward (`127.0.0.1.nip.io`, or a rebinding answer) is
 * refused before the paused request is continued.
 *
 * SCOPE: this verifies what *this host* resolves. Under an explicit proxy the
 * proxy performs its own resolution, so a proxy with split-horizon DNS can
 * still map an allowlisted public name to an address only it can reach. That
 * residual trust is inherent to delegating egress to an operator-chosen proxy —
 * the same reason the vendored navigation guard demands an explicit allowlist
 * for proxied navigation rather than relying on resolution alone.
 *
 * Only DENIALS are cached (short TTL, bounded). An allow is never cached: that
 * would give a name whose DNS an attacker controls a stable window in which
 * requests skip resolution entirely, which is precisely the rebinding this
 * check exists to catch.
 */
export async function isBrowserProxyRequestUrlAllowedAsync(
  rawUrl: string,
  route: BrowserProxyRoute,
  deps: { lookupFn?: LookupFn; now?: () => number } = {},
): Promise<boolean> {
  // Name-level policy first: cheap, and it denies most traffic without a lookup.
  if (!isBrowserProxyRequestUrlAllowed(rawUrl, route)) return false;
  if (route.mode !== 'proxied') return true;

  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }

  const now = deps.now ?? Date.now;
  const cached = dnsVerdictCache.get(hostname);
  // Only DENIALS are cached. Caching an allow would hand an attacker a stable
  // bypass: an allowlisted name under their control answers publicly once,
  // then repoints at loopback/RFC1918, and every request inside the window
  // skips resolution here while the proxy connects to the new private answer.
  // Re-resolving each time costs a lookup the OS resolver has usually already
  // cached; a cached allow costs correctness.
  if (cached && !cached.allowed && cached.expiresAt > now()) return false;

  let allowed: boolean;
  try {
    // Deliberately NOT forwarding the route allowlist as `hostnameAllowlist`:
    // that field grants exact-host trust and would skip the very private-answer
    // check this call exists to perform.
    //
    // The two range exemptions ARE forwarded, and must match what the managed
    // config grants the navigation guard (browser-managed-config.ts). They
    // cover fake-IP DNS from Clash/Surge/sing-box, where ordinary public
    // hostnames resolve into 198.18.0.0/15 or IPv6 ULA. Without them this gate
    // refuses every request on such a machine and proxy mode is unusable —
    // while a policy that differs from the navigation guard's would mean the
    // two layers disagree about the same hostname.
    await resolvePinnedHostnameWithPolicy(hostname, {
      ...(deps.lookupFn ? { lookupFn: deps.lookupFn } : {}),
      policy: {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
    });
    allowed = true;
  } catch {
    // Blocked answer, or the name did not resolve — fail closed either way.
    allowed = false;
  }

  if (allowed) {
    // A name that previously resolved privately may legitimately recover, so a
    // stale denial must not outlive its TTL either.
    dnsVerdictCache.delete(hostname);
    return true;
  }
  if (dnsVerdictCache.size >= DNS_VERDICT_CACHE_MAX) {
    const oldest = dnsVerdictCache.keys().next();
    if (!oldest.done) dnsVerdictCache.delete(oldest.value);
  }
  dnsVerdictCache.set(hostname, { allowed: false, expiresAt: now() + DNS_VERDICT_TTL_MS });
  return false;
}

/** Test seam: drop cached DNS verdicts. */
export function resetBrowserProxyDnsVerdictCache(): void {
  dnsVerdictCache.clear();
}

/** Redact proxy URL credentials in arbitrary error/log text. */
export function redactBrowserProxyText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)(\S+)/gi, (match, scheme: string, rest: string) => {
    // Use the last delimiter so even malformed/unescaped @ in credentials is
    // fully removed rather than leaving the password suffix visible.
    const delimiter = rest.lastIndexOf('@');
    return delimiter < 0 ? match : `${scheme}[REDACTED]@${rest.slice(delimiter + 1)}`;
  });
}
