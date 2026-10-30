import { ssePcmStream } from './sse.js';
import type { SpeechAdapter } from './types.js';
import { SpeechError } from '../speechError.js';

export const minimaxSpeechAdapter: SpeechAdapter = {
  contentTypes: ['text/event-stream', 'application/json'],
  request(prefix, input) {
    return {
      url: new URL(`${prefix}/t2a_v2`),
      body: JSON.stringify({
        model: input.modelId,
        text: input.text,
        stream: true,
        stream_options: { exclude_aggregated_audio: true },
        output_format: 'hex',
        voice_setting: {
          voice_id: input.voice,
          ...(input.speed !== undefined ? { speed: input.speed } : {}),
        },
        audio_setting: { format: 'pcm', sample_rate: 24000, channel: 1 },
      }),
    };
  },
  pcm: miniMaxPcmStream,
};

/** MiniMax terminal audio is an aggregate, never another chunk.
 * https://platform.minimax.io/docs/api-reference/speech-t2a-http */
function miniMaxPcmStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let finished = false;
  return ssePcmStream(
    body,
    (raw) => {
      if (!raw || typeof raw !== 'object') throw new SpeechError('format');
      const event = raw as {
        base_resp?: { status_code?: number };
        extra_info?: {
          audio_sample_rate?: number;
          audio_channel?: number;
          audio_format?: string;
        };
        data?: { status: number; audio?: string };
      };
      if (event.base_resp?.status_code !== undefined && event.base_resp.status_code !== 0)
        throw new SpeechError('request');
      const info = event.extra_info;
      if (
        info &&
        ((info.audio_sample_rate !== undefined && info.audio_sample_rate !== 24000) ||
          (info.audio_channel !== undefined && info.audio_channel !== 1) ||
          (info.audio_format !== undefined && info.audio_format !== 'pcm'))
      )
        throw new SpeechError('format');
      const part = event.data;
      if (!part) return;
      if (finished || ![1, 2].includes(part.status)) throw new SpeechError('format');
      if (part.status === 2) {
        finished = true;
        return;
      }
      const hex = part.audio;
      if (hex === undefined || hex === '') return;
      if (
        typeof hex !== 'string' ||
        hex.length > 2_097_152 ||
        hex.length % 2 !== 0 ||
        /[^\da-f]/i.test(hex)
      )
        throw new SpeechError('format');
      return Uint8Array.from(Buffer.from(hex, 'hex'));
    },
    () => finished,
  );
}
