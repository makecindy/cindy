/** Local recording only; these channels are never exposed through device-link. */
export interface RecordingAudioOptions { system: boolean; microphone: boolean }
export const RECORDING_AUDIO = {
  REGISTER: 'recording-audio:register',
  DATA: 'recording-audio:data',
  STATE: 'recording-audio:state',
} as const;
export type RecordingAudioError = 'systemAudioFailed' | 'microphoneFailed' | 'audioFailed';
export interface RecordingAudioApi {
  register(): Promise<RecordingAudioOptions>;
  data(bytes: Uint8Array): void;
  state(error?: RecordingAudioError): void;
}
export function isRecordingAudioOptions(value: unknown): value is RecordingAudioOptions {
  if (!value || typeof value !== 'object') return false;
  const options = value as Record<string, unknown>;
  return typeof options.system === 'boolean' && typeof options.microphone === 'boolean';
}
