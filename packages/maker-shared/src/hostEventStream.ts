/** Loopback Host transport only. No task execution, credentials or UI state. */
export type HostRecoveryReason = 'initial' | 'restarted' | 'history-lost' | 'invalid-cursor' | 'legacy';
export interface HostConnectionState {
  status: 'connecting' | 'connected' | 'disconnected' | 'authorization-required';
  connection: number;
  recovery: number;
  reason?: HostRecoveryReason;
}
export interface HostConnectionApi {
  readonly client?: 'browser' | 'desktop';
  onStateChanged(listener: (state: HostConnectionState) => void): () => void;
  retry(): void;
}

/** Incremental SSE decoder, including split CRLF/UTF-8 and multiline data. */
export function createHostFrameDecoder(deliver: (frame: Record<string, unknown>) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  return (bytes: Uint8Array) => {
    buffer += decoder.decode(bytes, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const text = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = text.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      let frame: unknown;
      try { frame = JSON.parse(data); } catch { throw new Error('Invalid Host event frame'); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid Host event frame');
      deliver(frame as Record<string, unknown>);
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Host event frame exceeds limit');
  };
}

export function startHostEventStream(input: {
  open: (query: string, signal: AbortSignal) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'body'>>;
  beforeEvents?: (signal: AbortSignal) => Promise<void>;
  onEvent: (event: Record<string, any>) => void;
  onState: (state: HostConnectionState) => void;
  onError?: (error: unknown) => void;
}) {
  let stopped = false;
  let unauthorized = false;
  let restartRequested = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let runtime: string | null = null;
  let seq: number | null = null;
  let state: HostConnectionState = { status: 'connecting', connection: 0, recovery: 0 };
  const notify = (status: HostConnectionState['status'], reason?: HostRecoveryReason) => {
    state = { ...state, status, ...(reason ? { recovery: state.recovery + 1, reason } : {}) };
    input.onState(state);
  };
  const cancelRetry = () => { clearTimeout(retryTimer); retryTimer = undefined; };
  const authorizationRequired = () => {
    unauthorized = true;
    cancelRetry();
    controller?.abort();
    notify('authorization-required');
  };
  const connect = async () => {
    if (stopped || controller || unauthorized) return;
    const abort = new AbortController();
    controller = abort;
    restartRequested = false;
    state = { ...state, connection: state.connection + 1 };
    notify('connecting');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let ready = false;
    let started = false;
    // Host emits a comment heartbeat every 15 seconds. A half-open socket must
    // not leave the UI claiming it is connected forever (e.g. after sleep).
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => abort.abort(), 45_000);
    };
    armWatchdog();
    try {
      const query = new URLSearchParams({ protocol: '2' });
      if (seq !== null) query.set('since', String(seq));
      if (runtime !== null) query.set('runtime', runtime);
      const response = await input.open(`?${query}`, abort.signal);
      if (abort.signal.aborted) return;
      if (response.status === 401) { authorizationRequired(); return; }
      if (!response.ok || !response.body) throw new Error(`Host events HTTP_${response.status}`);
      reader = response.body.getReader();
      abort.signal.addEventListener('abort', () => { void reader?.cancel().catch(() => undefined); }, { once: true });
      await input.beforeEvents?.(abort.signal);
      if (abort.signal.aborted) return;
      const versioned = response.headers.get('x-cindy-event-protocol') === '2';
      ready = !versioned;
      let boundary = 0;
      let recovery: HostRecoveryReason | undefined;
      if (!versioned) notify('connected', 'legacy');
      const decode = createHostFrameDecoder(frame => {
        if (versioned && frame.type === 'host_stream') {
          if (typeof frame.runtime !== 'string' || !Number.isSafeInteger(frame.seq) || Number(frame.seq) < 0) {
            throw new Error('Invalid Host stream cursor');
          }
          if (frame.phase === 'start') {
            if (started) throw new Error('Duplicate Host stream start');
            started = true;
            boundary = Number(frame.seq);
            runtime = frame.runtime;
            const reason = frame.reason;
            if (reason !== null && !['initial', 'restarted', 'history-lost', 'invalid-cursor'].includes(String(reason))) {
              throw new Error('Invalid Host recovery reason');
            }
            recovery = reason === null ? undefined : reason as HostRecoveryReason;
            if (recovery) seq = Number(frame.seq);
          } else if (frame.phase === 'ready') {
            if (!started || ready || runtime !== frame.runtime || boundary !== frame.seq
              || (seq !== null && seq !== boundary)) throw new Error('Incomplete Host replay');
            seq = Number(frame.seq);
            ready = true;
            notify('connected', recovery);
          } else throw new Error('Invalid Host stream phase');
          return;
        }
        if (versioned && !started) throw new Error('Host event before stream start');
        const nextSeq = frame.seq;
        if (!Number.isSafeInteger(nextSeq) || Number(nextSeq) < 1) throw new Error('Invalid Host event cursor');
        if (versioned && seq !== null && Number(nextSeq) <= seq) return;
        if (versioned && seq !== null && Number(nextSeq) !== seq + 1) {
          // Do not silently apply a partial replay. The next connection requests
          // snapshots; user inputs are never retried by this transport.
          runtime = null;
          seq = null;
          throw new Error('Gap in Host event stream');
        }
        input.onEvent(frame);
        seq = Number(nextSeq);
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (abort.signal.aborted) return;
        if (done) break;
        armWatchdog();
        try { decode(value); } catch (error) {
          // Only corrupt/missing frames invalidate the cursor. A normal network
          // failure must retain it so bounded replay can do its job.
          runtime = null;
          seq = null;
          throw error;
        }
      }
      if (!ready) throw new Error('Host replay ended before ready');
    } catch (error) {
      if (!abort.signal.aborted) {
        input.onError?.(error);
      }
    } finally {
      clearTimeout(watchdog);
      if (started && !ready) { runtime = null; seq = null; }
      // Release sockets also when a decoder/consumer throws, or retry was clicked.
      if (reader) await reader.cancel().catch(() => undefined);
      controller = null;
      if (!stopped && !unauthorized) {
        notify('disconnected');
        retryTimer = setTimeout(() => { retryTimer = undefined; void connect(); }, restartRequested ? 0 : 1_000);
      }
    }
  };
  void connect();
  return {
    authorizationRequired,
    reconnect() {
      if (stopped) return;
      unauthorized = false;
      cancelRetry();
      restartRequested = true;
      if (controller) controller.abort();
      else void connect();
    },
    stop() { stopped = true; cancelRetry(); controller?.abort(); },
  };
}
