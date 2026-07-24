import {
  MODERATION_JSON_SIGN_PATH,
  MODERATION_STREAM_CREATE_LOGICAL_PATH,
  parseModerationSignedJsonResponse,
  type ModerationJsonSignRequest,
  type ModerationStreamCreateBody,
} from '@cindy/content-moderation-protocol';
import { createLogger } from '../logger.js';

const log = createLogger('content-moderation-stream');
const INITIAL_RELEASE_TIMEOUT_MS = 5_000;
const FINALIZATION_TIMEOUT_MS = 5_000;
const RECOVERY_DELAY_MS = 1_000;
const MAX_RECOVERY_ATTEMPTS = 2;

interface StreamFrame {
  sequence: number;
  text: string;
  is_final: boolean;
  queuedAt: number;
}

interface StreamTaskTokens {
  gatewayBaseUrl: string;
  taskId: string;
  writeToken: string;
  readToken: string;
}

export interface StreamModerationCallbacks {
  onRelease(frame: { sequence: number; text: string }): void;
  onBlock(): void;
  onFailed(): void;
  onCompleted(): void;
  onFailOpen(): void;
}

export interface CreateStreamModerationInput {
  signBaseUrl: string;
  accessToken: string;
  membershipId: string;
  sessionId: string;
  turnId: string;
  agentKind?: string;
  modelId?: string;
  signal?: AbortSignal;
}

type LocalTerminal = 'block' | 'failed' | 'completed' | 'fail-open' | 'cancelled';
type ProgressState = 'CREATED' | 'OPEN' | 'BLOCKED' | 'FAILED' | 'COMPLETED';

function joinedUrl(baseUrl: string, logicalPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${logicalPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskPath(taskId: string, suffix: string): string {
  return `/api/v1/review/stream/tasks/${encodeURIComponent(taskId)}/${suffix}`;
}

function serializeFrame(frame: StreamFrame): string {
  return JSON.stringify({
    sequence: frame.sequence,
    text: frame.text,
    is_final: frame.is_final,
  });
}

export class StreamModerationClient {
  private readonly lifecycle = new AbortController();
  private readonly frames = new Map<number, StreamFrame>();
  private readonly released = new Map<number, string>();
  private readonly pendingReleases = new Map<number, string>();
  private readonly encoder = new TextEncoder();
  private nextSequence = 0;
  private nextReleaseSequence = 0;
  private terminal: LocalTerminal | null = null;
  private finished = false;
  private finalSequence: number | null = null;
  private completionObserved = false;
  private lastEventId: string | null = null;
  private initialReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizationTimer: ReturnType<typeof setTimeout> | null = null;
  private inputWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private inputResponse: Promise<void> | null = null;
  private eventsActive = false;
  private recovery: Promise<void> | null = null;
  private recoveryNeedsInput = false;
  private recoveryNeedsEvents = false;
  private sendChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly task: StreamTaskTokens,
    private readonly callbacks: StreamModerationCallbacks,
    private readonly fetchImpl: typeof fetch,
  ) {}

  static async create(
    input: CreateStreamModerationInput,
    callbacks: StreamModerationCallbacks,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<StreamModerationClient | null> {
    const requestBody: ModerationStreamCreateBody = {
      business_code: 'stream-output',
      data_id: `output:${input.membershipId}:${input.sessionId}:${input.turnId}`,
      items: [],
      user_info: { user_id: input.membershipId },
      extra: {
        scene: 'assistant',
        ...(input.agentKind ? { agentKind: input.agentKind } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
      },
    };
    const body = JSON.stringify(requestBody);
    const signRequest: ModerationJsonSignRequest = {
      logical_path: MODERATION_STREAM_CREATE_LOGICAL_PATH,
      body,
    };
    try {
      const signResponse = await fetchImpl(
        joinedUrl(input.signBaseUrl, MODERATION_JSON_SIGN_PATH),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(signRequest),
          signal: input.signal,
        },
      );
      const signedBody = await jsonResponse(signResponse);
      const parsedSigned = parseModerationSignedJsonResponse(
        signedBody,
        MODERATION_STREAM_CREATE_LOGICAL_PATH,
      );
      if (signResponse.status !== 200 || !parsedSigned.ok) {
        return null;
      }
      const signed = parsedSigned.value;
      const createResponse = await fetchImpl(
        joinedUrl(signed.gateway_base_url, MODERATION_STREAM_CREATE_LOGICAL_PATH),
        {
          method: 'POST',
          headers: { ...signed.headers },
          body,
          signal: input.signal,
        },
      );
      const createBody = await jsonResponse(createResponse);
      const data = createBody && isRecord(createBody.data) ? createBody.data : null;
      if (
        createResponse.status !== 201
        || createBody?.code !== 200
        || !nonEmptyString(data?.task_id)
        || !nonEmptyString(data.write_token)
        || !nonEmptyString(data.read_token)
      ) {
        return null;
      }
      const client = new StreamModerationClient(
        {
          gatewayBaseUrl: signed.gateway_base_url,
          taskId: data.task_id,
          writeToken: data.write_token,
          readToken: data.read_token,
        },
        callbacks,
        fetchImpl,
      );
      if (input.signal?.aborted) {
        client.cancel();
        return null;
      }
      const abortClient = () => client.cancel();
      input.signal?.addEventListener('abort', abortClient, { once: true });
      try {
        await client.openEvents();
        if (input.signal?.aborted) {
          client.cancel();
          return null;
        }
        return client;
      } catch {
        client.cancel();
        return null;
      } finally {
        input.signal?.removeEventListener('abort', abortClient);
      }
    } catch {
      return null;
    }
  }

  push(text: string): number {
    if (this.terminal || this.finished) return -1;
    const frame: StreamFrame = {
      sequence: this.nextSequence,
      text,
      is_final: false,
      queuedAt: Date.now(),
    };
    this.nextSequence += 1;
    this.frames.set(frame.sequence, frame);
    this.armInitialReleaseTimeout();
    this.enqueueFrame(frame);
    return frame.sequence;
  }

  finish(): void {
    if (this.terminal || this.finished) return;
    this.finished = true;
    const frame: StreamFrame = {
      sequence: this.nextSequence,
      text: '',
      is_final: true,
      queuedAt: Date.now(),
    };
    this.finalSequence = frame.sequence;
    this.nextSequence += 1;
    this.frames.set(frame.sequence, frame);
    this.armFinalizationTimeout();
    this.enqueueFrame(frame);
  }

  cancel(): void {
    if (this.terminal) return;
    this.terminal = 'cancelled';
    this.clearInitialReleaseTimeout();
    this.clearFinalizationTimeout();
    this.lifecycle.abort();
    void this.inputWriter?.abort().catch(() => undefined);
  }

  private armInitialReleaseTimeout(): void {
    if (this.initialReleaseTimer || this.terminal) return;
    const oldest = [...this.frames.values()]
      .filter((frame) => !frame.is_final && !this.released.has(frame.sequence))
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (!oldest) return;
    const remaining = Math.max(0, INITIAL_RELEASE_TIMEOUT_MS - (Date.now() - oldest.queuedAt));
    this.initialReleaseTimer = setTimeout(
      () => this.failOpen('pending-release-timeout'),
      remaining,
    );
  }

  private clearInitialReleaseTimeout(): void {
    if (!this.initialReleaseTimer) return;
    clearTimeout(this.initialReleaseTimer);
    this.initialReleaseTimer = null;
  }

  private armFinalizationTimeout(): void {
    if (this.finalizationTimer || this.terminal) return;
    this.finalizationTimer = setTimeout(
      () => this.failOpen('finalization-timeout'),
      FINALIZATION_TIMEOUT_MS,
    );
  }

  private clearFinalizationTimeout(): void {
    if (!this.finalizationTimer) return;
    clearTimeout(this.finalizationTimer);
    this.finalizationTimer = null;
  }

  private enqueueFrame(frame: StreamFrame): void {
    this.sendChain = this.sendChain
      .then(async () => {
        if (this.terminal) return;
        const writer = await this.ensureInputWriter();
        await writer.write(this.encoder.encode(`${serializeFrame(frame)}\n`));
        if (frame.is_final) {
          await writer.close();
          this.inputWriter = null;
          await this.inputResponse;
        }
      })
      .catch(() => this.recover('input'));
  }

  private async ensureInputWriter(): Promise<WritableStreamDefaultWriter<Uint8Array>> {
    if (this.inputWriter) return this.inputWriter;
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    this.inputWriter = writer;
    const init = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.task.writeToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: stream.readable,
      signal: this.lifecycle.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' };
    this.inputResponse = this.fetchImpl(
      joinedUrl(this.task.gatewayBaseUrl, taskPath(this.task.taskId, 'input')),
      init,
    ).then(async (response) => {
      const body = await jsonResponse(response);
      const data = body && isRecord(body.data) ? body.data : null;
      if (
        response.status !== 200
        || body?.code !== 200
        || data?.accepted !== true
        || data.next_sequence !== this.nextSequence
      ) {
        throw new Error('stream input rejected');
      }
    });
    void this.inputResponse.catch(() => {
      if (!this.terminal) void this.recover('input');
    });
    return writer;
  }

  private async openEvents(): Promise<void> {
    if (this.terminal || this.eventsActive) return;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.task.readToken}`,
      Accept: 'text/event-stream',
    };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    const response = await this.fetchImpl(
      joinedUrl(this.task.gatewayBaseUrl, taskPath(this.task.taskId, 'events')),
      { method: 'GET', headers, signal: this.lifecycle.signal },
    );
    if (response.status !== 200 || !response.body) throw new Error('stream events unavailable');
    this.eventsActive = true;
    void this.consumeEvents(response.body)
      .catch(() => undefined)
      .finally(() => {
        this.eventsActive = false;
        if (!this.terminal) void this.recover('events');
      });
  }

  private async consumeEvents(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!this.terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.handleSseBlock(block);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  private handleSseBlock(block: string): void {
    let id: string | null = null;
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator >= 0 ? line.slice(0, separator) : line;
      const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
      if (field === 'id') id = value;
      if (field === 'event') event = value;
      if (field === 'data') dataLines.push(value);
    }
    if (!event) return;
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as unknown;
      data = isRecord(parsed) ? parsed : null;
    } catch {
      return;
    }
    if (!data) return;
    if (event === 'content.release') {
      const sequence = data.sequence;
      const text = data.text;
      if (!Number.isInteger(sequence) || (sequence as number) < 0 || typeof text !== 'string') return;
      const frame = this.frames.get(sequence as number);
      if (!frame || (sequence as number) >= this.nextSequence) {
        this.failOpen('invalid-release-sequence');
        return;
      }
      // The gateway releases the terminal empty frame as well as text frames.
      // It advances ordering but must never become user-visible output.
      if (frame.is_final && text !== '') {
        this.failOpen('invalid-final-release');
        return;
      }
      const releasedText = this.released.get(sequence as number);
      const pendingText = this.pendingReleases.get(sequence as number);
      if (
        (releasedText !== undefined && releasedText !== text)
        || (pendingText !== undefined && pendingText !== text)
      ) {
        this.failOpen('conflicting-release');
        return;
      }
      if (releasedText === undefined) this.pendingReleases.set(sequence as number, text);
      this.drainOrderedReleases();
    } else if (event === 'content.block') {
      this.block();
    } else if (event === 'task.completed') {
      this.complete();
    } else if (event === 'task.failed') {
      this.fail();
    } else {
      return;
    }
    if (id !== null) this.lastEventId = id;
  }

  private drainOrderedReleases(): void {
    while (this.pendingReleases.has(this.nextReleaseSequence)) {
      const sequence = this.nextReleaseSequence;
      const text = this.pendingReleases.get(sequence);
      this.pendingReleases.delete(sequence);
      this.nextReleaseSequence += 1;
      if (text === undefined || this.released.has(sequence)) continue;
      this.released.set(sequence, text);
      const frame = this.frames.get(sequence);
      if (frame && !frame.is_final) this.callbacks.onRelease({ sequence, text });
    }
    this.clearInitialReleaseTimeout();
    this.armInitialReleaseTimeout();
    this.completeIfReady();
  }

  private async recover(reason: 'input' | 'events'): Promise<void> {
    if (this.terminal) return;
    if (reason === 'input') this.recoveryNeedsInput = true;
    if (reason === 'events') this.recoveryNeedsEvents = true;
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await sleep(RECOVERY_DELAY_MS);
        try {
          const progress = await this.getProgress();
          if (progress.streamState === 'BLOCKED') {
            this.block();
            return;
          }
          if (progress.streamState === 'FAILED') {
            this.fail();
            return;
          }
          if (progress.streamState === 'COMPLETED') {
            this.completionObserved = true;
            if (this.completeIfReady()) return;
          }
          if (this.recoveryNeedsInput) {
            this.recoveryNeedsInput = false;
            this.inputWriter = null;
            this.inputResponse = null;
            await this.replayMissingFrames(progress.nextSequence);
          }
          this.recoveryNeedsEvents = false;
          if (!this.eventsActive) await this.openEvents();
          if (this.recoveryNeedsInput || this.recoveryNeedsEvents || !this.eventsActive) {
            throw new Error('stream recovery incomplete');
          }
          return;
        } catch {
          // retry
        }
      }
      this.failOpen(`${reason}-recovery-exhausted`);
    })().finally(() => {
      this.recovery = null;
      if (!this.terminal && (this.recoveryNeedsInput || this.recoveryNeedsEvents || !this.eventsActive)) {
        void this.recover(this.recoveryNeedsInput ? 'input' : 'events');
      }
    });
    return this.recovery;
  }

  private async getProgress(): Promise<{ nextSequence: number; streamState: ProgressState }> {
    const response = await this.fetchImpl(
      joinedUrl(this.task.gatewayBaseUrl, taskPath(this.task.taskId, 'progress')),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.task.writeToken}` },
        signal: this.lifecycle.signal,
      },
    );
    const body = await jsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    const nextSequence = data?.next_sequence;
    const streamState = data?.stream_state;
    if (
      response.status !== 200
      || body?.code !== 200
      || !Number.isInteger(nextSequence)
      || (nextSequence as number) < 0
      || !['CREATED', 'OPEN', 'BLOCKED', 'FAILED', 'COMPLETED'].includes(String(streamState))
    ) {
      throw new Error('invalid stream progress');
    }
    return {
      nextSequence: nextSequence as number,
      streamState: streamState as ProgressState,
    };
  }

  private async replayMissingFrames(nextSequence: number): Promise<void> {
    const missing = [...this.frames.values()]
      .filter((frame) => frame.sequence >= nextSequence)
      .sort((left, right) => left.sequence - right.sequence);
    for (const frame of missing) {
      const response = await this.fetchImpl(
        joinedUrl(this.task.gatewayBaseUrl, taskPath(this.task.taskId, 'chunks')),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.task.writeToken}`,
            'Content-Type': 'application/json',
          },
          body: serializeFrame(frame),
          signal: this.lifecycle.signal,
        },
      );
      const body = await jsonResponse(response);
      const data = body && isRecord(body.data) ? body.data : null;
      if (
        response.status !== 200
        || body?.code !== 200
        || data?.accepted !== true
        || data.next_sequence !== frame.sequence + 1
      ) {
        throw new Error('stream chunk rejected');
      }
    }
  }

  private releaseRemainingRaw(): void {
    for (const frame of [...this.frames.values()].sort((left, right) => left.sequence - right.sequence)) {
      if (frame.is_final || this.released.has(frame.sequence)) continue;
      this.released.set(frame.sequence, frame.text);
      this.callbacks.onRelease({ sequence: frame.sequence, text: frame.text });
    }
    this.nextReleaseSequence = this.finalSequence ?? this.nextSequence;
    this.pendingReleases.clear();
  }

  private block(): void {
    if (this.terminal) return;
    this.terminal = 'block';
    this.clearInitialReleaseTimeout();
    this.clearFinalizationTimeout();
    this.lifecycle.abort();
    this.callbacks.onBlock();
  }

  private fail(): void {
    if (this.terminal) return;
    this.terminal = 'failed';
    this.clearInitialReleaseTimeout();
    this.clearFinalizationTimeout();
    this.lifecycle.abort();
    this.callbacks.onFailed();
  }

  private complete(): void {
    if (this.terminal) return;
    this.completionObserved = true;
    this.completeIfReady();
  }

  private completeIfReady(): boolean {
    if (
      this.terminal
      || !this.completionObserved
      || this.finalSequence === null
    ) {
      return false;
    }
    this.terminal = 'completed';
    this.clearInitialReleaseTimeout();
    this.clearFinalizationTimeout();
    // COMPLETED is the gateway's approval for the entire stream item, so any
    // frames that did not receive individual release events are safe to emit.
    this.releaseRemainingRaw();
    this.lifecycle.abort();
    this.callbacks.onCompleted();
    return true;
  }

  private failOpen(reason: string): void {
    if (this.terminal) return;
    this.terminal = 'fail-open';
    this.clearInitialReleaseTimeout();
    this.clearFinalizationTimeout();
    // Product contract: bounded infrastructure failures must not make model
    // output disappear. Explicit BLOCKED and FAILED terminal states never take
    // this path and continue to fail closed.
    this.releaseRemainingRaw();
    this.lifecycle.abort();
    log.warn('stream moderation failed open', { reason });
    this.callbacks.onFailOpen();
  }
}
