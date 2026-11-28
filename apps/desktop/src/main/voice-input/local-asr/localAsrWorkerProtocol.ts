import type { VoiceLocalAsrModelKind } from '../../../shared/voiceLocalAsr.js';

export type LocalAsrModelSpec =
  | {
      kind: 'sensevoice';
      modelDir: string;
      tokens: string;
      model: string;
    }
  | {
      kind: 'paraformer';
      modelDir: string;
      tokens: string;
      model: string;
    }
  | {
      kind: 'whisper';
      modelDir: string;
      tokens: string;
      encoder: string;
      decoder: string;
    }
  | {
      kind: 'transducer';
      modelDir: string;
      tokens: string;
      encoder: string;
      decoder: string;
      joiner: string;
    };

export type LocalAsrWorkerRequest =
  | { id: number; op: 'init'; spec: LocalAsrModelSpec; language?: string }
  | { id: number; op: 'transcribe'; samples: Float32Array; sampleRate: number }
  | { id: number; op: 'dispose' };

export type LocalAsrWorkerResponse =
  | { id: number; ok: true; text?: string }
  | { id: number; ok: false; error: string };

export function localAsrModelSpecKey(spec: LocalAsrModelSpec, language = ''): string {
  switch (spec.kind) {
    case 'sensevoice':
    case 'paraformer':
      return `${spec.kind}|${spec.model}|${spec.tokens}|${language}`;
    case 'whisper':
      return `${spec.kind}|${spec.encoder}|${spec.decoder}|${spec.tokens}|${language}`;
    case 'transducer':
      return `${spec.kind}|${spec.encoder}|${spec.decoder}|${spec.joiner}|${spec.tokens}|${language}`;
  }
}

export type LocalAsrModelKindValue = VoiceLocalAsrModelKind;
