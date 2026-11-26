import type { RealtimeProtocol } from '../../shared/realtimeVoice.js';

export function realtimeSocketUrl(base: URL, model: string, official?: RealtimeProtocol): string {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = official === 'qwen-audio-realtime'
    ? '/api-ws/v1/realtime'
    : (url.pathname.replace(/\/+$/, '') || '/v1') + '/realtime';
  if (official !== 'glm-realtime') url.searchParams.set('model', model);
  return url.href;
}

export function realtimeHeaders(key: string, overrides?: Record<string, string>, deleted: readonly string[] = []) {
  const headers: Record<string, string> = {};
  const excluded =
    /^(authorization|proxy-authorization|cookie|host|connection|content-type|content-length|upgrade|sec-websocket-.*|x-api-key|api-key|xi-api-key|openai-beta|chatgpt-account-id|openai-account-id|originator|session_id)$/i;
  for (const [name, value] of Object.entries(overrides ?? {}))
    if (!excluded.test(name)) headers[name.toLowerCase()] = value;
  for (const name of deleted) delete headers[name.toLowerCase()];
  headers.authorization = `Bearer ${key}`;
  return headers;
}

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

type SessionOptions = { model: string; voice: string } & (
  | { kind: 'call'; instructions: string }
  | { kind: 'preview' }
);

function sessionUpdate(protocol: RealtimeProtocol, options: SessionOptions) {
  const { model, voice } = options;
  const call = options.kind === 'call';
  const instructions = call ? { instructions: options.instructions } : {};
  const vad = { type: 'server_vad', silence_duration_ms: 500 };
  let session;
  switch (protocol) {
    case 'openai-realtime':
      session = {
        type: 'realtime', ...instructions, output_modalities: ['audio'],
        ...(call && { tools: [{ type: 'function', ...handoff }] }),
        audio: {
          input: call ? {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: { ...vad, create_response: true, interrupt_response: true },
          } : { turn_detection: null },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice },
        },
      };
      break;
    case 'qwen-audio-realtime':
      session = {
        ...instructions, modalities: ['text', 'audio'], voice, output_audio_format: 'pcm',
        ...(call && { input_audio_format: 'pcm', tools: [{ type: 'function', function: handoff }] }),
        turn_detection: call ? { ...vad, threshold: 0.5 } : null,
      };
      break;
    case 'glm-realtime':
      session = {
        ...instructions, model, modalities: ['audio', 'text'], voice,
        input_audio_format: 'pcm16', output_audio_format: 'pcm',
        beta_fields: { chat_mode: 'audio', auto_search: false, greeting_config: { enable: false } },
        turn_detection: call ? { type: 'server_vad', create_response: false, interrupt_response: true }
          : { type: 'client_vad' },
        ...(call && { tools: [{ type: 'function', ...handoff }] }),
      };
      break;
  }
  return { type: 'session.update', session };
}

type WireEvent = Record<string, any>;

export type RealtimeToolRequest = {
  requestKey: string;
  wireId?: string;
  responseId: string;
  name: unknown;
  arguments: unknown;
};

function toolRequest(event: WireEvent, requestKey: string): RealtimeToolRequest {
  return {
    requestKey,
    wireId: typeof event.call_id === 'string' ? event.call_id : undefined,
    responseId: event.response_id,
    name: event.name,
    arguments: event.arguments,
  };
}

// Every socket (including previews) owns its codec state. Only normalized event names
// reach the session and playback consumers. Shared conversation semantics live there.
export class RealtimeProtocolAdapter {
  private readonly resampler?: RealtimePcmResampler;

  constructor(readonly protocol: RealtimeProtocol) {
    if (protocol === 'openai-realtime') this.resampler = new RealtimePcmResampler();
  }

  get untaggedToolResults() { return this.protocol === 'glm-realtime'; }
  get requestsUserResponses() { return this.protocol === 'glm-realtime'; }

  checkCallAcknowledgement(event: WireEvent) {
    // A provider that enables automatic generation could attach its response to
    // a different explicit request. Never bind work under that configuration.
    if (this.requestsUserResponses && event.session?.turn_detection?.create_response === true)
      throw new Error('realtime_turn_detection_mismatch');
  }

  isIdleCancellation(code: unknown, requested: boolean) {
    return code === 'response_cancel_not_active' ||
      (this.protocol === 'glm-realtime' && requested && code === 'stop_task_error');
  }

  finishDiscardedItem(id: string) {
    if (this.protocol !== 'openai-realtime') return { type: 'conversation.item.delete', item_id: id };
  }

  interruptItem(id: string, output: { total: number; index: number; done: boolean }, playedMs: number) {
    if (this.protocol === 'openai-realtime' && output.total) return {
      type: 'conversation.item.truncate', item_id: id, content_index: output.index,
      audio_end_ms: Math.min(Math.floor(output.total / 48), Math.max(0, Math.floor(playedMs))),
    };
    if (output.done) return this.finishDiscardedItem(id);
  }

  start(options: SessionOptions) { return sessionUpdate(this.protocol, options); }

  encode(event: WireEvent) {
    return JSON.stringify(this.protocol === 'glm-realtime'
      ? { client_timestamp: Date.now(), ...event } : event);
  }

  decode(raw: string): WireEvent {
    const event = JSON.parse(raw);
    if (!event || typeof event.type !== 'string') throw new Error('invalid_event');
    switch (event.type) {
      case 'response.output_audio.delta': event.type = 'response.audio.delta'; break;
      case 'response.output_audio_transcript.delta': event.type = 'response.audio_transcript.delta'; break;
      case 'response.output_audio_transcript.done': event.type = 'response.audio_transcript.done'; break;
    }
    return event;
  }

  inputAudio(pcm: ArrayBuffer) {
    const bytes = this.resampler ? this.resampler.convert(pcm) : Buffer.from(pcm);
    return { bytes, durationMs: bytes.length / (this.resampler ? 48 : 32) };
  }

  // GLM acknowledges function outputs without a call_id. Wait for the complete
  // response and require one distinct output before any host work is dispatched.
  private pendingGlmTool?: { responseId: string; index: number; event: WireEvent };

  readTool(event: WireEvent): RealtimeToolRequest | undefined {
    if (!this.untaggedToolResults) return event.type === 'response.function_call_arguments.done'
      && typeof event.call_id === 'string' && typeof event.response_id === 'string'
      ? toolRequest(event, event.call_id) : undefined;
    if (event.type === 'response.function_call_arguments.done') {
      const index = event.output_index;
      if (typeof event.response_id !== 'string' || !Number.isSafeInteger(index) || index < 0)
        throw new Error('unbound_tool');
      const previous = this.pendingGlmTool;
      if (previous && (previous.responseId !== event.response_id || previous.index !== index ||
        previous.event.arguments !== event.arguments || previous.event.name !== event.name))
        throw new Error('ambiguous_tool');
      this.pendingGlmTool = { responseId: event.response_id, index, event };
    }
    if (event.type !== 'response.done' || !this.pendingGlmTool ||
      event.response?.id !== this.pendingGlmTool.responseId) return;
    const tool = this.pendingGlmTool;
    this.pendingGlmTool = undefined;
    if (event.response.status === 'completed')
      return toolRequest(tool.event, JSON.stringify([tool.responseId, tool.index]));
  }

  functionResult(wireId: string | undefined, accepted: boolean) {
    return { type: 'conversation.item.create', item: {
      type: 'function_call_output',
      ...(wireId !== undefined && { call_id: wireId }),
      output: JSON.stringify({ status: accepted ? 'accepted' : 'not_accepted' }),
    } };
  }
}
