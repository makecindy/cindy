/**
 * Wire contract for local offline speech recognition (sherpa-onnx).
 *
 * All audio decoding happens on this device inside an isolated worker thread
 * using user-supplied or downloaded sherpa-onnx ONNX weights — no cloud account
 * or API key is required.
 */

export const VOICE_LOCAL_ASR_CHANNELS = {
  getStatus: 'voice-input:local-asr:get-status',
  chooseModelDir: 'voice-input:local-asr:choose-model-dir',
  clearModelDir: 'voice-input:local-asr:clear-model-dir',
  /** main → renderer push whenever the local ASR status changes. */
  statusChanged: 'voice-input:local-asr:status-changed',
} as const;

export type VoiceLocalAsrModelKind = 'sensevoice' | 'paraformer' | 'whisper' | 'transducer';

export type VoiceLocalAsrStatusError =
  | 'unsupported_platform'
  | 'not_configured'
  | 'invalid_model_dir';

export type VoiceLocalAsrStatus = {
  /** False on platforms without a prebuilt sherpa-onnx-node addon. */
  supported: boolean;
  /** True when a valid sherpa-onnx model directory is ready for offline inference. */
  ready: boolean;
  /** Configured or auto-discovered local model directory path. */
  modelDir?: string;
  /** Basename of the detected model directory for concise display. */
  modelDirName?: string;
  /** Detected sherpa-onnx offline recognizer architecture. */
  modelKind?: VoiceLocalAsrModelKind;
  /** Last configuration/discovery problem when `ready` is false. */
  error?: VoiceLocalAsrStatusError;
};

export type VoiceLocalAsrChooseDirResult =
  | { ok: true; cancelled?: false; status: VoiceLocalAsrStatus }
  | { ok: true; cancelled: true; status: VoiceLocalAsrStatus }
  | { ok: false; error: 'unsupported_platform' | 'invalid_model_dir'; status: VoiceLocalAsrStatus };
