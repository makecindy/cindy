import {
  sliceRetainedAudioForReplay,
  type RetainedFailedVoiceAudio,
} from '@cindy/voice-input-core';

/**
 * Replays locally retained PCM16k audio through the standard main-process
 * voice-input audio stream (`appendAudio` + `drainAudioQueue`) without opening
 * the microphone.
 */
export async function streamRetainedAudioToMain(
  audio: RetainedFailedVoiceAudio,
  shouldContinue: () => boolean,
): Promise<boolean> {
  const chunks = sliceRetainedAudioForReplay(audio);
  const baseAt = Date.now();
  for (const item of chunks) {
    if (!shouldContinue()) return false;
    window.electronAPI.voiceInput.appendAudio({
      pcm16k: item.pcm,
      trace: {
        capturedAt: baseAt,
        convertedAt: baseAt,
        chunkIndex: item.chunkIndex,
        sampleRate: audio.sampleRate,
        durationMs: item.durationMs,
      },
    });
  }
  if (!shouldContinue()) return false;
  await window.electronAPI.voiceInput.drainAudioQueue?.();
  return shouldContinue();
}
