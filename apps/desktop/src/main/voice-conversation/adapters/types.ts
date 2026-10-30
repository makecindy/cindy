import type { SpeechProtocol, SpeechSpeedRange } from '../../../shared/speechProtocols.js';

export type SpeechConnection = {
  baseUrl: string;
  headers: Record<string, string>;
  protocol: SpeechProtocol;
  speedRange?: SpeechSpeedRange;
};
export type SpeechInput = { modelId: string; voice: string; text: string; speed?: number };
export type SpeechRequest = {
  url: URL;
  body: string;
  headers?: Record<string, string>;
  /** Explicit route exception; absent keeps the adapter's streaming PCM contract. */
  format?: 'mp3';
};

/** Adapters default to pull-driven 24 kHz, 16-bit LE mono PCM; a request may
 * explicitly select bounded MP3. EOF means synthesis completed, and cancellation
 * must cancel the provider reader for either format. */
export type SpeechAdapter = {
  contentTypes: readonly string[];
  request(prefix: string, input: SpeechInput): SpeechRequest;
  pcm(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
};
