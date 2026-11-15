/** Names of this computer's MCP servers for the capabilities upload, read once per cycle instead of once per companion. */
export function createMcpServerNamesReader(
  list: () => Promise<Array<{ id: string; name: string }>>,
  owner: () => string,
  options: { ttlMs?: number; now?: () => number } = {},
): () => Promise<Record<string, string>> {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? Date.now;
  let last: { owner: string; at: number; value: Promise<Record<string, string>> } | null = null;
  return () => {
    const current = owner();
    if (!last || last.owner !== current || now() - last.at > ttlMs) {
      // A server list that cannot be read costs the names for this cycle only, as before.
      last = { owner: current, at: now(), value: list()
        .then(servers => Object.fromEntries(servers.map(server => [server.id, server.name]))).catch(() => ({})) };
    }
    return last.value;
  };
}
