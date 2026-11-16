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
  onClosed?(dispose: () => void): () => void;
}

export type HostTerminalStart = Pick<CreateOptions, 'cwd' | 'program' | 'cols' | 'rows' | 'shellPref'>;

class ProcessOwner extends EventEmitter implements PtyOwner {
  private destroyed = false;
  readonly settled: string[] = [];
  isDestroyed() { return this.destroyed; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.settled.length = 0; this.emit('destroyed'); } }
}

interface ScopeEntry {
  revision: string;
  pluginId?: string;
  owner: ProcessOwner;
  pendingStarts: number;
  assertCurrent(): void;
  unsubscribeClose?: () => void;
}

// DSH jobs-local/src/index.ts:34 uses 10 active jobs per exact owner.
const MAX_CONCURRENT_JOBS_PER_OWNER = 10;
// Cindy additionally bounds terminal history even when callers never forget it.
const MAX_SETTLED_JOBS_PER_OWNER = 100;

/** Stable admission failure shared by the native tool and plugin result. */
class TerminalJobLimitError extends Error {
  readonly limit = MAX_CONCURRENT_JOBS_PER_OWNER;
  constructor(readonly current: number) { super('TERMINAL_JOB_LIMIT'); }
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
        emitExit: (owner, payload) => {
          if (isWindow(owner)) this.uiSink?.emitExit(owner, payload);
          else if (owner instanceof ProcessOwner) {
            owner.settled.push(payload.id);
            while (owner.settled.length > MAX_SETTLED_JOBS_PER_OWNER) this.manager.dispose(owner.settled.shift()!);
          }
        },
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
    entry.unsubscribeClose?.();
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
      entry = { owner: new ProcessOwner(), pendingStarts: 0, revision: scope.revision, pluginId: scope.pluginId, assertCurrent: scope.assertCurrent };
      this.scopes.set(scope.key, entry);
      const captured = entry;
      entry.unsubscribeClose = scope.onClosed?.(() => this.disposeEntry(scope.key, captured));
    }
    return entry;
  }

  async start(scope: HostTerminalScope, input: Partial<HostTerminalStart>, signal?: AbortSignal): Promise<PtySnapshot> {
    scope.assertCurrent(); signal?.throwIfAborted();
    if (!dimensions(input.cols) || !dimensions(input.rows)) throw new Error('INVALID_TERMINAL_SIZE');
    const requested = input.cwd ?? scope.defaultCwd;
    if (!path.isAbsolute(requested) || requested.includes('\0')) throw new Error('INVALID_TERMINAL_CWD');
    const entry = this.resolve(scope, true)!;
    const active = entry.pendingStarts + this.manager.list(entry.owner).filter(job => job.status !== 'exited').length;
    if (active >= MAX_CONCURRENT_JOBS_PER_OWNER) throw new TerminalJobLimitError(active);
    // Reserve synchronously before filesystem work so parallel starts cannot
    // oversubscribe. Disposal invalidates this exact entry rather than recreating it.
    entry.pendingStarts++;
    const id = randomUUID();
    try {
      if (input.cwd === undefined && scope.createDefaultCwd) await fs.mkdir(requested, { recursive: true });
      const cwd = await fs.realpath(requested);
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('INVALID_TERMINAL_CWD');
      scope.assertCurrent(); signal?.throwIfAborted();
      if (this.resolve(scope) !== entry) throw new Error('TERMINAL_SCOPE_CHANGED');
      this.manager.create({ ...input, id, cwd, owner: entry.owner, inheritEnv: false, env: scope.environment, retainOutput: true });
      scope.assertCurrent(); signal?.throwIfAborted();
      return this.manager.list(entry.owner).find(item => item.id === id)!;
    } catch (error) {
      this.manager.dispose(id);
      throw error;
    } finally {
      entry.pendingStarts--;
      if (!entry.pendingStarts && !this.manager.list(entry.owner).length) this.disposeEntry(scope.key, entry);
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
    const index = entry.owner.settled.indexOf(id);
    if (index >= 0) entry.owner.settled.splice(index, 1);
    if (!entry.pendingStarts && !this.manager.list(entry.owner).length) this.disposeEntry(scope.key, entry);
  }

  disposePlugin(id: string): void {
    for (const [key, entry] of this.scopes) if (entry.pluginId === id) this.disposeEntry(key, entry);
  }

  disposeScoped(): void {
    for (const [key, entry] of this.scopes) this.disposeEntry(key, entry);
  }
}
