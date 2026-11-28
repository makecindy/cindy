/**
 * Shared Agent-Net STUN discovery and UDP port configuration helpers (zero Electron
 * dependencies so Desktop Main and Node Host share identical behavior, see
 * docs/dev-rules/architecture-invariants.md §5).
 *
 * Dual-region official STUN:
 * When a node runs on an official Agent-Net network (`cn` or `global`), split-routing
 * proxies / VPNs can route traffic to the two regions through different public egress IPs.
 * Querying the opposite official region's STUN server in addition to the primary relay's
 * STUN lets `packages/agent-net/src/transport.ts` advertise both public candidates so peers
 * in either region can establish direct UDP connections.
 *
 * Privacy boundary:
 * Self-hosted relays ("部署到我的服务器" / "这台电脑当中转" / "加入别人的中转" / "仅用我的中继")
 * MUST NOT invoke these helpers for peer official STUN discovery. `getOfficialAgentNetPeerBase`
 * additionally requires an exact match against the bundled official production URLs.
 */
import { agentNetStunServer } from '@cindy/agent-net-protocol';
import { getOfficialAgentNetPeerBase } from '@cindy/maker-shared/client-endpoints';

export { getOfficialAgentNetPeerBase };

/** Environment variable for an optional fixed local UDP listening port (`1..65535`). */
export const AGENT_NET_UDP_PORT_ENV = 'CINDY_AGENT_NET_UDP_PORT';

const PEER_STUN_INFO_TTL_MS = 10 * 60_000;
const PEER_STUN_INFO_RETRY_MS = 60_000;
const PEER_STUN_INFO_TIMEOUT_MS = 3_000;

interface PeerStunCacheEntry {
  server: string | null;
  nextReadAt: number;
  pending?: Promise<string | null>;
}

const peerStunCache = new Map<string, PeerStunCacheEntry>();

/**
 * Parses an optional fixed UDP port from configuration / `CINDY_AGENT_NET_UDP_PORT`.
 * Empty or `'0'` means default ephemeral port (`undefined`). Invalid values log a
 * warning and fall back to ephemeral rather than blocking startup.
 */
export function parseAgentNetUdpPort(
  raw: string | undefined,
  log?: { warn(message: string): void },
): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '0') return undefined;
  if (/^\d{1,5}$/.test(trimmed)) {
    const port = Number(trimmed);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
  }
  log?.warn(`agent-net ignoring invalid ${AGENT_NET_UDP_PORT_ENV}=${trimmed}; using ephemeral UDP port`);
  return undefined;
}

/** Deduplicates non-empty `host:port` STUN server strings while preserving priority order. */
export function mergeStunServers(...servers: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of servers) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

/** Returns the last known STUN server cached for a peer official base, if any. */
export function getCachedPeerOfficialStunServer(peerBase: string): string | null {
  return peerStunCache.get(peerBase)?.server ?? null;
}

/**
 * Resolves the opposite official region's STUN server via its public `/api/agent-net/info`
 * with bounded TTL caching and in-flight deduplication so startup is never blocked and
 * reconnects do not amplify cross-region HTTP requests.
 */
export function readPeerOfficialStunServer(
  peerBase: string,
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; now?: () => number } = {},
): { cached: string | null; pending: Promise<string | null> | null } {
  const now = options.now ?? Date.now;
  const entry = peerStunCache.get(peerBase) ?? { server: null, nextReadAt: 0 };
  if (entry.pending) return { cached: entry.server, pending: entry.pending };
  if (now() < entry.nextReadAt) return { cached: entry.server, pending: null };
  const timeoutMs = options.timeoutMs ?? PEER_STUN_INFO_TIMEOUT_MS;
  const pending = (async (): Promise<string | null> => {
    let interval = PEER_STUN_INFO_RETRY_MS;
    try {
      const response = await fetchImpl(peerBase + '/api/agent-net/info', {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const info: unknown = await response.json();
        entry.server = agentNetStunServer(peerBase, info);
        interval = PEER_STUN_INFO_TTL_MS;
      }
    } catch {
      // Keep the last known peer STUN server across transient network failures;
      // the primary region's STUN and relay remain unaffected.
    } finally {
      entry.nextReadAt = now() + interval;
      entry.pending = undefined;
    }
    return entry.server;
  })();
  entry.pending = pending;
  peerStunCache.set(peerBase, entry);
  return { cached: entry.server, pending };
}

/** Test-only helper to clear the module-level peer STUN cache between isolated unit cases. */
export function resetPeerOfficialStunCacheForTest(): void {
  peerStunCache.clear();
}
