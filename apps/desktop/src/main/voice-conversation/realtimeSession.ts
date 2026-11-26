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
  callId: string;
  inputId: string | null;
  supplement: string;
  handled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const MAX_BUFFER = 8 * 1024 * 1024;
const handoff = {
  name: 'handoff_task',
  description:
    'Ask the existing companion task to perform work requiring tools or continue in the background. The host attaches the actual user utterance; do not supply or rewrite it.',
  parameters: {
    type: 'object',
    properties: {
      supplement: {
        type: 'string',
        description: 'Optional context for the task, never a replacement for the user request.',
      },
    },
    required: ['supplement'],
    additionalProperties: false,
  },
};

/** Protocol differences stay at this boundary; ownership, task dispatch and playback are shared. */
export function realtimeSessionUpdate(selection: RealtimeVoiceSelection, reference: string) {
  const instructions = nativeVoiceCallInstructions(reference);
  return {
    type: 'session.update',
    session:
      selection.protocol === 'openai-realtime'
        ? {
            type: 'realtime',
            instructions,
            output_modalities: ['audio'],
            tools: [{ type: 'function', ...handoff }],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: 'gpt-4o-mini-transcribe' },
                turn_detection: {
                  type: 'server_vad',
                  silence_duration_ms: 500,
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: { format: { type: 'audio/pcm', rate: 24000 }, voice: selection.voice },
            },
          }
        : {
            instructions,
            modalities: ['text', 'audio'],
            voice: selection.voice,
            input_audio_format: 'pcm',
            output_audio_format: 'pcm',
            turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
            tools: [{ type: 'function', function: handoff }],
          },
  };
}

/** Stateful 16 → 24 kHz linear conversion. Fractional positions carry across capture frames. */
export class RealtimePcmResampler {
  private samples: number[] = [];
  private position = 0;
  convert(pcm: ArrayBuffer): Buffer {
    const view = new DataView(pcm);
    for (let i = 0; i < view.byteLength; i += 2) this.samples.push(view.getInt16(i, true));
    const output: number[] = [];
    while (this.position + 1 < this.samples.length) {
      const i = Math.floor(this.position),
        fraction = this.position - i;
      output.push(Math.round(this.samples[i] * (1 - fraction) + this.samples[i + 1] * fraction));
      this.position += 2 / 3;
    }
    const consumed = Math.floor(this.position);
    this.samples.splice(0, consumed);
    this.position -= consumed;
    const bytes = Buffer.alloc(output.length * 2);
    output.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2));
    return bytes;
  }
}

export class RealtimeVoiceSession {
  private socket?: WebSocket;
  private stopped = false;
  private ready = false;
  private muted = false;
  private inputAudioMs = 0;
  private acceptAudioAfterMs = 0;
  private question = false;
  private speakingInput: string | null = null;
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
    { text?: string; suppressed: boolean; question: boolean }
  >();
  private readonly outputs = new Map<string, Output>();
  private readonly tools = new Map<string, Tool>();
  private readonly resultIds = new Set<string>();
  private readonly cancellationEvents = new Set<string>();
  private readonly resampler = new RealtimePcmResampler();
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
    this.deps.selection = { ...this.deps.selection, protocol: binding.protocol };
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
          this.send(realtimeSessionUpdate(this.deps.selection, this.deps.reference));
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
          const event = JSON.parse(raw.toString()) as Record<string, any>;
          if (event.type === 'session.updated' && !this.ready) {
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
    this.socket.send(JSON.stringify(event));
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
      const bytes =
        this.deps.selection.protocol === 'openai-realtime'
          ? this.resampler.convert(pcm)
          : Buffer.from(pcm);
      if (bytes.length) {
        this.send({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') });
        this.inputAudioMs +=
          bytes.length / (this.deps.selection.protocol === 'openai-realtime' ? 48 : 32);
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
        e.error?.code === 'response_cancel_not_active' ||
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
      if (this.inputs.size >= 2_000) throw new Error('call_limit');
      const stale =
        typeof e.audio_start_ms === 'number' && e.audio_start_ms < this.acceptAudioAfterMs;
      const suppressed = stale || this.question || this.muted;
      this.inputs.set(id, {
        suppressed,
        question: this.question && !stale,
      });
      if (!suppressed) this.deps.beginTurn(id);
      this.speakingInput = id;
      this.deps.emit({ type: 'realtime-interrupt', throughResponse: this.responseSequence });
      this.deps.emit({ type: 'realtime-input-start', itemId: id });
    } else if (type === 'input_audio_buffer.speech_stopped') {
      if (this.speakingInput === id) this.speakingInput = null;
    } else if (type === 'input_audio_buffer.committed' && id) {
      if (!this.inputs.has(id)) {
        if (this.inputs.size >= 2_000) throw new Error('call_limit');
        const suppressed = this.question || this.muted;
        this.inputs.set(id, { suppressed, question: this.question });
        if (!suppressed) this.deps.beginTurn(id);
      }
      this.latestInput = id;
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
      if (this.responseSequences.size >= 2_000) throw new Error('call_limit');
      this.response = e.response.id;
      this.responseSequences.set(this.response!, ++this.responseSequence);
      this.awaitingResponse = false;
      const input = this.explicitResponse ? null : this.latestInput;
      this.explicitResponse = false;
      this.responseInputs.set(this.response!, input);
      if (this.question || (input && this.inputs.get(input)?.suppressed)) this.interrupt();
      else this.deps.emit({ type: 'realtime-thinking' });
    } else if (
      type === 'response.output_item.added' &&
      e.item?.type === 'message' &&
      typeof e.item.id === 'string'
    ) {
      this.output(e.item.id, e.response_id, 0);
    } else if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
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
        'response.output_audio_transcript.delta',
        'response.audio_transcript.done',
        'response.output_audio_transcript.done',
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
      if (typeof e.call_id !== 'string' || this.tools.has(e.call_id)) return;
      if (this.tools.size >= 2_000) throw new Error('call_limit');
      const responseId = e.response_id;
      const inputId = this.responseInputs.get(responseId) ?? null;
      let supplement = '';
      try {
        const args = JSON.parse(e.arguments);
        if (
          e.name !== 'handoff_task' ||
          typeof args.supplement !== 'string' ||
          args.supplement.length > 8_000
        )
          throw new Error();
        supplement = args.supplement;
      } catch {
        this.tools.set(e.call_id, {
          callId: e.call_id,
          inputId: null,
          supplement: '',
          handled: true,
        });
        this.functionResult(e.call_id, false);
        return;
      }
      const tool: Tool = {
        callId: e.call_id,
        inputId: this.rejectedResponses.has(responseId) ? null : inputId,
        supplement,
      };
      this.tools.set(tool.callId, tool);
      void this.executeTool(tool);
    } else if (type === 'response.done') {
      const responseId = e.response?.id;
      for (const [itemId, output] of this.outputs)
        if (output.response === responseId) {
          output.done = true;
          output.wake?.();
          if (output.discarded && this.deps.selection.protocol === 'qwen-audio-realtime')
            this.send({ type: 'conversation.item.delete', item_id: itemId });
        }
      if (this.response === responseId) this.response = null;
      if (e.response?.status === 'failed') throw new Error('realtime_response_failed');
      this.continueResponse();
    }
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
      if (this.deps.selection.protocol === 'openai-realtime' && output.total) {
        this.send({
          type: 'conversation.item.truncate',
          item_id: id,
          content_index: output.index,
          audio_end_ms: Math.min(
            Math.floor(output.total / 48),
            id === position?.itemId ? Math.max(0, Math.floor(position.playedMs)) : 0,
          ),
        });
      } else if (this.deps.selection.protocol === 'qwen-audio-realtime' && output.done)
        this.send({ type: 'conversation.item.delete', item_id: id });
    }
  }

  private async executeTool(tool: Tool): Promise<void> {
    if (this.stopped || tool.handled) return;
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
        !!id &&
        !!input?.text?.trim() &&
        !input.suppressed &&
        !this.question &&
        (await this.deps.handoff(id, tool.supplement));
      if (!this.stopped) this.functionResult(tool.callId, accepted);
    } catch {
      if (!this.stopped) this.fail();
    }
  }
  private functionResult(callId: string, accepted: boolean): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ status: accepted ? 'accepted' : 'not_accepted' }),
      },
    });
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
      !this.pendingContinuation ||
      this.response ||
      this.awaitingResponse ||
      this.speakingInput ||
      this.question ||
      this.stopped
    )
      return;
    this.pendingContinuation = false;
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
