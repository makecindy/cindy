import type { SpeechProtocol } from '../../shared/voiceConversation.js';
import { SpeechError } from './speechError.js';

export type SpeechConnection = {
  baseUrl: string;
  headers: Record<string, string>;
  protocol: SpeechProtocol;
};
export type SpeechInput = { modelId: string; voice: string; text: string };

/**
 * Follow-up before adding more native protocols: extract these branches and response
 * decoders into protocol adapters, with shared UI/Main parameter validation and a
 * common audio/completion/cancellation contract. Keep wire serialization in code.
 * See docs/product-rules/companion-voice-mode.md, "后续扩展计划".
 */
export function speechRequest(
  connection: SpeechConnection,
  input: SpeechInput,
): { url: URL; body: string } {
  const base = new URL(connection.baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new SpeechError('unavailable');
  const prefix = connection.baseUrl.replace(/\/+$/, '');
  switch (connection.protocol) {
    case 'openai':
      return {
        url: new URL(`${prefix}/audio/speech`),
        body: JSON.stringify({
          model: input.modelId,
          voice: input.voice,
          input: input.text,
          response_format: 'pcm',
        }),
      };
    case 'elevenlabs':
      return {
        url: new URL(
          `${prefix}/text-to-speech/${encodeURIComponent(input.voice)}/stream?output_format=pcm_24000`,
        ),
        body: JSON.stringify({ model_id: input.modelId, text: input.text }),
      };
    case 'minimax':
      return {
        url: new URL(`${prefix}/t2a_v2`),
        body: JSON.stringify({
          model: input.modelId,
          text: input.text,
          stream: true,
          stream_options: { exclude_aggregated_audio: true },
          output_format: 'hex',
          voice_setting: { voice_id: input.voice },
          audio_setting: { format: 'pcm', sample_rate: 24000, channel: 1 },
        }),
      };
  }
}

/** MiniMax SSE is JSON + hex. Terminal audio is an aggregate, never another chunk.
 * https://platform.minimax.io/docs/api-reference/speech-t2a-http
 * Read only on demand; bound both encoded frames and decoded PCM before returning bytes.
 */
export function miniMaxPcmStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let finished = false;
  let eof = false;
  let encodedBytes = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (true) {
            const delimiter = /\r?\n\r?\n/.exec(buffer);
            if (delimiter || (eof && buffer)) {
              const frame = delimiter ? buffer.slice(0, delimiter.index) : buffer;
              buffer = delimiter ? buffer.slice(delimiter.index + delimiter[0].length) : '';
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (!data) continue; // SSE comments/keep-alives.
              if (data === '[DONE]') {
                if (!finished) throw new SpeechError('format');
                continue;
              }
              const event = JSON.parse(data);
              if (!event || typeof event !== 'object') throw new SpeechError('format');
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
              if (!part) continue;
              if (finished || ![1, 2].includes(part.status)) throw new SpeechError('format');
              if (part.status === 2) {
                finished = true;
                // The provider may still return the full aggregate despite exclude_aggregated_audio.
                // Do not replay it after chunks already delivered to the speaker.
                continue;
              }
              const hex = part.audio;
              if (hex === undefined || hex === '') continue;
              if (
                typeof hex !== 'string' ||
                hex.length > 2_097_152 ||
                hex.length % 2 !== 0 ||
                /[^\da-f]/i.test(hex)
              )
                throw new SpeechError('format');
              controller.enqueue(Uint8Array.from(Buffer.from(hex, 'hex')));
              return;
            }
            if (eof) {
              if (!finished) throw new SpeechError('format');
              reader.releaseLock();
              controller.close();
              return;
            }
            const chunk = await reader.read();
            eof = chunk.done;
            encodedBytes += chunk.value?.byteLength ?? 0;
            if ((chunk.value?.byteLength ?? 0) > 2_097_152 || encodedBytes > 64 * 1024 * 1024)
              throw new SpeechError('format');
            buffer += decoder.decode(chunk.value, { stream: !eof });
            if (buffer.length > 2_097_152) throw new SpeechError('format');
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          controller.error(error instanceof SpeechError ? error : new SpeechError('format'));
        }
      },
      cancel: () => reader.cancel(),
    },
    { highWaterMark: 0 },
  );
}
