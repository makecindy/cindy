import type { SpeechAdapter } from './types.js';

export const elevenlabsSpeechAdapter: SpeechAdapter = {
  contentTypes: ['audio/pcm', 'audio/x-pcm', 'application/octet-stream'],
  request(prefix, input) {
    return {
      url: new URL(
        `${prefix}/text-to-speech/${encodeURIComponent(input.voice)}/stream?output_format=pcm_24000`,
      ),
      body: JSON.stringify({
        model_id: input.modelId,
        text: input.text,
        ...(input.speed !== undefined ? { voice_settings: { speed: input.speed } } : {}),
      }),
    };
  },
  pcm: (body) => body,
};
