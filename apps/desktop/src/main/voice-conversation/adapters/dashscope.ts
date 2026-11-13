import type { SpeechAdapter } from './types.js';
import { SpeechError } from '../speechError.js';
import { ssePcmStream } from './sse.js';

// Qwen3-TTS HTTP and Qwen-Audio/CosyVoice HTTP use distinct request contracts.
// Both return Base64 24 kHz mono PCM through SSE, not the final downloadable URL.
// https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api
// https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-http-api
// https://www.alibabacloud.com/help/en/model-studio/cosyvoice-tts-http-api
export const qwenSpeechAdapter: SpeechAdapter = {
  contentTypes: ['text/event-stream'],
  request(prefix, input) {
    return {
      url: new URL(`${prefix}/services/aigc/multimodal-generation/generation`),
      headers: { 'x-dashscope-sse': 'enable' },
      body: JSON.stringify({
        model: input.modelId,
        input: { text: input.text, voice: input.voice },
      }),
    };
  },
  pcm: dashscopePcmStream,
};
export const dashscopeSpeechAdapter: SpeechAdapter = {
  contentTypes: ['text/event-stream'],
  request(prefix, input) {
    return {
      url: new URL(`${prefix}/services/audio/tts/SpeechSynthesizer`),
      headers: { 'x-dashscope-sse': 'enable' },
      body: JSON.stringify({
        model: input.modelId,
        input: {
          text: input.text,
          voice: input.voice,
          format: 'pcm',
          sample_rate: 24000,
          ...(input.speed !== undefined ? { rate: input.speed } : {}),
        },
      }),
    };
  },
  pcm: dashscopePcmStream,
};

function dashscopePcmStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let finished = false;
  return ssePcmStream(
    body,
    (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SpeechError('format');
      const event = raw as {
        code?: unknown;
        status_code?: unknown;
        output?: {
          finish_reason?: unknown;
          audio?: { data?: unknown };
        };
      };
      if (
        (event.code !== undefined && event.code !== '') ||
        (event.status_code !== undefined && event.status_code !== 200)
      )
        throw new SpeechError('request');
      const output = event.output;
      if (!output || typeof output !== 'object' || finished) throw new SpeechError('format');
      // Live Qwen/CosyVoice SSE can encode the in-progress sentinel as "null".
      // Only "stop" completes the stream; sentence boundaries do not.
      if (
        output.finish_reason !== undefined &&
        output.finish_reason !== null &&
        output.finish_reason !== 'null' &&
        output.finish_reason !== 'stop'
      )
        throw new SpeechError('format');
      finished = output.finish_reason === 'stop';
      const data = output.audio?.data;
      // Sentence boundary events and the final URL do not contain PCM. Never fetch
      // that URL: it is the aggregate and must not be replayed or receive our key.
      if (data === undefined || data === '') return;
      if (
        typeof data !== 'string' ||
        data.length > 1_398_104 ||
        data.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/.test(data)
      )
        throw new SpeechError('format');
      const bytes = Buffer.from(data, 'base64');
      // Buffer accepts malformed padding/non-canonical encodings; reject them.
      if (bytes.toString('base64') !== data) throw new SpeechError('format');
      return Uint8Array.from(bytes);
    },
    () => finished,
  );
}
