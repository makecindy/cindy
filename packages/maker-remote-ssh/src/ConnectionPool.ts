/**
 * ConnectionPool — registry + lifecycle owner for all RemoteHosts in the
 * current Electron session. Keyed by canonical HostRef; legacy bare SSH
 * aliases are accepted only at lookup boundaries.
 *
 * Phase A surface:
 *   - hydrate(): merge hosts read from ~/.ssh/config and Cindy-local profiles
 *   - add() / remove() / get() / list() — registry ops
 *   - connect() / disconnect() — convenience wrappers
 *   - onAnyStatus() — single subscription that fires for all hosts
 *   - dispose() — bulk disconnect on app quit
 *
 * The pool itself owns no persistence. Desktop owns SSH config discovery and
 * Cindy profile storage; the pool only keeps the in-memory mirror.
 */

import { EventEmitter } from 'node:events';

import { RemoteHost, type RemoteHostDeps, type StatusListener } from './RemoteHost.js';
import { FileHostKeyStore, type HostKeyStore } from './hostKeys.js';
import { parseHostRef, type HostConfig, type HostSnapshot } from './types.js';

export interface ConnectionPoolDeps {
  logger: RemoteHostDeps['logger'];
  /**
   * Path to the maker-owned known-hosts store (JSON) used for host key TOFU.
   * A FileHostKeyStore is built from it and shared across all hosts. When
   * neither this nor `hostKeys` is provided, connects fail closed — no host
   * key verification means we refuse rather than trust any presented key.
   */
  knownHostsPath?: string;
  /** Pre-built store; overrides `knownHostsPath` (mainly for tests). */
  hostKeys?: HostKeyStore;
}

export class ConnectionPool {
  private hosts = new Map<string, RemoteHost>();
  /** Legacy bare SSH aliases resolve to the canonical ssh-config HostRef. */
  private aliases = new Map<string, string>();
  private events = new EventEmitter();
  private readonly deps: ConnectionPoolDeps;
  private readonly hostKeys?: HostKeyStore;

  constructor(deps: ConnectionPoolDeps) {
    this.deps = deps;
    this.hostKeys =
      deps.hostKeys ?? (deps.knownHostsPath ? new FileHostKeyStore(deps.knownHostsPath) : undefined);
  }

  /**
   * Bulk replace the registry with the given configs. Existing hosts that
   * still appear keep their live status; hosts removed from the input are
   * disconnected and dropped. Used at startup after reading ~/.ssh/config.
   */
  async hydrate(configs: HostConfig[]): Promise<void> {
    const incoming = new Set<string>();
    const incomingAliases = new Set<string>();
    for (const cfg of configs) {
      if (incoming.has(cfg.id)) throw new Error(`duplicate host id: ${cfg.id}`);
      incoming.add(cfg.id);
      if (cfg.alias) {
        if (incomingAliases.has(cfg.alias)) throw new Error(`duplicate ssh alias: ${cfg.alias}`);
        incomingAliases.add(cfg.alias);
      }
    }
    // Drop hosts no longer present.
    for (const [id, host] of this.hosts) {
      if (!incoming.has(id)) {
        await host.disconnect();
      }
    }
    // Add or update in source order, then replace both indexes atomically.
    // Rebuilding the Map matters because its iteration order is the list
    // contract: SSH config hosts follow expanded config order, then Cindy
    // profiles. Updating an existing Map in place would keep stale ordering
    // after the user rearranges Include files or inserts a host earlier.
    const nextHosts = new Map<string, RemoteHost>();
    const nextAliases = new Map<string, string>();
    for (const cfg of configs) {
      const existing = this.hosts.get(cfg.id);
      if (existing) {
        if (connectionFieldsChanged(existing.config, cfg)) {
          // A successful config refresh must never show the new effective
          // target while continuing to execute over a live connection to the
          // old target. Disconnect first; the next explicit/auto connect will
          // authenticate against the refreshed literal endpoint.
          await existing.disconnect();
        }
        existing.updateConfig(cfg);
        nextHosts.set(cfg.id, existing);
      } else {
        nextHosts.set(cfg.id, this.createHost(cfg));
      }
      if (cfg.alias) nextAliases.set(cfg.alias, cfg.id);
    }
    this.hosts = nextHosts;
    this.aliases = nextAliases;
  }

  add(cfg: HostConfig): RemoteHost {
    if (this.hosts.has(cfg.id) || (cfg.alias && this.aliases.has(cfg.alias))) {
      throw new Error(`host already exists: ${cfg.id}`);
    }
    return this.register(cfg);
  }

  async remove(id: string): Promise<void> {
    const canonical = this.resolveId(id);
    const host = this.hosts.get(canonical);
    if (!host) return;
    await host.disconnect();
    this.hosts.delete(canonical);
    const alias = host.config.alias;
    if (alias && this.aliases.get(alias) === canonical) this.aliases.delete(alias);
  }

  get(id: string): RemoteHost | undefined {
    return this.hosts.get(this.resolveId(id));
  }

  list(): HostSnapshot[] {
    return Array.from(this.hosts.values()).map((h) => h.snapshot());
  }

  async connect(id: string): Promise<void> {
    const host = this.requireHost(id);
    await host.connect();
  }

  async disconnect(id: string): Promise<void> {
    const host = this.hosts.get(this.resolveId(id));
    if (host) await host.disconnect();
  }

  /**
   * Subscribe to status changes from any host. Listener fires once per
   * state transition with the host snapshot.
   */
  onAnyStatus(listener: StatusListener): () => void {
    this.events.on('status', listener);
    return () => this.events.off('status', listener);
  }

  /** Disconnect every host. Safe to call multiple times. */
  async dispose(): Promise<void> {
    const all = Array.from(this.hosts.values());
    this.hosts.clear();
    this.aliases.clear();
    await Promise.all(all.map((h) => h.disconnect().catch(() => undefined)));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private register(cfg: HostConfig): RemoteHost {
    if (cfg.alias) {
      const existing = this.aliases.get(cfg.alias);
      if (existing && existing !== cfg.id) throw new Error(`duplicate ssh alias: ${cfg.alias}`);
    }
    const host = this.createHost(cfg);
    this.hosts.set(cfg.id, host);
    if (cfg.alias) this.aliases.set(cfg.alias, cfg.id);
    return host;
  }

  private createHost(cfg: HostConfig): RemoteHost {
    const host = new RemoteHost(cfg, { logger: this.deps.logger, hostKeys: this.hostKeys });
    host.onStatus((snap) => this.events.emit('status', snap));
    return host;
  }

  private requireHost(id: string): RemoteHost {
    const canonical = this.resolveId(id);
    const host = this.hosts.get(canonical);
    if (!host) throw new Error(`unknown host: ${id}`);
    return host;
  }

  /** Resolve a canonical HostRef or a legacy bare SSH alias. */
  resolveId(id: string): string {
    if (this.hosts.has(id)) return id;
    // A complete HostRef wins whenever it exists. If it does not, retain a
    // narrow compatibility path for pre-HostRef persisted values: before
    // namespacing, an OpenSSH alias was allowed to be `cindy:foo` or
    // `ssh-config:foo`, and old sessions/prefs still contain that bare text.
    // Only an alias that is actually present in the current SSH source map is
    // eligible for this fallback; arbitrary external selectors remain
    // unresolved and MCP applies its stricter complete-HostRef contract.
    if (parseHostRef(id)) return this.aliases.get(id) ?? id;
    return this.aliases.get(id) ?? id;
  }
}

function connectionFieldsChanged(left: HostConfig, right: HostConfig): boolean {
  return left.hostname !== right.hostname
    || left.port !== right.port
    || left.user !== right.user
    || left.authMethod !== right.authMethod
    || left.identityFile !== right.identityFile;
}
