import { RealtimeProtocolAdapter, type RealtimeToolRequest } from './realtimeProtocol.js';
import { nativeVoiceCallInstructions } from '@cindy/maker-core';
import WebSocket from 'ws';
import type { AudioGate, AudioTrace } from '@cindy/voice-input-core';
import type {
  RealtimeVoiceSelection,
  RealtimePlaybackPosition,
} from '../../shared/realtimeVoice.js';
import type { VoiceConversationEvent } from '../../shared/voiceConversation.js';
import type { RealtimeConnection } from './realtimeModels.js';
import { connectRealtimeSocket } from './realtimeSocket.js';

type Event = VoiceConversationEvent['event'];
type Output = {
  response: string;
  sequence: number;
  index: number;
  chunks: Buffer[];
  bytes: number;
  total: number;
  done: boolean;
  discarded: boolean;
  text: string;
  wake?: () => void;
};
type Tool = {
  wireId?: string;
  responseId: string;
  inputId: string | null;
  supplement: string;
  handled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const MAX_BUFFER = 8 * 1024 * 1024;
export class RealtimeVoiceSession {
  private socket?: WebSocket;
  private stopped = false;
  private ready = false;
  private muted = false;
  private inputAudioMs = 0;
  private acceptAudioAfterMs = 0;
  private question = false;
  private speakingInput: string | null = null;
  // More than one unserved commit can share the next model response. The audio
  // can still play, but a task cannot be attributed to either user's utterance.
  private queuedReply?: { inputId: string | null };
  private requestedInput: string | null = null;
  private latestInput: string | null = null;
  private response: string | null = null;
  private responseSequence = 0;
  private readonly responseSequences = new Map<string, number>();
  private explicitResponse = false;
  private awaitingResponse = false;
  private pendingContinuation = false;
  private readonly responseInputs = new Map<string, string | null>();
  private readonly rejectedResponses = new Set<string>();
  private readonly inputs = new Map<
    string,
    { text?: string; committed?: boolean; suppressed: boolean; question: boolean }
  >();
  private readonly outputs = new Map<string, Output>();
  private readonly tools = new Map<string, Tool>();
  private readonly resultIds = new Set<string>();
  private readonly cancellationEvents = new Set<string>();
  private adapter!: RealtimeProtocolAdapter;
  private totalBuffered = 0;
  private gate?: AudioGate;
  private ping?: ReturnType<typeof setInterval>;
  private pong?: ReturnType<typeof setTimeout>;
  private dialReject?: (error: Error) => void;

  constructor(
    private readonly deps: {
      selection: RealtimeVoiceSelection;
      connection(): RealtimeConnection;
      assertCurrent(): void;
      reference: string;
      emit(event: Event): void;
      beginTurn(id: string): void;
      turn(id: string, role: 'user' | 'assistant', text: string, complete?: boolean): boolean;
      handoff(inputId: string, supplement: string): Promise<boolean>;
      interrupted(itemId: string): void;
      createAudioGate?(): AudioGate | undefined;
      connect?(connection: RealtimeConnection): Promise<WebSocket>;
    },
  ) {}

  async start(): Promise<void> {
    const binding = this.deps.connection();
    this.adapter = new RealtimeProtocolAdapter(binding.protocol);
    const identity = JSON.stringify(binding);
    const assertCurrent = this.deps.assertCurrent;
    this.deps.assertCurrent = () => {
      assertCurrent();
      if (JSON.stringify(this.deps.connection()) !== identity)
        throw new Error('connection_changed');
    };
    const socket = this.deps.connect
      ? await this.deps.connect(binding)
      : await connectRealtimeSocket(binding, this.deps.assertCurrent);
    // An owner change or End while resolving the proxy must dispose the late socket.
    this.socket = socket;
    if (this.stopped) {
      socket.on('error', () => undefined);
      socket.terminate();
      throw new Error('call_ended');
    }
    await new Promise<void>((resolve, reject) => {
      this.dialReject = reject;
      const timer = setTimeout(() => this.fail(), 15_000);
      const done = () => {
        clearTimeout(timer);
        this.dialReject = undefined;
        resolve();
      };
      const opened = () => {
        try {
          this.send(this.adapter.start({
            kind: 'call', model: this.deps.selection.modelId, voice: this.deps.selection.voice,
            instructions: nativeVoiceCallInstructions(this.deps.reference),
          }));
        } catch {
          this.fail();
        }
      };
      socket.on('open', opened);
      socket.on('error', () => this.fail());
      socket.on('close', () => {
        clearTimeout(timer);
        if (!this.stopped) this.fail();
      });
      socket.on('pong', () => {
        clearTimeout(this.pong);
        this.pong = undefined;
      });
      socket.on('message', (raw) => {
        if (this.stopped) return;
        try {
          this.deps.assertCurrent();
          const event = this.adapter.decode(raw.toString());
          if (event.type === 'session.updated' && !this.ready) {
            this.adapter.checkCallAcknowledgement(event);
            this.ready = true;
            this.startGate();
            done();
            this.ping = setInterval(() => {
              try {
                this.deps.assertCurrent();
                socket.ping();
                this.pong = setTimeout(() => this.fail(), 10_000);
              } catch {
                this.fail();
              }
            }, 25_000);
          } else this.receive(event);
        } catch {
          this.fail();
        }
      });
      if (socket.readyState === WebSocket.OPEN) opened();
    });
  }

  private send(event: Record<string, unknown>): void {
    this.deps.assertCurrent();
    if (
      this.stopped ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > MAX_BUFFER
    )
      throw new Error('realtime_unavailable');
    this.socket.send(this.adapter.encode(event));
  }
  private startGate(): void {
    this.gate = this.deps.createAudioGate?.();
    this.gate?.begin((pcm) => {
      if (!this.stopped && !this.muted) this.sendAudio(pcm);
    });
  }
  audio(pcm: ArrayBuffer, trace?: AudioTrace): void {
    if (this.stopped || !this.ready || this.muted) return;
    try {
      this.deps.assertCurrent();
      if (this.gate) this.gate.push(pcm, trace);
      else this.sendAudio(pcm);
    } catch {
      this.fail();
    }
  }
  private sendAudio(pcm: ArrayBuffer): void {
    try {
      const { bytes, durationMs } = this.adapter.inputAudio(pcm);
      if (bytes.length) {
        this.send({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') });
        this.inputAudioMs += durationMs;
      }
    } catch {
      this.fail();
    }
  }
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.gate?.abort();
    if (muted) {
      this.acceptAudioAfterMs = this.inputAudioMs;
      if (this.speakingInput) {
        const input = this.inputs.get(this.speakingInput);
        if (input) input.suppressed = true;
      }
      // Separate capture generations on the provider's audio clock. Even if no
      // speech_started has arrived yet, VAD can backdate the next onset into
      // its pre-roll. One second of silence also closes an unfinished turn.
      if (this.inputAudioMs > 0) this.sendAudio(new ArrayBuffer(32_000));
    } else this.startGate();
  }
  setQuestion(pending: boolean): void {
    this.question = pending;
    if (pending && this.speakingInput) {
      const input = this.inputs.get(this.speakingInput);
      if (input) input.suppressed = true;
    }
    if (pending) this.interrupt();
    else this.continueResponse();
  }

  private receive(e: Record<string, any>): void {
    const type = e.type;
    const id = typeof e.item_id === 'string' && e.item_id.length <= 256 ? e.item_id : '';
    if (type === 'error') {
      if (
        this.cancellationEvents.delete(e.error?.event_id) ||
        this.adapter.isIdleCancellation(e.error?.code, this.cancellationEvents.size > 0) ||
        (this.cancellationEvents.size &&
          e.error?.param === 'response.cancel' &&
          e.error?.type === 'invalid_request_error')
      ) {
        this.cancellationEvents.clear();
        return;
      }
      throw new Error('realtime_provider_error');
    }
    if (type === 'input_audio_buffer.speech_started' && id) {
      if (this.inputs.has(id)) return;
      if (this.inputs.size >= 2_000) throw new Error('call_limit');
      const stale =
        typeof e.audio_start_ms === 'number' && e.audio_start_ms < this.acceptAudioAfterMs;
      const suppressed = stale || this.question || this.muted;
      this.inputs.set(id, {
        suppressed,
        question: this.question && !stale,
      });
      if (!suppressed) this.deps.beginTurn(id);
      if (this.adapter.untaggedToolResults && this.latestInput !== id) this.latestInput = null;
      this.speakingInput = id;
      this.deps.emit({ type: 'realtime-interrupt', throughResponse: this.responseSequence });
      this.deps.emit({ type: 'realtime-input-start', itemId: id });
    } else if (type === 'input_audio_buffer.speech_stopped') {
      if (this.speakingInput === id) {
        this.speakingInput = null;
        if (this.queuedReply?.inputId === id) this.continueResponse();
      }
    } else if (type === 'input_audio_buffer.committed' && id) {
      if (!this.inputs.has(id)) {
        if (this.inputs.size >= 2_000) throw new Error('call_limit');
        const suppressed = this.question || this.muted;
        this.inputs.set(id, { suppressed, question: this.question });
        if (!suppressed) this.deps.beginTurn(id);
      }
      const input = this.inputs.get(id)!;
      if (input.committed) return;
      input.committed = true;
      this.latestInput = id;
      if (this.adapter.requestsUserResponses && !input.suppressed) {
        this.queuedReply = { inputId: this.queuedReply ? null : id };
        this.continueResponse();
      }
    } else if (type === 'conversation.item.input_audio_transcription.completed' && id) {
      const input = this.inputs.get(id);
      if (
        !input ||
        input.text !== undefined ||
        typeof e.transcript !== 'string' ||
        e.transcript.length > 32_000
      )
        return;
      input.text = e.transcript;
      if (input.suppressed) this.send({ type: 'conversation.item.delete', item_id: id });
      if (!input.suppressed && input.text!.trim()) this.deps.turn(id, 'user', input.text!);
      if (!this.muted && (!input.suppressed || input.question))
        this.deps.emit({
          type: 'realtime-utterance',
          itemId: id,
          text: input.text!,
          question: input.question,
        });
      for (const tool of this.tools.values()) if (tool.inputId === id) void this.executeTool(tool);
    } else if (type === 'conversation.item.input_audio_transcription.failed' && id) {
      const input = this.inputs.get(id);
      // Transcription is required for the call record and exact-original handoff.
      if (input && !input.suppressed) throw new Error('realtime_transcription_failed');
      if (input) {
        input.suppressed = true;
        input.text = '';
      }
      for (const tool of this.tools.values()) if (tool.inputId === id) void this.executeTool(tool);
    } else if (type === 'response.created' && typeof e.response?.id === 'string') {
      if (this.responseSequences.has(e.response.id)) return;
      if (this.responseSequences.size >= 2_000) throw new Error('call_limit');
      if (this.adapter.requestsUserResponses && this.response) throw new Error('overlapping_responses');
      const unexpected = this.adapter.requestsUserResponses && !this.awaitingResponse;
      this.response = e.response.id;
      this.responseSequences.set(this.response!, ++this.responseSequence);
      this.awaitingResponse = false;
      const input = this.adapter.requestsUserResponses ? this.requestedInput
        : this.explicitResponse ? null : this.latestInput;
      this.requestedInput = null;
      this.explicitResponse = false;
      this.responseInputs.set(this.response!, input);
      const mutedInput = unexpected && this.latestInput && this.inputs.get(this.latestInput)?.suppressed;
      if (this.question || mutedInput || (input && this.inputs.get(input)?.suppressed)) this.interrupt();
      else this.deps.emit({ type: 'realtime-thinking' });
    } else if (
      type === 'response.output_item.added' &&
      e.item?.type === 'message' &&
      typeof e.item.id === 'string'
    ) {
      this.output(e.item.id, e.response_id, 0);
    } else if (type === 'response.audio.delta') {
      if (!id || typeof e.delta !== 'string') return;
      const output = this.output(id, e.response_id, e.content_index ?? 0);
      if (output.discarded) return;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(e.delta)) throw new Error('invalid_audio');
      const pcm = Buffer.from(e.delta, 'base64');
      if (!pcm.length) return;
      if (pcm.length % 2 || pcm.length > MAX_BUFFER || this.totalBuffered + pcm.length > MAX_BUFFER)
        throw new Error('audio_limit');
      const first = output.total === 0;
      output.chunks.push(pcm);
      output.bytes += pcm.length;
      output.total += pcm.length;
      this.totalBuffered += pcm.length;
      output.wake?.();
      if (first) this.deps.emit({ type: 'realtime-audio', itemId: id });
    } else if (
      [
        'response.audio_transcript.delta',
        'response.audio_transcript.done',
      ].includes(type)
    ) {
      if (!id) return;
      const output = this.output(id, e.response_id, e.content_index ?? 0);
      if (output.discarded) return;
      const complete = type.endsWith('.done');
      output.text = complete ? (e.transcript ?? output.text) : output.text + (e.delta ?? '');
      if (typeof output.text !== 'string' || output.text.length > 32_000)
        throw new Error('text_limit');
      this.deps.turn(id, 'assistant', output.text, complete);
    } else if (type === 'response.function_call_arguments.done') {
      if (!this.adapter.untaggedToolResults || (this.response && e.response_id === this.response)) {
        const tool = this.adapter.readTool(e);
        if (tool) this.receiveTool(tool);
      }
    } else if (type === 'response.done') {
      const responseId = e.response?.id;
      if (responseId === this.response) {
        const tool = this.adapter.readTool(e);
        if (tool && !this.rejectedResponses.has(responseId)) this.receiveTool(tool);
      }
      for (const [itemId, output] of this.outputs)
        if (output.response === responseId) {
          output.done = true;
          output.wake?.();
          if (output.discarded) {
            const event = this.adapter.finishDiscardedItem(itemId);
            if (event) this.send(event);
          }
        }
      if (this.response === responseId) this.response = null;
      if (e.response?.status === 'failed') throw new Error('realtime_response_failed');
      this.continueResponse();
    }
  }

  private receiveTool(request: RealtimeToolRequest): void {
    const key = request.requestKey;
    if (this.tools.has(key)) return;
    if (this.tools.size >= 2_000) throw new Error('call_limit');
    const tool: Tool = {
      wireId: request.wireId,
      responseId: request.responseId,
      inputId: this.rejectedResponses.has(request.responseId) ? null : this.responseInputs.get(request.responseId) ?? null,
      supplement: '',
    };
    this.tools.set(key, tool);
    try {
      if (typeof request.arguments !== 'string') throw new Error('invalid_tool');
      const args = JSON.parse(request.arguments);
      if (request.name !== 'handoff_task' || typeof args.supplement !== 'string' || args.supplement.length > 8_000)
        throw new Error('invalid_tool');
      tool.supplement = args.supplement;
    } catch {
      tool.inputId = null;
    }
    void this.executeTool(tool);
  }

  private output(id: string, response: string, index: number): Output {
    let output = this.outputs.get(id);
    if (!output) {
      if (this.outputs.size >= 2_000) throw new Error('call_limit');
      output = {
        response,
        sequence: this.responseSequences.get(response) ?? this.responseSequence,
        index,
        chunks: [],
        bytes: 0,
        total: 0,
        text: '',
        done: false,
        discarded: this.question || this.rejectedResponses.has(response),
      };
      this.outputs.set(id, output);
      if (!output.discarded) this.deps.beginTurn(id);
    }
    return output;
  }
  async read(itemId: string): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    this.deps.assertCurrent();
    const output = this.outputs.get(itemId);
    if (!output) throw new Error('unknown_audio');
    while (!this.stopped && !output.discarded && !output.chunks.length && !output.done)
      await new Promise<void>((resolve) => {
        output.wake = resolve;
      });
    output.wake = undefined;
    this.deps.assertCurrent();
    if (this.stopped || output.discarded) return { pcm: new ArrayBuffer(0), done: true };
    const chunk = output.chunks.shift() ?? Buffer.alloc(0);
    output.bytes -= chunk.length;
    this.totalBuffered -= chunk.length;
    return { pcm: Uint8Array.from(chunk).buffer, done: output.done && !output.chunks.length };
  }

  interrupt(position?: RealtimePlaybackPosition, throughResponse = this.responseSequence): void {
    if (this.stopped) return;
    if (this.response && (this.responseSequences.get(this.response) ?? 0) <= throughResponse) {
      this.rejectedResponses.add(this.response);
      const event_id = `cancel_${crypto.randomUUID()}`;
      this.cancellationEvents.add(event_id);
      this.send({ type: 'response.cancel', event_id });
    }
    for (const [id, output] of this.outputs) {
      if (output.sequence > throughResponse) continue;
      if (output.discarded || (output.done && !output.bytes && id !== position?.itemId)) continue;
      output.discarded = true;
      this.totalBuffered -= output.bytes;
      output.bytes = 0;
      output.chunks = [];
      output.wake?.();
      this.deps.interrupted(id);
      const event = this.adapter.interruptItem(id, output, id === position?.itemId ? position.playedMs : 0);
      if (event) this.send(event);
    }
  }

  private async executeTool(tool: Tool): Promise<void> {
    if (this.stopped || tool.handled) return;
    if (!this.canAnswerTool(tool)) {
      clearTimeout(tool.timer);
      tool.handled = true;
      return;
    }
    const input = tool.inputId ? this.inputs.get(tool.inputId) : undefined;
    if (input && input.text === undefined) {
      tool.timer ??= setTimeout(() => {
        tool.inputId = null;
        void this.executeTool(tool);
      }, 15_000);
      return;
    }
    clearTimeout(tool.timer);
    const id = tool.inputId;
    tool.handled = true;
    try {
      this.deps.assertCurrent();
      const accepted =
        !this.rejectedResponses.has(tool.responseId) &&
        !!id &&
        !!input?.text?.trim() &&
        !input.suppressed &&
        !this.question &&
        (await this.deps.handoff(id, tool.supplement));
      if (!this.stopped && this.canAnswerTool(tool)) this.functionResult(tool.wireId, accepted);
    } catch {
      if (!this.stopped) this.fail();
    }
  }
  private canAnswerTool(tool: Tool): boolean {
    if (!this.adapter.untaggedToolResults) return true;
    const origin = this.responseInputs.get(tool.responseId);
    return (!origin || origin === this.latestInput) && !this.speakingInput &&
      !this.rejectedResponses.has(tool.responseId) &&
      this.responseSequences.get(tool.responseId) === this.responseSequence && !this.awaitingResponse;
  }

  private functionResult(callId: string | undefined, accepted: boolean): void {
    this.send(this.adapter.functionResult(callId, accepted));
    this.pendingContinuation = true;
    this.continueResponse();
  }
  deliverResult(taskId: string, text: string): void {
    if (this.stopped || this.resultIds.has(taskId)) return;
    this.resultIds.add(taskId);
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({ taskResult: { taskId, text: text.slice(0, 32_000) } }),
          },
        ],
      },
    });
    this.pendingContinuation = true;
    this.continueResponse();
  }
  private continueResponse(): void {
    if (
      (!this.pendingContinuation && !this.queuedReply) ||
      this.response ||
      this.awaitingResponse ||
      this.speakingInput ||
      this.question ||
      this.stopped
    )
      return;
    this.requestedInput = this.queuedReply?.inputId ?? null;
    this.pendingContinuation = false;
    this.queuedReply = undefined;
    this.explicitResponse = true;
    this.awaitingResponse = true;
    this.send({ type: 'response.create' });
  }
  private fail(): void {
    if (this.stopped) return;
    this.stop();
    this.deps.emit({ type: 'error', text: '' });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.dialReject?.(new Error('realtime_unavailable'));
    this.dialReject = undefined;
    clearInterval(this.ping);
    clearTimeout(this.pong);
    this.gate?.abort();
    for (const tool of this.tools.values()) clearTimeout(tool.timer);
    for (const output of this.outputs.values()) {
      output.chunks = [];
      output.wake?.();
    }
    this.totalBuffered = 0;
    this.socket?.terminate();
  }
}
