import {
  speechAdapter,
  speechRequest,
  speechTextSegments,
  type SpeechConnection,
} from './speechProtocols.js';
import { SpeechError } from './speechError.js';
import { MAX_ENCODED_SPEECH_BYTES, type SpeechAudioResult } from '../../shared/voiceConversation.js';
export type { SpeechConnection } from './speechProtocols.js';
export type SpeechDiagnostic = {
  stage: 'request' | 'headers' | 'first_pcm' | 'first_encoded' | 'complete' | 'cancelled' | 'error';
  requestId: string;
  protocol: SpeechConnection['protocol'];
  elapsedMs: number;
  bytes: number;
  httpStatus?: number;
  code?: SpeechError['code'] | 'headers_timeout' | 'read_timeout';
};
/** Provider speech transport: pull-driven PCM or a bounded, complete MP3 segment. */
export class SpeechSynthesisSession {
  private epoch = 0;
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private requestId: string | null = null;
  private totalBytes = 0;
  private reading = false;
  private diagnostic?: (
    stage: SpeechDiagnostic['stage'],
    details?: Pick<SpeechDiagnostic, 'httpStatus' | 'code'>,
  ) => void;

  constructor(
    private readonly deps: {
      connection(): SpeechConnection;
      assertCurrent(): void;
      fetch: typeof fetch;
      diagnostic?(event: SpeechDiagnostic): void;
    },
  ) {}

  async start(input: {
    requestId: string;
    modelId: string;
    voice: string;
    text: string;
    speed?: number;
  }): Promise<SpeechAudioResult> {
    this.cancel();
    const epoch = this.epoch;
    this.deps.assertCurrent();
    const connection = this.deps.connection();
    const texts = speechTextSegments(input.text, connection.protocol);
    const requests = texts.map((text) => speechRequest(connection, { ...input, text }));
    const encoded = requests[0].format === 'mp3';
    const adapter = speechAdapter(connection.protocol);
    const controller = new AbortController();
    this.controller = controller;
    this.requestId = input.requestId;
    const startedAt = Date.now();
    this.diagnostic = (stage, details = {}) =>
      this.deps.diagnostic?.({
        stage,
        requestId: input.requestId,
        protocol: connection.protocol,
        elapsedMs: Date.now() - startedAt,
        bytes: this.totalBytes,
        ...details,
      });
    this.diagnostic('request');
    const open = async (index: number): Promise<ReadableStream<Uint8Array>> => {
      this.deps.assertCurrent();
      if (epoch !== this.epoch || controller.signal.aborted) throw new SpeechError('cancelled');
      const { url, body, headers } = requests[index];
      let timedOut = false;
      const timer = setTimeout(() => {
        if (epoch !== this.epoch) return;
        timedOut = true;
        controller.abort();
      }, 30_000);
      let response: Response | undefined;
      try {
        response = await this.deps.fetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { ...connection.headers, 'Content-Type': 'application/json', ...headers },
          body,
        });
        this.deps.assertCurrent();
        if (epoch !== this.epoch || controller.signal.aborted) throw new SpeechError('cancelled');
        this.diagnostic?.('headers', { httpStatus: response.status });
        if (!response.ok || !response.body) throw new SpeechError('request');
        const contentType = response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        const contentTypes = encoded ? ['audio/mpeg'] : adapter.contentTypes;
        if (!contentType || !contentTypes.includes(contentType))
          throw new SpeechError('format');
        return encoded ? response.body : adapter.pcm(response.body);
      } catch (error) {
        if (response?.body && !response.body.locked)
          void response.body.cancel().catch(() => undefined);
        if (timedOut && epoch === this.epoch) {
          this.diagnostic?.('error', { code: 'headers_timeout' });
          // Let start/read own cancellation so a pending read receives the
          // timeout error before cancellation can resolve it as stream EOF.
          throw new SpeechError('timeout');
        }
        throw error instanceof SpeechError ? error : new SpeechError('request');
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const first = await open(0);
      // open() validates before returning; cancel/start can still happen at this
      // await boundary. Never install a stale reader over a replacement request.
      if (epoch !== this.epoch || controller.signal.aborted) {
        void first.cancel().catch(() => undefined);
        throw new SpeechError('cancelled');
      }
      this.reader = sequentialAudio(first, requests.length, open, () => {
        if (epoch === this.epoch) this.diagnostic?.('error', { code: 'read_timeout' });
      }, !encoded).getReader();
      if (encoded) {
        // Finish this sentence during the existing one-segment lookahead. MP3
        // decoding needs the complete segment, never an unbounded full reply.
        const reader = this.reader;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          this.deps.assertCurrent();
          if (epoch !== this.epoch || controller.signal.aborted) throw new SpeechError('cancelled');
          if (value?.byteLength) {
            this.totalBytes += value.byteLength;
            if (this.totalBytes > MAX_ENCODED_SPEECH_BYTES) throw new SpeechError('format');
            if (!chunks.length) this.diagnostic?.('first_encoded');
            chunks.push(value);
          }
          if (done) break;
        }
        const data = new Uint8Array(this.totalBytes);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        reader.releaseLock();
        this.reader = null;
        this.requestId = null;
        this.diagnostic?.('complete');
        this.diagnostic = undefined;
        return { format: 'mp3', data: data.buffer };
      }
      return { sampleRate: 24_000 };
    } catch (error) {
      if (epoch === this.epoch) {
        // Timeouts already identify their phase in diagnostics.
        if (!(error instanceof SpeechError && error.code === 'timeout'))
          this.diagnostic?.('error', {
            code: error instanceof SpeechError ? error.code : 'request',
          });
        this.cancel('failed');
      }
      throw error instanceof SpeechError ? error : new SpeechError('request');
    }
  }

  async read(requestId: string): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    try {
      this.deps.assertCurrent();
    } catch (error) {
      this.cancel();
      throw error;
    }
    if (requestId !== this.requestId || !this.reader || this.reading)
      throw new SpeechError('cancelled');
    const reader = this.reader;
    const epoch = this.epoch;
    this.reading = true;
    try {
      const result = await reader.read();
      this.deps.assertCurrent();
      if (epoch !== this.epoch) throw new SpeechError('cancelled');
      const value = result.value ?? new Uint8Array();
      const firstPcm = this.totalBytes === 0 && value.byteLength > 0;
      this.totalBytes += value.byteLength;
      if (value.byteLength > 1_048_576 || this.totalBytes > 24_000 * 2 * 600) {
        throw new SpeechError('format');
      }
      if (firstPcm) this.diagnostic?.('first_pcm');
      if (result.done) {
        if (this.totalBytes === 0 || this.totalBytes % 2 !== 0) throw new SpeechError('format');
        reader.releaseLock();
        this.reader = null;
        this.requestId = null;
        this.diagnostic?.('complete');
        this.diagnostic = undefined;
      }
      return { pcm: Uint8Array.from(value).buffer, done: result.done };
    } catch (error) {
      if (epoch === this.epoch) {
        if (!(error instanceof SpeechError && error.code === 'timeout'))
          this.diagnostic?.('error', {
            code: error instanceof SpeechError ? error.code : 'request',
          });
        this.cancel('failed');
      }
      throw error instanceof SpeechError ? error : new SpeechError('request');
    } finally {
      if (epoch === this.epoch) this.reading = false;
    }
  }

  cancel(reason: 'interrupted' | 'failed' = 'interrupted'): void {
    if (reason === 'interrupted') this.diagnostic?.('cancelled');
    this.diagnostic = undefined;
    ++this.epoch;
    this.controller?.abort();
    this.controller = null;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.requestId = null;
    this.reading = false;
    this.totalBytes = 0;
  }
}

/** Open the next segment only after the current audio is consumed. Cancelling a
 * preview/call aborts its fetch and prevents any remaining billable requests. */
function sequentialAudio(
  first: ReadableStream<Uint8Array>,
  count: number,
  open: (index: number) => Promise<ReadableStream<Uint8Array>>,
  onReadTimeout: () => void,
  pcm: boolean,
): ReadableStream<Uint8Array> {
  let reader = first.getReader();
  let index = 0;
  let bytes = 0;
  let cancelled = false;
  // Only body reads consume this deadline. Opening a later segment has its own
  // headers deadline, and its first body read starts a fresh 15-second budget.
  const read = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onReadTimeout();
            reject(new SpeechError('timeout'));
          }, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (!cancelled) {
            const result = await read();
            if (cancelled) return;
            if (!result.done) {
              bytes += result.value.byteLength;
              controller.enqueue(result.value);
              return;
            }
            if (bytes === 0 || (pcm && bytes % 2 !== 0)) throw new SpeechError('format');
            reader.releaseLock();
            if (++index === count) {
              controller.close();
              return;
            }
            const next = await open(index);
            if (cancelled) {
              await next.cancel();
              return;
            }
            reader = next.getReader();
            bytes = 0;
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
        return reader.cancel().catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
