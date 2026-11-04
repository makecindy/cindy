import {
  isSpeechSpeedSupported,
  speechTextLimit,
  type SpeechProtocol,
} from '../../shared/speechProtocols.js';
import { SpeechError } from './speechError.js';
import { openaiSpeechAdapter } from './adapters/openai.js';
import { elevenlabsSpeechAdapter } from './adapters/elevenlabs.js';
import { minimaxSpeechAdapter } from './adapters/minimax.js';
import { qwenSpeechAdapter, dashscopeSpeechAdapter } from './adapters/dashscope.js';
import type {
  SpeechAdapter,
  SpeechConnection,
  SpeechInput,
  SpeechRequest,
} from './adapters/types.js';
export type { SpeechConnection, SpeechInput } from './adapters/types.js';

const adapters: Record<SpeechProtocol, SpeechAdapter> = {
  openai: openaiSpeechAdapter,
  elevenlabs: elevenlabsSpeechAdapter,
  minimax: minimaxSpeechAdapter,
  'qwen-tts': qwenSpeechAdapter,
  'dashscope-tts': dashscopeSpeechAdapter,
};
export function speechAdapter(protocol: SpeechProtocol): SpeechAdapter {
  const adapter = adapters[protocol];
  if (!adapter) throw new SpeechError('unavailable');
  return adapter;
}

export function speechRequest(connection: SpeechConnection, input: SpeechInput): SpeechRequest {
  const base = new URL(connection.baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new SpeechError('unavailable');
  if (!isSpeechSpeedSupported(input.modelId, connection.protocol, input.speed, connection.speedRange))
    throw new SpeechError('unavailable');
  return speechAdapter(connection.protocol).request(connection.baseUrl.replace(/\/+$/, ''), input);
}

/** Preserve every character, prefer a sentence/word boundary, and never cut a
 * surrogate pair. Segments are sent sequentially as playback pulls more PCM. */
export function speechTextSegments(text: string, protocol: SpeechProtocol): string[] {
  const limit = speechTextLimit(protocol);
  if (!limit || text.length <= limit) return [text];
  const segments: string[] = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    for (let i = end - 1; i >= limit / 2; i--) {
      if (/[。！？.!?\s]/u.test(text[i])) {
        end = i + 1;
        break;
      }
    }
    segments.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) segments.push(text);
  return segments;
}
