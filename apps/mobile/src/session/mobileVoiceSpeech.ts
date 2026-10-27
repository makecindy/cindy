import { requireOptionalNativeModule, UnavailabilityError } from 'expo-modules-core';
import { AppState, Platform } from 'react-native';

export type MobileVoiceSpeechResult = 'done' | 'cancelled';

type NativeVoiceSpeech = {
  speak(options: { requestId: string; text: string; language?: string }): Promise<MobileVoiceSpeechResult>;
  stopSpeech(requestId: string): Promise<void>;
};

type SpeechRun = {
  id: string;
  module: NativeVoiceSpeech;
  cancelled: boolean;
  stopping?: Promise<void>;
};

let sequence = 0;
let activeRun: SpeechRun | undefined;

function speechModule(): NativeVoiceSpeech | null {
  if (Platform.OS !== 'ios') return null;
  const candidate = requireOptionalNativeModule<Partial<NativeVoiceSpeech>>('XdtMobileRealtimeAudio');
  // Old native installations may contain the capture module without speech.
  return typeof candidate?.speak === 'function' && typeof candidate.stopSpeech === 'function'
    ? candidate as NativeVoiceSpeech
    : null;
}

export function isMobileVoiceSpeechAvailable(): boolean {
  return speechModule() !== null;
}

function cancelRun(run: SpeechRun): Promise<void> {
  run.cancelled = true;
  run.stopping ??= run.module.stopSpeech(run.id);
  return run.stopping;
}

/** Stops only the current reply; an old AbortSignal cannot stop its replacement. */
export async function stopMobileVoiceSpeech(): Promise<void> {
  const run = activeRun;
  if (run) await cancelRun(run);
}

/**
 * Call only after the dictation controller has stopped capture. Native speech
 * returns after playback, so the caller can safely start the next listening turn.
 * Long replies are split below the native bridge's utterance limit without truncation.
 */
export async function speakMobileVoiceReply(
  text: string,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<MobileVoiceSpeechResult> {
  if (options.signal?.aborted || AppState.currentState !== 'active') return 'cancelled';
  const content = text.trim();
  if (!content) return 'done';
  const module = speechModule();
  if (!module) throw new UnavailabilityError('Cindy mobile voice', 'spoken replies');
  const previous = activeRun;
  const run: SpeechRun = { id: `voice-reply-${++sequence}`, module, cancelled: false };
  activeRun = run;
  // Native commands carry ownership IDs; delayed cancellation never releases
  // the audio session of another reply, even when native completion is late.
  const cancel = () => { void cancelRun(run).catch(() => undefined); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const subscription = AppState.addEventListener('change', state => {
    if (state !== 'active') cancel();
  });
  try {
    if (previous) await cancelRun(previous);
    for (let offset = 0; offset < content.length;) {
      if (run.cancelled || activeRun !== run) return 'cancelled';
      let end = Math.min(offset + 3000, content.length);
      // UTF-16 boundaries must not split emoji or other supplementary characters.
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end -= 1;
      const result = await module.speak({
        requestId: run.id,
        text: content.slice(offset, end),
        ...(options.language ? { language: options.language } : {}),
      });
      if (result === 'cancelled' || run.cancelled || activeRun !== run) return 'cancelled';
      offset = end;
    }
    return 'done';
  } catch (error) {
    if (run.cancelled || activeRun !== run) return 'cancelled';
    throw error;
  } finally {
    subscription.remove();
    options.signal?.removeEventListener('abort', cancel);
    if (activeRun === run) activeRun = undefined;
  }
}
