import { randomUUID } from 'node:crypto';

import type {
  ReviewArtifactConfirmDialogModel,
  ReviewArtifactConfirmRequest,
} from '../../shared/reviewArtifactConfirm.js';

const DEFAULT_TIMEOUT_MS = 90_000;

export interface ReviewArtifactConfirmTarget {
  id: number;
  send(payload: ReviewArtifactConfirmRequest): boolean;
  dismiss(requestId: string): boolean;
  onDestroyed(callback: () => void): () => void;
}

export interface ReviewArtifactConfirmBridgeOptions {
  timeoutMs?: number;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

interface PendingConfirmation {
  ownerId: number;
  dismiss(): boolean;
  resolve(confirmed: boolean): void;
  timeoutId: ReturnType<typeof setTimeout>;
  stopWatchingOwner(): void;
}

/** Main keeps the authorization decision; renderer only displays sanitized copy. */
export class ReviewArtifactConfirmBridge {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private readonly options: ReviewArtifactConfirmBridgeOptions = {}) {}

  request(
    target: ReviewArtifactConfirmTarget,
    model: ReviewArtifactConfirmDialogModel,
  ): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.options.log?.warn('review artifact confirmation timed out; access denied', {
          requestId,
          ownerId: target.id,
        });
        this.settle(requestId, false, true);
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const entry: PendingConfirmation = {
        ownerId: target.id,
        dismiss: () => target.dismiss(requestId),
        resolve,
        timeoutId,
        stopWatchingOwner: () => {},
      };
      this.pending.set(requestId, entry);
      let stopWatchingOwner: () => void;
      try {
        stopWatchingOwner = target.onDestroyed(() => this.settle(requestId, false));
      } catch (error) {
        this.options.log?.warn('review artifact owner watch failed; access denied', {
          requestId,
          ownerId: target.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.settle(requestId, false);
        return;
      }
      entry.stopWatchingOwner = stopWatchingOwner;
      if (!this.pending.has(requestId)) {
        stopWatchingOwner();
        return;
      }

      try {
        if (!target.send({ requestId, ...model })) {
          this.settle(requestId, false);
        }
      } catch (error) {
        this.options.log?.warn('review artifact confirmation delivery failed; access denied', {
          requestId,
          ownerId: target.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.settle(requestId, false);
      }
    });
  }

  resolve(ownerId: number, requestId: unknown, confirmed: unknown): boolean {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return false;
    }
    const entry = this.pending.get(requestId);
    if (!entry || entry.ownerId !== ownerId) return false;
    if (typeof confirmed !== 'boolean') {
      this.options.log?.warn('invalid review artifact confirmation response; access denied', {
        requestId,
        ownerId,
      });
    }
    this.settle(requestId, confirmed === true);
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private settle(requestId: string, confirmed: boolean, dismissRenderer = false): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.stopWatchingOwner();
    if (dismissRenderer) {
      try {
        entry.dismiss();
      } catch (error) {
        this.options.log?.warn('review artifact confirmation dismissal failed', {
          requestId,
          ownerId: entry.ownerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    entry.resolve(confirmed);
  }
}
