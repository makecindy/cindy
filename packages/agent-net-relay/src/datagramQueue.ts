import WebSocket from 'ws';

/**
 * Relay WebSockets carry the encrypted core's datagrams, which may be lost exactly like UDP: the core
 * resends whatever does not arrive. A WebSocket is TCP, which never drops and only queues.
 * 2026-11-13 17:23–17:35: one device's relay path slowed down; acknowledgements took up to 156s while
 * device-link held just 16 small messages, and the core's resends queued behind the originals, so
 * results arrived minutes late and reads executed 95s after they were sent. The only limit was 1 MiB
 * of buffered bytes, which at a low message rate is minutes of traffic.
 *
 * A write that has waited this long to leave the process is several round trips old: holding more adds
 * delay, never throughput. While the oldest write on a connection is older than this, new datagrams for
 * it are dropped until the queue moves again, and the core sees loss instead of an ever-growing round
 * trip. Control messages are always written. Used by the relay toward each device and by Desktop Main
 * toward the relay; the byte caps at the call sites are unchanged.
 */
export const MAX_DATAGRAM_QUEUE_DELAY_MS = 1_000;
/** One stall report per connection per window: a flapping link must not flood the log. */
const REPORT_INTERVAL_MS = 30_000;

export interface DatagramQueueReport {
  /** The oldest write has waited `waitedMs`; new datagrams are being dropped. At most once per 30s. */
  stalled?(waitedMs: number, bufferedBytes: number): void;
  /** The queue moves again after a reported stall. */
  moving?(dropped: number, droppedBytes: number, bufferedBytes: number): void;
}

/**
 * Write tracking for one `ws` WebSocket. It needs `ws`'s write-completion callback, which `ws` runs in
 * write order, so the head of `times` is the oldest write not yet handed to the operating system.
 * Not for sockets without that callback (React Native, the Desktop worker's proxy socket): there the
 * oldest write would never complete and every datagram would be dropped.
 */
export class DatagramSendQueue {
  private times: number[] = [];
  private head = 0;
  private dropped = 0;
  private droppedBytes = 0;
  private stalled = false;
  private reported = false;
  private reportedAt = -Infinity;
  constructor(
    private readonly ws: WebSocket,
    private readonly report: DatagramQueueReport = {},
    private readonly maxDelayMs = MAX_DATAGRAM_QUEUE_DELAY_MS,
  ) {}
  /** Never dropped here. */
  sendControl(text: string): void { this.write(text, false); }
  /** False when dropped because the connection's queue has stopped moving. A long event-loop stall
   * can make a few writes look old; dropping those costs the core one resend, never data. */
  sendDatagram(data: Uint8Array): boolean {
    const now = performance.now(), waitedMs = this.oldestWaitMs(now);
    if (waitedMs > this.maxDelayMs) {
      this.dropped++; this.droppedBytes += data.byteLength;
      if (!this.stalled) {
        this.stalled = true;
        if (now - this.reportedAt >= REPORT_INTERVAL_MS) {
          this.reported = true; this.reportedAt = now;
          this.report.stalled?.(waitedMs, this.ws.bufferedAmount);
        }
      }
      return false;
    }
    this.write(data, true);
    return true;
  }
  private oldestWaitMs(now: number): number { return this.head < this.times.length ? now - this.times[this.head] : 0; }
  private write(data: string | Uint8Array, binary: boolean): void {
    this.times.push(performance.now());
    this.ws.send(data, { binary }, this.flushed);
  }
  /** One shared function, so the hot path allocates no closure per datagram. */
  private readonly flushed = (): void => {
    if (this.head < this.times.length) this.head++;
    if (this.head >= 1024 && this.head * 2 >= this.times.length) { this.times = this.times.slice(this.head); this.head = 0; }
    if (!this.stalled || this.oldestWaitMs(performance.now()) > this.maxDelayMs) return;
    if (this.reported && this.ws.readyState === WebSocket.OPEN) this.report.moving?.(this.dropped, this.droppedBytes, this.ws.bufferedAmount);
    this.stalled = false; this.reported = false; this.dropped = 0; this.droppedBytes = 0;
  };
}
