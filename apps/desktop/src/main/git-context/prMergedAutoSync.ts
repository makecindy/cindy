import { prStatusKey, type PrStatusKind } from '@cindy/maker-shared';
import type { AutoFastForwardResult } from '../worktree/branchSync.js';
import type { PrStatusQuery, PrStatusResult } from './prStatusService.js';

export interface PrMergedAutoSyncDeps {
  /** Resolve unique local repository roots associated with sessions referencing this PR. */
  findLocalBaseReposForPr: (query: PrStatusQuery) => Promise<readonly string[]>;
  /** Zero-token, strictly clean fast-forward of the repo's local default branch. */
  fastForwardDefaultBranch: (baseRepo: string) => Promise<AutoFastForwardResult>;
  /** Optional hook after a local default branch fast-forwards (e.g. refresh git context). */
  onUpdated?: (baseRepo: string, branch: string, updated: number) => void;
  /** Cooldown per repo root so simultaneous PR merges coalesce cleanly. */
  cooldownMs?: number;
  now?: () => number;
  log?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_COOLDOWN_MS = 10_000;

/**
 * Watches observed PR states and automatically fast-forwards the local default branch
 * of matching clean repositories when a PR transitions from a non-merged state to `merged`.
 *
 * Never triggers on initial cold-start observations of already-merged PRs, and never
 * touches dirty, diverged, or ahead checkouts (delegated to `tryFastForwardDefaultBranchAfterMerge`).
 */
export class PrMergedAutoSync {
  private readonly seenStatus = new Map<string, PrStatusKind>();
  private readonly inflightRepos = new Set<string>();
  private readonly lastSyncedAt = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: PrMergedAutoSyncDeps) {
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = deps.now ?? Date.now;
  }

  observe(query: PrStatusQuery, result: PrStatusResult): void {
    if (!result.ok) return;
    const key = prStatusKey(query);
    const prev = this.seenStatus.get(key);
    this.seenStatus.set(key, result.status);
    if (prev === undefined || prev === 'merged' || result.status !== 'merged') {
      return;
    }
    void this.handleMerged(query).catch((err) => {
      this.deps.log?.warn('pr merged auto fast-forward failed', {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  reset(): void {
    this.seenStatus.clear();
    this.lastSyncedAt.clear();
  }

  private async handleMerged(query: PrStatusQuery): Promise<void> {
    const repos = await this.deps.findLocalBaseReposForPr(query);
    const uniqueRepos = [...new Set(repos.filter(Boolean))];
    for (const baseRepo of uniqueRepos) {
      if (this.inflightRepos.has(baseRepo)) continue;
      const last = this.lastSyncedAt.get(baseRepo);
      if (last !== undefined && this.now() - last < this.cooldownMs) continue;
      this.inflightRepos.add(baseRepo);
      this.lastSyncedAt.set(baseRepo, this.now());
      try {
        const outcome = await this.deps.fastForwardDefaultBranch(baseRepo);
        if (outcome.status === 'updated') {
          this.deps.log?.info('auto fast-forwarded local default branch after PR merge', {
            baseRepo,
            branch: outcome.branch,
            updated: outcome.updated,
            pr: prStatusKey(query),
          });
          this.deps.onUpdated?.(baseRepo, outcome.branch, outcome.updated);
        } else {
          this.deps.log?.debug?.('skipped auto fast-forward after PR merge', {
            baseRepo,
            reason: outcome.reason,
            pr: prStatusKey(query),
          });
        }
      } catch (err) {
        this.deps.log?.warn('auto fast-forward after PR merge threw', {
          baseRepo,
          err: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.inflightRepos.delete(baseRepo);
      }
    }
  }
}
