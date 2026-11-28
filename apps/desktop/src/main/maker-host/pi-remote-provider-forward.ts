import type { RemoteForward, RemoteForwardSpec, RemoteHost } from '@cindy/maker-remote-ssh';

/**
 * Check HTTP reachability on the Pi execution host, never the controlling Desktop.
 * This is not provider authentication: a 401/404/405 still proves an HTTP listener.
 * Only the origin is probed, with no auth, curl config, proxy, redirects or response body.
 * The selected provider URL and its credentials continue through the ordinary Pi path.
 */
export async function probePiRemoteProviderEndpoint(
  host: Pick<RemoteHost, 'exec'>,
  baseUrl: string,
): Promise<boolean> {
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || !(
      hostname === 'localhost' || hostname === '::1' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    )) return false;
    // URL.origin omits userinfo, path, query and fragment. The validated loopback
    // origin contains no shell metacharacters; quoting is still explicit.
    const origin = url.origin.replace(/'/g, "'\\''");
    const result = await host.exec(
      `curl --disable --silent --head --output /dev/null --connect-timeout 2 --max-time 3 ` +
        `--noproxy '*' --proto '=http,https' --max-redirs 0 --write-out '%{http_code}' '${origin}/'`,
      { timeoutMs: 5_000, maxOutputBytes: 1024, label: 'pi-provider-reachability' },
    );
    return result.exitCode === 0 && !result.truncated && /^[1-5]\d{2}$/.test(result.stdout.trim());
  } catch {
    return false;
  }
}

interface ProviderForwardEntry {
  pending: Promise<RemoteForward>;
  handle?: RemoteForward;
}

export interface PiRemoteProviderForwardLease {
  ensure(spec: { localUrl: string; remotePort: number }): Promise<void>;
  releaseAll(): Promise<void>;
}

/**
 * Owns the remote-forward handles acquired by one Pi transport wrapper.
 * RemoteHost deduplicates the tunnel but returns one ref-counted handle per
 * call, so an old reattach wrapper cannot release its replacement's handle.
 */
export function createPiRemoteProviderForwardLease(
  ensureRemoteForward: (spec: RemoteForwardSpec) => Promise<RemoteForward>,
): PiRemoteProviderForwardLease {
  const entries = new Map<string, ProviderForwardEntry>();
  let released = false;

  const releaseEntry = async ({ pending, handle }: ProviderForwardEntry): Promise<void> => {
    let resolved = handle;
    if (!resolved) {
      try {
        resolved = await pending;
      } catch {
        return;
      }
    }
    await resolved.close();
  };

  return {
    async ensure(spec) {
      if (released) {
        throw new Error('pi host proxy forward cannot be established after transport cleanup');
      }
      const local = new URL(spec.localUrl);
      const localHost = local.hostname.replace(/^\[|\]$/g, '');
      const localPort = Number(local.port);
      if (
        !['127.0.0.1', '::1', 'localhost'].includes(localHost) ||
        !Number.isInteger(localPort) ||
        localPort <= 0
      ) {
        throw new Error(`pi host proxy forward requires an explicit loopback port: ${spec.localUrl}`);
      }
      const entryId = [`${localHost}:${localPort}`, String(spec.remotePort)].join('\0');
      const existing = entries.get(entryId);
      if (existing) {
        await existing.pending;
        return;
      }

      const pending = ensureRemoteForward({
        localHost,
        localPort,
        preferredRemotePort: spec.remotePort,
        exactRemotePort: true,
      });
      const entry = { pending, handle: undefined as RemoteForward | undefined };
      entries.set(entryId, entry);
      try {
        entry.handle = await pending;
      } catch (error) {
        if (entries.get(entryId) === entry) entries.delete(entryId);
        throw error;
      }
    },

    async releaseAll() {
      if (released) return;
      released = true;
      const ownedEntries = Array.from(entries.values());
      entries.clear();
      await Promise.all(ownedEntries.map(releaseEntry));
    },
  };
}
