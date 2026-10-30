/**
 * ConnectionPool — registry + lifecycle owner for all RemoteHosts in the
 * current Electron session. Keyed by host id (the SSH alias).
 *
 * Phase A surface:
 *   - hydrate(): bulk-add hosts discovered from OpenSSH config
 *   - add() / remove() / get() / list() — registry ops
 *   - connect() / disconnect() — convenience wrappers
 *   - onAnyStatus() — single subscription that fires for all hosts
 *   - dispose() — bulk disconnect on app quit
 *
 * The pool itself owns no persistence. The IPC layer owns OpenSSH reads and
 * narrowly-scoped managed writes; the pool only keeps the in-memory mirror.
 */

import { EventEmitter } from 'node:events';

import { RemoteHost, type RemoteHostDeps, type StatusListener } from './RemoteHost.js';
import { FileHostKeyStore, type HostKeyStore } from './hostKeys.js';
import { effectiveAuthenticationFingerprint } from './sshAuthentication.js';
import type { HostConfig, HostSnapshot } from './types.js';

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
   * disconnected and dropped. Used after reading the effective SSH host graph.
   */
  async hydrate(configs: HostConfig[]): Promise<void> {
    // Validate the complete replacement before mutating/disconnecting the
    // current pool. A malformed refresh must leave the last valid snapshot
    // usable rather than partially applying entries before throwing.
    const incoming = new Set<string>();
    for (const config of configs) {
      if (incoming.has(config.id)) throw new Error(`duplicate host id: ${config.id}`);
      incoming.add(config.id);
    }
    // Drop hosts no longer present.
    for (const [id, host] of this.hosts) {
      if (!incoming.has(id)) {
        await host.disconnect();
        this.hosts.delete(id);
      }
    }
    // Add or update.
    for (const cfg of configs) {
      const existing = this.hosts.get(cfg.id);
      if (existing) {
        if (connectionFieldsChanged(existing.config, cfg)) {
          // Never publish a new endpoint while a live ssh2 connection still
          // targets the old hostname/user/port/credential tuple.
          await existing.disconnect();
        }
        existing.updateConfig(cfg);
      } else {
        this.register(cfg);
      }
    }
  }

  add(cfg: HostConfig): RemoteHost {
    if (this.hosts.has(cfg.id)) {
      throw new Error(`host already exists: ${cfg.id}`);
    }
    return this.register(cfg);
  }

  async remove(id: string): Promise<void> {
    const host = this.hosts.get(id);
    if (!host) return;
    await host.disconnect();
    this.hosts.delete(id);
  }

  get(id: string): RemoteHost | undefined {
    return this.hosts.get(id);
  }

  list(): HostSnapshot[] {
    return Array.from(this.hosts.values()).map((h) => h.snapshot());
  }

  async connect(id: string): Promise<void> {
    const host = this.requireHost(id);
    await host.connect();
  }

  async disconnect(id: string): Promise<void> {
    const host = this.hosts.get(id);
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
    await Promise.all(all.map((h) => h.disconnect().catch(() => undefined)));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private register(cfg: HostConfig): RemoteHost {
    const host = new RemoteHost(cfg, { logger: this.deps.logger, hostKeys: this.hostKeys });
    host.onStatus((snap) => this.events.emit('status', snap));
    this.hosts.set(cfg.id, host);
    return host;
  }

  private requireHost(id: string): RemoteHost {
    const host = this.hosts.get(id);
    if (!host) throw new Error(`unknown host: ${id}`);
    return host;
  }
}

function connectionFieldsChanged(left: HostConfig, right: HostConfig): boolean {
  return left.hostname !== right.hostname
    || left.port !== right.port
    || left.user !== right.user
    || effectiveAuthenticationFingerprint(left) !== effectiveAuthenticationFingerprint(right);
}
