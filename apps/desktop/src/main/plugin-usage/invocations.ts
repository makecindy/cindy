import { randomUUID } from 'node:crypto';
import type { PluginUsageEntryKind, PluginUsageOutcome } from '../../shared/pluginUsage.js';

export type PluginInvocationKind = PluginUsageEntryKind;

export interface PluginInvocationObserver {
  isCurrent(): boolean;
  accepted(id: string, kind: PluginInvocationKind, at: number): void;
  settled(id: string, outcome: PluginUsageOutcome): void;
}

/** Host-only correlation. An invocation is never an execution permission. */
export interface PluginInvocation {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: PluginInvocationKind;
}

interface Entry extends PluginInvocation {
  scope: string;
  expiresAt: number;
  accepted: boolean;
  observer: PluginInvocationObserver | null;
}
interface InvocationSource {
  id?: string;
  parentId?: string;
  operation?: string;
  sessionId?: string;
}

const LIFETIME_MS = 600_000;
const MAX_ENTRIES = 4096;
const invalid = (): never => { throw new Error('INVALID_INVOCATION'); };

/**
 * One registry per Host owner epoch. Only real Host entry points call begin/accept;
 * plugins can reference an already accepted parent, never mint or increment one.
 */
export class PluginInvocations {
  private readonly entries = new Map<string, Entry>();
  private readonly issued = new WeakMap<PluginInvocation, Entry>();
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: {
    scope(pluginId: string): string | null;
    observe(pluginId: string, source: InvocationSource): PluginInvocationObserver | null;
    now?: () => number;
    id?: () => string;
  }) {
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  begin(pluginId: string, kind: PluginInvocationKind, source: InvocationSource = {}): PluginInvocation {
    if (source.parentId !== undefined) {
      const parent = this.current(source.parentId, pluginId);
      if (!parent.accepted) return invalid();
      return parent;
    }
    const scope = this.deps.scope(pluginId);
    if (!scope) return invalid();
    const id = source.id ?? this.id();
    const existing = this.entries.get(id);
    if (existing) {
      const entry = this.current(id, pluginId);
      if (entry.kind !== kind) return invalid();
      return entry;
    }
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now || this.deps.scope(entry.pluginId) !== entry.scope) this.entries.delete(key);
    }
    // Statistical bookkeeping must stay bounded. Old confirmed entries can no
    // longer be used as parents after eviction; they never become new events.
    if (this.entries.size >= MAX_ENTRIES) throw new Error('INVOCATION_LIMIT');
    const entry: Entry = { id, pluginId, kind, scope, expiresAt: now + LIFETIME_MS,
      accepted: false, observer: this.deps.observe(pluginId, source) };
    this.entries.set(id, entry);
    this.issued.set(entry, entry);
    return entry;
  }

  accept(invocation: PluginInvocation): void {
    const entry = this.current(invocation.id, invocation.pluginId);
    if (entry !== invocation) return invalid();
    if (entry.accepted) return;
    entry.accepted = true;
    entry.observer?.accepted(entry.id, entry.kind, this.now());
  }

  settle(invocation: PluginInvocation, outcome: PluginUsageOutcome): void {
    // Expiring parent correlation must not discard a long-running tool's result.
    // Only the original Host-held token can settle, in its original owner scope.
    const entry = this.issued.get(invocation);
    // Disabling the plugin blocks new calls, but its already accepted tool must
    // still record cancellation. The frozen observer checks owner/history scope.
    if (!entry || entry.observer?.isCurrent() === false) return invalid();
    if (entry.accepted) entry.observer?.settled(entry.id, outcome);
  }

  /** Only Host execution services call this after confirming their side effect. */
  acceptIdentity(pluginId: string, id: string): void {
    this.accept(this.current(id, pluginId));
  }

  invalidate(pluginId: string): void {
    for (const [id, entry] of this.entries) if (entry.pluginId === pluginId) {
      this.entries.delete(id);
      this.issued.delete(entry);
    }
  }

  private current(id: string, pluginId: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.pluginId !== pluginId || entry.expiresAt <= this.now() ||
      this.deps.scope(pluginId) !== entry.scope || entry.observer?.isCurrent() === false) return invalid();
    return entry;
  }
}
