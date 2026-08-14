import { randomUUID } from "node:crypto";

export interface IOSSimulatorDiagnosticsEntry {
  diagnosticsId: string;
  sessionId: string;
  kind: string;
  createdAt: string;
  expiresAt: string;
  data: Record<string, unknown>;
}

export interface IOSSimulatorDiagnosticsStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  maxJsonBytes?: number;
}

/** Session-namespaced, bounded, in-memory diagnostics with no subprocess log disclosure. */
export class IOSSimulatorDiagnosticsStore {
  readonly #entries = new Map<string, IOSSimulatorDiagnosticsEntry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxJsonBytes: number;

  constructor(options: IOSSimulatorDiagnosticsStoreOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? 60 * 60_000;
    this.#maxEntries = options.maxEntries ?? 64;
    this.#maxJsonBytes = options.maxJsonBytes ?? 64 * 1024;
  }

  record(
    sessionId: string,
    kind: string,
    data: Record<string, unknown>,
  ): IOSSimulatorDiagnosticsEntry {
    this.#prune();
    const serialized = JSON.stringify(data);
    const boundedData =
      Buffer.byteLength(serialized) <= this.#maxJsonBytes
        ? data
        : {
            truncated: true,
            summary: serialized.slice(0, this.#maxJsonBytes / 2),
          };
    const now = this.#now();
    const entry: IOSSimulatorDiagnosticsEntry = {
      diagnosticsId: randomUUID(),
      sessionId,
      kind: kind.slice(0, 128),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
      data: boundedData,
    };
    this.#entries.set(entry.diagnosticsId, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#entries.delete(oldest);
    }
    return structuredClone(entry);
  }

  get(
    sessionId: string,
    diagnosticsId: string,
  ): IOSSimulatorDiagnosticsEntry | null {
    this.#prune();
    const entry = this.#entries.get(diagnosticsId);
    return entry?.sessionId === sessionId ? structuredClone(entry) : null;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (Date.parse(entry.expiresAt) <= now) this.#entries.delete(id);
    }
  }
}
