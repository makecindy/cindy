/**
 * Wire contract for the voice-input speaker filter ("recognize my voice").
 *
 * The voiceprint never leaves this device: it is computed in main, stored
 * encrypted per account, and the renderer only ever sees whether one exists.
 */

import { SPEAKER_ENROLLMENT_MAX_CLIP_SEC } from '@cindy/voice-input-core';

export const VOICE_SPEAKER_FILTER_CHANNELS = {
  getStatus: 'voice-input:speaker:get-status',
  downloadModels: 'voice-input:speaker:download-models',
  cancelDownload: 'voice-input:speaker:cancel-download',
  enroll: 'voice-input:speaker:enroll',
  deleteProfile: 'voice-input:speaker:delete-profile',
  /** main → renderer push whenever the status below changes. */
  statusChanged: 'voice-input:speaker:status-changed',
} as const;

export type VoiceSpeakerModelState = 'missing' | 'downloading' | 'ready' | 'failed';

export type VoiceSpeakerFilterStatus = {
  /** False where the inference library is not shipped (e.g. Linux arm64). */
  supported: boolean;
  modelState: VoiceSpeakerModelState;
  downloadedBytes: number;
  totalBytes: number;
  /** Short failure kind for the last download, not a raw error message. */
  downloadError?: 'network' | 'disk' | 'checksum' | 'unavailable';
  enrolled: boolean;
  enrolledAt?: number;
};

/** Read-aloud clips collected during enrollment. */
export const VOICE_SPEAKER_ENROLLMENT_CLIP_COUNT = 3;
/** Each clip is PCM16 mono 16 kHz; anything longer is rejected by main. */
export const VOICE_SPEAKER_ENROLLMENT_MAX_CLIP_SEC = SPEAKER_ENROLLMENT_MAX_CLIP_SEC;
/** Recording UI stops each clip automatically after this long. */
export const VOICE_SPEAKER_ENROLLMENT_TARGET_CLIP_SEC = SPEAKER_ENROLLMENT_MAX_CLIP_SEC;

export type VoiceSpeakerEnrollRequest = {
  /** PCM16 little-endian mono 16 kHz clips. */
  clips: ArrayBuffer[];
};

export type VoiceSpeakerEnrollResult =
  | { ok: true; status: VoiceSpeakerFilterStatus }
  | {
      ok: false;
      reason: 'too_short' | 'no_embedding' | 'inconsistent' | 'models_missing' | 'storage_unavailable' | 'failed';
      /** Zero-based clip the user should re-record, when one is to blame. */
      clipIndex?: number;
    };
