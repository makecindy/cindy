import type { AsrEvent, AsrProvider, AudioTrace } from './types';

type BufferedChunk = {
  chunk: ArrayBuffer;
  trace?: AudioTrace;
};

/**
 * BufferedAsrProvider decorates any AsrProvider so audio can be appended while
 * the provider's start()/connect handshake is still in flight.
 *
 * Why this exists: capture and the ASR connection are started concurrently to
 * hide connect latency, but several providers silently drop appendAudio calls
 * until their handshake settles (e.g. a fallback provider whose appendAudio is
 * a no-op until the inner provider is chosen). Every consumer that parallelises
 * capture and connect would otherwise have to hand-roll the same buffering,
 * replay-in-order, and abandon-mid-handshake logic — which is exactly the class
 * of race bugs this wrapper removes:
 *
 * - appendAudio before the handshake settles is buffered locally and replayed
 *   in order once start() resolves, so nothing spoken during connect is lost.
 * - stop() while the handshake is in flight does NOT block on it (a cancel must
 *   stay instant); it discards the buffer and tears the inner provider down as
 *   soon as the handshake settles, so a just-opened socket is not leaked until
 *   the server times it out.
 * - A run abandoned mid-handshake (stop() before start() settled) is never
 *   revived: the settled handshake neither marks the provider ready nor replays
 *   buffered audio into a torn-down run.
 * - flushAudio() waits for the in-flight handshake to settle first, so an early
 *   stop still submits the audio buffered during connect instead of stranding a
 *   short utterance as empty text.
 *
 * The wrapper is restartable: each start() begins a fresh run. A stale
 * continuation from a previous run (an abandoned handshake that settles after
 * the next run already started) is ignored via a run token, and the new run
 * first waits for that handshake to settle and closes its connection before
 * opening its own, so an abandoned socket never outlives the run switch.
 */
export class BufferedAsrProvider implements AsrProvider {
  private readonly inner: AsrProvider;
  private buffer: BufferedChunk[] = [];
  private ready = false;
  private aborted = false;
  private startPromise: Promise<void> | null = null;
  private startSettled = false;
  private runToken = 0;
  // True while a new run is draining a previous run's still-in-flight
  // handshake (waiting for it to settle, then closing its connection). The
  // teardown of that abandoned socket emits normal 'disconnected'/'error'
  // events; forwarding them would make the consumer believe the NEW run's
  // transport just died before its own socket even opened.
  private drainingPriorRun = false;

  constructor(inner: AsrProvider) {
    this.inner = inner;
  }

  /**
   * recover is only exposed when the inner provider currently exposes it: some
   * providers assign recover dynamically (e.g. after a fallback chain picks its
   * active candidate), and callers feature-detect with `typeof asr.recover`.
   * Unconditionally defining it here would make a recovery attempt "succeed"
   * as a no-op and mask a dead transport.
   */
  get recover(): (() => Promise<void>) | undefined {
    const innerRecover = this.inner.recover;
    if (typeof innerRecover !== 'function') return undefined;
    return () => innerRecover.call(this.inner);
  }

  get rotateSession(): (() => Promise<void>) | undefined {
    const innerRotate = this.inner.rotateSession;
    if (typeof innerRotate !== 'function') return undefined;
    return () => innerRotate.call(this.inner);
  }

  start(): Promise<void> {
    this.runToken += 1;
    const token = this.runToken;
    this.buffer = [];
    this.ready = false;
    this.aborted = false;
    // A previous run's handshake may still be in flight (stop() during connect,
    // immediately followed by a fresh start()). Its own continuation bails out
    // on the token mismatch, so the new run must first wait for it to settle
    // and close the connection it opened — otherwise the abandoned socket
    // leaks until a server/client timeout instead of being torn down
    // deterministically.
    const priorStartPromise = this.startPromise && !this.startSettled ? this.startPromise : null;
    this.startSettled = false;
    this.startPromise = (async () => {
      if (priorStartPromise) {
        this.drainingPriorRun = true;
        await priorStartPromise.catch(() => undefined);
        await this.inner.stop().catch(() => undefined);
        // On supersession, the newer run's continuation owns (and clears) the
        // muting — it necessarily saw this still-unsettled promise as ITS prior.
        if (token !== this.runToken) return;
        this.drainingPriorRun = false;
      }
      try {
        await this.inner.start();
      } catch (error) {
        if (token === this.runToken) {
          this.startSettled = true;
          this.buffer = [];
        }
        throw error;
      }
      if (token !== this.runToken) return;
      if (this.aborted) {
        // The run was abandoned while the handshake was in flight. The inner
        // socket only just opened (stop()'s own inner.stop() ran before there
        // was anything to close), so close it now instead of leaking the
        // connection, and never replay buffered audio into a torn-down run.
        //
        // startSettled stays false until this teardown COMPLETES: a retry that
        // starts while the abandoned stop is still in flight must treat this
        // run as its drainable prior (and wait for it) — otherwise its fresh
        // inner.start() would race the old close, which can reset the new
        // socket on providers whose stop() awaits async teardown.
        this.buffer = [];
        await this.inner.stop().catch(() => undefined);
        if (token === this.runToken) this.startSettled = true;
        return;
      }
      this.startSettled = true;
      this.ready = true;
      const buffered = this.buffer;
      this.buffer = [];
      for (const entry of buffered) this.inner.appendAudio(entry.chunk, entry.trace);
    })();
    return this.startPromise;
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    if (this.aborted) return;
    if (this.ready) {
      this.inner.appendAudio(chunk, trace);
      return;
    }
    this.buffer.push({ chunk, trace });
  }

  async flushAudio(): Promise<void> {
    // Wait for the in-flight handshake so audio buffered during connect is
    // replayed (by the start() continuation) before the flush is issued.
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    if (!this.ready || this.aborted) return;
    await this.inner.flushAudio();
  }

  async stop(): Promise<void> {
    this.aborted = true;
    this.buffer = [];
    // With the handshake still in flight, do NOT block on it — a cancel must
    // return immediately. The start() continuation observes `aborted` when the
    // handshake settles and tears the inner provider down there.
    if (this.startPromise && !this.startSettled) return;
    await this.inner.stop();
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.inner.onEvent((event) => {
      // Drop events emitted while draining a previous run's abandoned
      // handshake (see drainingPriorRun) — they describe the old socket's
      // teardown, not the current run's transport.
      if (this.drainingPriorRun) return;
      callback(event);
    });
  }
}
