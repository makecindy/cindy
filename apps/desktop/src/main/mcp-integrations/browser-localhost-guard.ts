/**
 * Host-side localhost guard for the managed `cindy_browser` MCP.
 *
 * The vendored browser runtime's SSRF policy allows the `localhost` hostname so
 * an agent can open a developer's local preview. That allowance is hostname-only
 * (no port concept in the upstream policy), so this module is the adapter-boundary
 * seam that:
 *
 *  1. Normalizes hostnames the same way the SSRF layer does (trailing dots,
 *     brackets, case) so `http://localhost./` cannot slip past the approval
 *     check (P1: trailing-dot bypass).
 *  2. Recognizes the full loopback set the approval must gate, not just the
 *     literal `localhost`.
 *  3. Restricts which localhost *ports* a navigation may reach, so a trusted
 *     browser MCP cannot silently probe arbitrary local services (P1: unrestricted
 *     localhost service access). The per-call user approval remains the primary
 *     gate; this is defense-in-depth that rejects sensitive service ports before
 *     a request ever reaches Chromium.
 *
 * Pure helpers only — no Electron / runtime imports — so the approval policy and
 * the runtime wrapper can share one source of truth and it is unit-testable.
 */

/**
 * Loopback hostnames (after normalization) that resolve to the local machine.
 * Matches the Pi host-side `isLoopbackOnlyBaseUrl` set plus the literal
 * `localhost`/`.localhost` forms the SSRF hostname classifier treats as local.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '::1',
  '0.0.0.0',
]);

/** 127.0.0.0/8 — every address in this block is loopback on most stacks. */
const IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/;

/**
 * Well-known sensitive local service ports that an agent must never reach through
 * the browser, even behind a per-call localhost approval. These are databases,
 * caches, message brokers, remote-access services, and the desktop app's own
 * control planes — not developer preview servers.
 *
 * This is a deny-list (not an allow-list of "preview ports") because dev servers
 * listen on arbitrary high ports (Vite 5173, CRA/Next 3000, Python 8000, ...)
 * and an allow-list would break legitimate previews. The per-call user approval
 * remains the primary gate for every other port; this list is a hard backstop
 * so a user cannot be talked into approving a database/control-plane port.
 *
 * Privileged ports (< 1024) are NOT blanket-blocked: `http://localhost/`
 * (default port 80) and local HTTPS proxies (443) are common preview URLs and
 * are not, by themselves, sensitive services.
 */
const LOCALHOST_SENSITIVE_PORTS: ReadonlySet<number> = new Set([
  // Cindy / agent control planes (managed Chrome CDP + browser control server).
  18800, // managed Chrome CDP
  18791, // browser control server
  // Common databases / caches.
  3306, // MySQL
  5432, // PostgreSQL
  6379, // Redis
  7474, // Neo4j HTTP
  7687, // Neo4j Bolt
  9042, // Cassandra
  9200, // Elasticsearch HTTP
  9300, // Elasticsearch transport
  11211, // Memcached
  27017, // MongoDB
  27018, // MongoDB shard
  27019, // MongoDB config
  28017, // MongoDB HTTP
  // Message brokers / queues.
  5672, // AMQP (RabbitMQ)
  15672, // RabbitMQ management
  9092, // Kafka
  2181, // ZooKeeper
  61613, // STOMP
  61616, // ActiveMQ
  // Mail / transfer / remote access.
  21, // FTP
  22, // SSH
  25, // SMTP
  465, // SMTPS
  587, // SMTP submission
  110, // POP3
  143, // IMAP
  445, // SMB
  3389, // RDP
  5900, // VNC
  // Other commonly-abused local services.
  2375, // Docker API (unencrypted)
  2376, // Docker API (TLS)
  4040, // ngrok admin
  5984, // CouchDB
  6443, // Kubernetes API
  8086, // InfluxDB
  8500, // Consul
]);

/**
 * Normalize a hostname for policy comparison, mirroring the SSRF layer's
 * `normalizeHostname`: lowercase, strip trailing dots, and unwrap bracketed
 * IPv6 literals. This is what closes the `http://localhost./` bypass — the URL
 * parser keeps the trailing dot but the normalized form does not.
 */
export function normalizeLocalhostHostname(hostname: string): string {
  let normalized = hostname.toLowerCase().replace(/\.+$/, '');
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

/**
 * True when `hostname` (already normalized or raw) resolves to loopback:
 * `localhost`, `localhost.` (trailing dot), `127.0.0.0/8`, `::1`, `0.0.0.0`.
 * Also accepts `.localhost` subdomains, matching the SSRF blocked-hostname
 * classifier so the approval gate cannot be narrower than the network guard.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeLocalhostHostname(hostname);
  if (!normalized) return false;
  if (LOOPBACK_HOSTNAMES.has(normalized)) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (IPV4_LOOPBACK_RE.test(normalized)) {
    const parts = normalized.split('.').map(Number);
    return parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255);
  }
  return false;
}

/**
 * A localhost navigation is allowed on any valid TCP port that is not on the
 * sensitive-service deny list. `port` is the numeric port from the URL (or the
 * protocol default when absent). Privileged ports themselves are not blocked
 * because a dev preview can legitimately be fronted by a local reverse proxy
 * on 80/443; the deny list below is what protects known control planes.
 */
export function isAllowedLocalhostPort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return !LOCALHOST_SENSITIVE_PORTS.has(port);
}

export interface LocalhostUrlCheck {
  /** True when the URL's host is a loopback address. */
  isLoopback: boolean;
  /** Numeric port (protocol default filled in when the URL omitted one). */
  port: number;
  /**
   * True when the URL is loopback AND the port is allowed for preview use.
   * False for non-loopback URLs (they are not this guard's concern).
   */
  allowed: boolean;
}

const PROTOCOL_DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'http:': 80,
  'https:': 443,
};

/**
 * Inspect a (possibly agent-supplied) URL. Returns `isLoopback: false` for
 * non-http(s) URLs or unparseable strings; the caller decides how to treat
 * those (the MCP scheme guard already blocks non-http(s) navigation).
 */
export function inspectLocalhostUrl(rawUrl: string): LocalhostUrlCheck {
  const notLoopback: LocalhostUrlCheck = { isLoopback: false, port: 0, allowed: false };
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return notLoopback;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return notLoopback;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return notLoopback;
  if (!isLoopbackHostname(parsed.hostname)) return notLoopback;
  const port = parsed.port
    ? Number(parsed.port)
    : (PROTOCOL_DEFAULT_PORTS[parsed.protocol] ?? 0);
  const allowed = isAllowedLocalhostPort(port);
  return { isLoopback: true, port, allowed };
}

/**
 * Error thrown when a navigation targets a loopback address on a port the
 * guard does not permit. The MCP runtime wrapper converts this into a failed
 * `BrowserControlResult` so the agent sees a clear, non-crashy rejection.
 */
export class LocalhostPortBlockedError extends Error {
  readonly port: number;
  constructor(url: string, port: number) {
    super(
      `Blocked navigation to ${url}: localhost port ${port} is a known sensitive ` +
        'service (database, message broker, remote access, or Cindy control plane) ' +
        'and cannot be reached through the preview browser.',
    );
    this.name = 'LocalhostPortBlockedError';
    this.port = port;
  }
}
