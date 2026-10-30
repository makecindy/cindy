import { cosineSimilarity, SPEAKER_GATE_SAMPLE_RATE } from './SpeakerGate';

/** Inference needed to enroll a voiceprint. */
export interface SpeakerEnrollmentEngine {
  /** Speech-only samples of a clip (VAD segments joined, silence removed). */
  extractSpeech(samples: Float32Array): Promise<Float32Array>;
  embed(samples: Float32Array): Promise<Float32Array | null>;
}

export type SpeakerEnrollmentFailure = 'too_short' | 'no_embedding' | 'inconsistent';

export type SpeakerEnrollmentResult =
  | {
      ok: true;
      embedding: Float32Array;
      /** Lowest similarity between one clip and the mean of the other clips. */
      selfScore: number;
      speechSec: number;
    }
  | {
      ok: false;
      reason: SpeakerEnrollmentFailure;
      /** Index of the clip that failed, when one clip is to blame. */
      clipIndex?: number;
      speechSec?: number;
      selfScore?: number;
    };

export const SPEAKER_ENROLLMENT_CLIP_COUNT = 3;
/** Recording may finish earlier when the user has read the passage. */
export const SPEAKER_ENROLLMENT_MAX_CLIP_SEC = 30;
export const SPEAKER_ENROLLMENT_MIN_CLIP_SPEECH_SEC = 2;
// Own-voice windows scored 0.77–0.88 in validation; clips of one person that
// disagree this much usually mean a second voice or heavy noise in a clip.
export const SPEAKER_ENROLLMENT_MIN_SELF_SCORE = 0.6;

/**
 * Builds a voiceprint from a few read-aloud clips: the mean of each clip's
 * normalized embedding, normalized again — the same recipe the validation
 * used. Each clip must carry enough speech and agree with the other clips,
 * without its own embedding inflating the consistency score.
 */
export async function buildSpeakerEnrollment(
  engine: SpeakerEnrollmentEngine,
  clips: Float32Array[],
): Promise<SpeakerEnrollmentResult> {
  const embeddings: Float32Array[] = [];
  let speechSamples = 0;
  for (let index = 0; index < clips.length; index += 1) {
    const speech = await engine.extractSpeech(clips[index]);
    const clipSec = speech.length / SPEAKER_GATE_SAMPLE_RATE;
    speechSamples += speech.length;
    if (clipSec < SPEAKER_ENROLLMENT_MIN_CLIP_SPEECH_SEC) {
      return { ok: false, reason: 'too_short', clipIndex: index, speechSec: clipSec };
    }
    const embedding = await engine.embed(speech);
    if (
      !embedding?.length ||
      !embedding.every(Number.isFinite) ||
      !embedding.some((value) => value !== 0) ||
      (embeddings.length > 0 && embedding.length !== embeddings[0].length)
    ) {
      return { ok: false, reason: 'no_embedding', clipIndex: index };
    }
    embeddings.push(normalize(embedding));
  }
  const speechSec = speechSamples / SPEAKER_GATE_SAMPLE_RATE;
  if (embeddings.length === 0) return { ok: false, reason: 'too_short', speechSec };

  const mean = new Float32Array(embeddings[0].length);
  for (const embedding of embeddings) {
    for (let i = 0; i < mean.length; i += 1) mean[i] += embedding[i];
  }
  const voiceprint = normalize(mean);

  let selfScore = 1;
  let worstClip = 0;
  embeddings.forEach((embedding, index) => {
    const otherClips = Float32Array.from(mean, (value, dimension) => value - embedding[dimension]);
    const score = cosineSimilarity(embedding, otherClips);
    if (score < selfScore) {
      selfScore = score;
      worstClip = index;
    }
  });
  if (selfScore < SPEAKER_ENROLLMENT_MIN_SELF_SCORE) {
    return { ok: false, reason: 'inconsistent', clipIndex: worstClip, selfScore, speechSec };
  }
  return { ok: true, embedding: voiceprint, selfScore, speechSec };
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}
