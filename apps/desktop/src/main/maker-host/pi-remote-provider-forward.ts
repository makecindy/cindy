import type { RemoteForward, RemoteForwardSpec } from '@cindy/maker-remote-ssh';

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
