/** Messages between Electron main and the speaker-gate worker thread. */
export type SpeakerWorkerRequest =
  | { id: number; op: 'init'; vadModel: string; embeddingModel: string }
  | { id: number; op: 'vad-reset'; session: string }
  | { id: number; op: 'vad'; session: string; samples: Float32Array }
  | { id: number; op: 'embed'; samples: Float32Array }
  | { id: number; op: 'speech'; samples: Float32Array };

export type SpeakerWorkerResponse =
  | {
      id: number;
      ok: true;
      flags?: Uint8Array;
      embedding?: Float32Array | null;
      samples?: Float32Array;
    }
  | { id: number; ok: false; error: string };
