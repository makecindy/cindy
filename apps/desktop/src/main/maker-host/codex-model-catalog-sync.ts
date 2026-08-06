import type { Logger } from '@cindy/maker-core';

export interface CodexModelCatalogSyncDeps {
  revision: () => number;
  writeModelsCache: (revision: number, isCurrent?: () => boolean) => Promise<void>;
  logger: Pick<Logger, 'debug' | 'warn'>;
}

/** The vendor cache has no trustworthy native ModelInfo template yet. */
export class CodexModelCatalogNeedsNativeModelsError extends Error {
  constructor(message = 'Codex native model catalog is not ready') {
    super(message);
    this.name = 'CodexModelCatalogNeedsNativeModelsError';
  }
}

export class CodexModelCatalogStaleGenerationError extends Error {
  constructor() {
    super('Codex model catalog synchronization was superseded by a newer owner generation');
    this.name = 'CodexModelCatalogStaleGenerationError';
  }
}

/**
 * Synchronizes the long-lived local Codex process to the host catalog revision.
 * One refresh may serve many sessions; failures remain retryable for the next
 * session instead of poisoning the revision as applied.
 */
export class CodexModelCatalogSync {
  private appliedRevision = -1;
  private generation = 0;
  private inflight: { generation: number; promise: Promise<void> } | null = null;

  constructor(private readonly deps: CodexModelCatalogSyncDeps) {}

  async ensureFresh(refresh: () => Promise<void>): Promise<void> {
    for (;;) {
      const generation = this.generation;
      const targetRevision = this.deps.revision();
      if (this.appliedRevision === targetRevision) return;

      const existing = this.inflight;
      if (existing) {
        try {
          await existing.promise;
        } catch (error) {
          // A reset retires the old auth/owner generation. Its late failure must
          // not poison a caller that is already operating in the new boundary.
          if (existing.generation === this.generation) throw error;
        }
        continue;
      }

      const run = this.refresh(targetRevision, generation, refresh);
      const entry = { generation, promise: run };
      this.inflight = entry;
      try {
        await run;
      } catch (error) {
        if (generation === this.generation) throw error;
      } finally {
        if (this.inflight === entry) this.inflight = null;
      }

      // Catalog revision or auth generation changed while I/O was in flight.
      // Loop until the caller observes the actual current state.
      if (
        generation === this.generation
        && this.appliedRevision === this.deps.revision()
      ) return;
    }
  }

  reset(): void {
    this.generation += 1;
    this.appliedRevision = -1;
  }

  private async refresh(
    targetRevision: number,
    generation: number,
    refresh: () => Promise<void>,
  ): Promise<void> {
    try {
      await this.deps.writeModelsCache(targetRevision, () => generation === this.generation);
      if (generation !== this.generation) return;
      await refresh();
    } catch (error) {
      if (error instanceof CodexModelCatalogStaleGenerationError) return;
      if (!(error instanceof CodexModelCatalogNeedsNativeModelsError)) throw error;
      // Fresh install / malformed vendor cache: model/list is Codex's official
      // cache warm-up barrier. The local /models handler returns native + Cindy
      // projection; once Codex persists it, retry the provenance-aware write.
      await refresh();
      if (generation !== this.generation) return;
      await this.deps.writeModelsCache(targetRevision, () => generation === this.generation);
    }
    if (generation !== this.generation || targetRevision !== this.deps.revision()) return;
    this.appliedRevision = targetRevision;
    this.deps.logger.debug('Codex runtime model catalog synchronized', {
      revision: targetRevision,
    });
  }
}
