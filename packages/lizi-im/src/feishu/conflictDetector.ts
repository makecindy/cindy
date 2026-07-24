/**
 * feishu/conflictDetector.ts
 * ---------------------------------------------------------------------------
 * Heuristic for "the feishu App credential is already used on another device".
 *
 * @larksuiteoapi/node-sdk's WSClient has no dedicated "kicked"/"replaced"
 * event — multi-device conflicts surface as "WS close → schedule reconnect →
 * close again". We disambiguate by:
 *
 *   - if `onReady` does NOT fire within `readyTimeoutMs` (default 8s), AND
 *   - we saw ≥ `reconnectThreshold` (default 2) `onReconnecting` events,
 *
 * → verdict `conflict`. If `onReady` fires in time → `connected`. If `onError`
 * fires (SDK gives up) → `error`.
 *
 * Single-use: each `start()` constructs a fresh detector.
 */

import type { ConnectVerdict } from './internal-types.js';

interface ConflictDetectorOptions {
  /** How long to wait for onReady before judging conflict/error. Default 8000ms. */
  readyTimeoutMs?: number;
  /** Number of onReconnecting events that count as a conflict signal. Default 2. */
  reconnectThreshold?: number;
}

export class ConflictDetector {
  private readonly readyTimeoutMs: number;
  private readonly reconnectThreshold: number;
  private reconnectCount = 0;
  private resolved = false;
  private verdict: ConnectVerdict | null = null;
  private resolver: ((v: ConnectVerdict) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly verdictPromise: Promise<ConnectVerdict>;

  constructor(opts: ConflictDetectorOptions = {}) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 8000;
    this.reconnectThreshold = opts.reconnectThreshold ?? 2;

    this.verdictPromise = new Promise<ConnectVerdict>((resolve) => {
      this.resolver = resolve;
    });

    this.timer = setTimeout(() => {
      if (this.resolved) return;
      const isConflict = this.reconnectCount >= this.reconnectThreshold;
      this.resolve(
        isConflict
          ? { kind: 'conflict' }
          : {
              kind: 'error',
              message: 'Timed out waiting for connection (no onReady).',
            },
      );
    }, this.readyTimeoutMs);
  }

  markReady(): boolean {
    return this.resolve({ kind: 'connected' });
  }

  markReconnecting(): boolean {
    if (this.resolved) return false;
    this.reconnectCount++;
    return true;
  }

  markReconnected(): boolean {
    return this.resolve({ kind: 'connected' });
  }

  markConflict(): boolean {
    return this.resolve({ kind: 'conflict' });
  }

  markError(err: Error): boolean {
    return this.resolve({ kind: 'error', message: err.message ?? 'Unknown error' });
  }

  getVerdict(): ConnectVerdict | null {
    return this.verdict;
  }

  waitForVerdict(): Promise<ConnectVerdict> {
    return this.verdictPromise;
  }

  abandon(): boolean {
    return this.resolve({ kind: 'error', message: 'Abandoned by caller.' });
  }

  private resolve(v: ConnectVerdict): boolean {
    if (this.resolved) return false;
    this.resolved = true;
    this.verdict = v;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.resolver) {
      this.resolver(v);
      this.resolver = null;
    }
    return true;
  }
}
