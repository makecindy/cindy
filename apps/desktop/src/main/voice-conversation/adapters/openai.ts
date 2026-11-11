import type { SpeechAdapter } from './types.js';
import { openRouterSpeechBaseUrl } from '../openrouter.js';

export const openaiSpeechAdapter: SpeechAdapter = {
  contentTypes: ['audio/pcm', 'audio/x-pcm', 'application/octet-stream'],
  request(prefix, input) {
    // OpenRouter's MiniMax adapter rejects PCM; direct MiniMax and compatible
    // gateways keep their existing contracts. Do not retry a paid PCM request.
    const mp3 = Boolean(openRouterSpeechBaseUrl(prefix)) && input.modelId.startsWith('minimax/speech-');
    return {
      url: new URL(`${prefix}/audio/speech`),
      ...(mp3 ? { format: 'mp3' as const } : {}),
      body: JSON.stringify({
        model: input.modelId,
        voice: input.voice,
        input: input.text,
        response_format: mp3 ? 'mp3' : 'pcm',
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      }),
    };
  },
  pcm: (body) => body,
};
