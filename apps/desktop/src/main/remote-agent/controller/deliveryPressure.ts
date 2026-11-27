/** Peer-local admission after an actual unsent/backpressure failure. */
export function isDeliveryBackpressure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'BACKPRESSURE' || ((code === undefined || code === 'IPC_ERROR')
    && /\bBACKPRESSURE\b/.test(error instanceof Error ? error.message : String(error)));
}

interface Delivery {
  invoke(): Promise<unknown>;
  signal: AbortSignal;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  stop(): void;
}

/**
 * All runs using one peer poller share pressure evidence. Healthy first sends
 * remain concurrent; after BACKPRESSURE only one queued RPC probes capacity.
 * Failed probes back off together, successful round trips drain the FIFO one
 * RPC at a time. No payloads, identities, retry counts or wire IDs are changed.
 */
export class RemoteAgentDeliveryGate {
  private pressured = false;
  private delay = 500;
  private retryAt = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue = new Set<Delivery>();

  invoke(invoke: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.pressured) return this.attempt(invoke, false);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.queue.delete(delivery)) return;
        delivery.stop();
        reject(signal.reason);
        if (this.queue.size === 0 && this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
      };
      const delivery: Delivery = { invoke, signal, resolve, reject,
        stop: () => signal.removeEventListener('abort', cancel) };
      this.queue.add(delivery);
      signal.addEventListener('abort', cancel, { once: true });
      this.drain();
    });
  }

  private async attempt(invoke: () => Promise<unknown>, probe: boolean): Promise<unknown> {
    try {
      const result = await invoke();
      if (probe) this.delay = 500;
      return result;
    } catch (error) {
      if (isDeliveryBackpressure(error)) {
        // Concurrent initial failures are one pressure episode, not twenty
        // exponential-backoff steps. Only an admitted probe advances backoff.
        if (!this.pressured) {
          this.pressured = true;
          this.delay = 500;
          this.retryAt = performance.now() + this.delay;
        } else if (probe) {
          this.delay = Math.min(this.delay * 2, 5_000);
          this.retryAt = performance.now() + this.delay;
        }
      }
      throw error;
    }
  }

  private drain(): void {
    if (this.running || this.timer || this.queue.size === 0) return;
    const wait = this.retryAt - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.drain(); }, wait);
      return;
    }
    const delivery = this.queue.values().next().value!;
    this.queue.delete(delivery);
    delivery.stop();
    this.running = true;
    let succeeded = false;
    void this.attempt(() => delivery.signal.aborted
      ? Promise.reject(delivery.signal.reason) : delivery.invoke(), true).then(value => {
      succeeded = true;
      delivery.resolve(value);
    }, delivery.reject).finally(() => {
      this.running = false;
      // An old first-send success cannot release a pressured backlog. Only a
      // successful admitted probe with no remaining demand restores concurrency.
      if (succeeded && this.queue.size === 0) this.pressured = false;
      this.drain();
    });
  }
}
