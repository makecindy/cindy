import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebContents } from 'electron';
import { PtyManager, type CreateOptions, type PtyEventSink, type PtyOwner, type PtySnapshot } from './ptyManager.js';
import type { PtySpawnFn } from './ptyFactory.js';

/** Host attestation, never an object supplied by a plugin or model. */
export interface HostTerminalScope {
  key: string;
  revision: string;
  pluginId?: string;
  defaultCwd: string;
  createDefaultCwd?: boolean;
  environment: NodeJS.ProcessEnv;
  assertCurrent(): void;
}

export type HostTerminalStart = Pick<CreateOptions, 'cwd' | 'program' | 'cols' | 'rows' | 'shellPref'>;

class ProcessOwner extends EventEmitter implements PtyOwner {
  private destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
}

interface ScopeEntry {
  revision: string;
  pluginId?: string;
  owner: ProcessOwner;
  assertCurrent(): void;
}

const isWindow = (owner: PtyOwner): owner is WebContents => 'send' in owner && typeof owner.send === 'function';
const dimensions = (value: number | undefined) => value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= 1000);

/** One PTY registry and output implementation for UI tabs and managed commands/jobs. */
export class HostTerminalService {
  readonly manager: PtyManager<PtyOwner>;
  private readonly scopes = new Map<string, ScopeEntry>();
  private uiSink?: PtyEventSink;
  private fallback?: (owner: WebContents) => WebContents | null;

  constructor(deps: { spawn?: PtySpawnFn } = {}) {
    this.manager = new PtyManager<PtyOwner>({ spawn: deps.spawn,
      sink: {
        emitData: (owner, payload) => { if (isWindow(owner)) this.uiSink?.emitData(owner, payload); },
        emitExit: (owner, payload) => { if (isWindow(owner)) this.uiSink?.emitExit(owner, payload); },
      },
      resolveFallbackOwner: owner => isWindow(owner) ? this.fallback?.(owner) ?? null : null,
    });
  }

  bindUi(sink: PtyEventSink, fallback?: (owner: WebContents) => WebContents | null): void {
    this.uiSink = sink; this.fallback = fallback;
  }

  private disposeEntry(key: string, entry: ScopeEntry): void {
    if (this.scopes.get(key) !== entry) return;
    this.scopes.delete(key);
    entry.owner.destroy();
  }

  private resolve(scope: HostTerminalScope, create = false): ScopeEntry | undefined {
    let entry = this.scopes.get(scope.key);
    try { scope.assertCurrent(); } catch (error) {
      if (entry?.revision === scope.revision) this.disposeEntry(scope.key, entry);
      throw error;
    }
    if (entry) {
      let valid = entry.revision === scope.revision;
      try { entry.assertCurrent(); } catch { valid = false; }
      if (!valid) { this.disposeEntry(scope.key, entry); entry = undefined; }
    }
    if (!entry && create) {
      entry = { owner: new ProcessOwner(), revision: scope.revision, pluginId: scope.pluginId, assertCurrent: scope.assertCurrent };
      this.scopes.set(scope.key, entry);
    }
    return entry;
  }

  async start(scope: HostTerminalScope, input: Partial<HostTerminalStart>, signal?: AbortSignal): Promise<PtySnapshot> {
    scope.assertCurrent(); signal?.throwIfAborted();
    if (!dimensions(input.cols) || !dimensions(input.rows)) throw new Error('INVALID_TERMINAL_SIZE');
    const requested = input.cwd ?? scope.defaultCwd;
    if (!path.isAbsolute(requested) || requested.includes('\0')) throw new Error('INVALID_TERMINAL_CWD');
    if (input.cwd === undefined && scope.createDefaultCwd) await fs.mkdir(requested, { recursive: true });
    const cwd = await fs.realpath(requested);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('INVALID_TERMINAL_CWD');
    scope.assertCurrent(); signal?.throwIfAborted();
    const entry = this.resolve(scope, true)!;
    const id = randomUUID();
    try {
      this.manager.create({ ...input, id, cwd, owner: entry.owner, inheritEnv: false, env: scope.environment });
      scope.assertCurrent(); signal?.throwIfAborted();
      return this.manager.list(entry.owner).find(item => item.id === id)!;
    } catch (error) {
      this.manager.dispose(id);
      if (!this.manager.list(entry.owner).length) this.disposeEntry(scope.key, entry);
      throw error;
    }
  }

  list(scope: HostTerminalScope): PtySnapshot[] {
    const entry = this.resolve(scope);
    return entry ? this.manager.list(entry.owner) : [];
  }

  private require(scope: HostTerminalScope, id: string): ScopeEntry {
    const entry = this.resolve(scope);
    if (!entry || !this.manager.isOwned(id, entry.owner)) throw new Error('TERMINAL_NOT_FOUND');
    return entry;
  }

  read(scope: HostTerminalScope, id: string, cursor = 0, generation?: string) {
    this.require(scope, id);
    return this.manager.read(id, cursor, generation);
  }

  write(scope: HostTerminalScope, id: string, data: string): void {
    const entry = this.require(scope, id);
    if (Buffer.byteLength(data) > 64 * 1024) throw new Error('TERMINAL_INPUT_TOO_LARGE');
    if (this.manager.list(entry.owner).find(item => item.id === id)?.status !== 'running') throw new Error('TERMINAL_NOT_RUNNING');
    this.manager.write(id, data);
  }

  resize(scope: HostTerminalScope, id: string, cols: number, rows: number): void {
    this.require(scope, id);
    if (!dimensions(cols) || !dimensions(rows)) throw new Error('INVALID_TERMINAL_SIZE');
    this.manager.resize(id, cols, rows);
  }

  stop(scope: HostTerminalScope, id: string): void {
    this.require(scope, id); this.manager.stop(id);
  }

  forget(scope: HostTerminalScope, id: string): void {
    const entry = this.require(scope, id);
    if (this.manager.list(entry.owner).find(item => item.id === id)?.status !== 'exited') throw new Error('TERMINAL_STILL_RUNNING');
    this.manager.dispose(id);
    if (!this.manager.list(entry.owner).length) this.disposeEntry(scope.key, entry);
  }

  disposePlugin(id: string): void {
    for (const [key, entry] of this.scopes) if (entry.pluginId === id) this.disposeEntry(key, entry);
  }

  disposeScoped(): void {
    for (const [key, entry] of this.scopes) this.disposeEntry(key, entry);
  }
}
