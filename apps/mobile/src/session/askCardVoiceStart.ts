/**
 * Opens the same managed dictation session the composer uses, aimed at the
 * question card's answer text instead of the chat draft.
 */
import { AppState } from 'react-native';

import { i18n } from '@/i18n';
import type { AskCardAuth } from '@/session/askCardAuth';
import {
  CINDY_MANAGED_REFINER_PROVIDER,
  createMobileCindyVoiceCredential,
  MobileCindyVoiceRunContext,
} from '@/session/mobileCindyVoiceSession';
import { createMobileVoiceControllerSession } from '@/session/mobileVoiceController';
import { playMobileVoiceInputEndCue } from '@/session/mobileVoiceCue';
import {
  mobileVoiceMicPermissionError,
  mobileVoiceRealtimeAudioUnavailableError,
  type MobileVoiceSelection,
} from '@/session/mobileVoiceInput';
import { isMobileRealtimeAudioAvailable } from '@/session/mobileRealtimeAudio';
import { createMobileSpeakerGate } from '@/session/mobileSpeakerFilter';
import { resolveMobileVoiceRecordingPermission } from '@/session/mobileVoiceStartup';

type AppStateListener = (state: string) => void;

/** Startup aborted because the user stopped or the card went away. */
export class AskCardVoiceCancelledError extends Error {
  constructor() {
    super(i18n.t('composer.voice.cancelled'));
    this.name = 'AskCardVoiceCancelledError';
  }
}

export function isAskCardVoiceCancelled(error: unknown): boolean {
  return error instanceof AskCardVoiceCancelledError;
}

export async function startAskCardDictation(input: {
  deviceId: string;
  signal?: AbortSignal;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken: () => Promise<string | null>;
  apiFetch: AskCardAuth['apiFetch'];
  isAppActive?: () => boolean;
  subscribeToAppState?: (listener: AppStateListener) => () => void;
  getText: () => string;
  setText: (value: string) => void;
  getSelection: () => MobileVoiceSelection;
  onListening: () => void;
  onRunCreated?: (run: { stop: () => Promise<void>; cancel: () => Promise<void> }) => void;
  onError: (message: string) => void;
}): Promise<{ stop: () => Promise<void>; cancel: () => Promise<void> }> {
  if (!isMobileRealtimeAudioAvailable()) {
    throw new Error(mobileVoiceRealtimeAudioUnavailableError());
  }
  const { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } = await import('expo-audio');
  const isAppActive = input.isAppActive ?? (() => AppState.currentState === 'active');
  const subscribeToAppState = input.subscribeToAppState ?? ((listener: AppStateListener) => {
    const subscription = AppState.addEventListener('change', (state) => listener(state));
    return () => subscription.remove();
  });
  const abort = new AbortController();
  const forwardAbort = () => abort.abort();
  if (input.signal?.aborted) throw new AskCardVoiceCancelledError();
  input.signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const permission = await resolveMobileVoiceRecordingPermission({
      getPermission: getRecordingPermissionsAsync,
      requestPermission: requestRecordingPermissionsAsync,
      isRequestCurrent: () => !abort.signal.aborted,
      isAppActive,
      subscribeToAppState,
      signal: abort.signal,
      waitForAppActive: () => waitUntilActive(isAppActive, subscribeToAppState, abort.signal),
    });
    if (abort.signal.aborted) throw new AskCardVoiceCancelledError();
    if (permission === 'denied') throw new Error(mobileVoiceMicPermissionError());
    if (permission !== 'granted') throw new AskCardVoiceCancelledError();
  } finally {
    input.signal?.removeEventListener('abort', forwardAbort);
  }

  const credential = createMobileCindyVoiceCredential(input.deviceId);
  const voiceContext = new MobileCindyVoiceRunContext(
    input.getAccessToken,
    input.refreshAccessToken,
    input.apiFetch as ConstructorParameters<typeof MobileCindyVoiceRunContext>[2],
    credential.settings?.language,
    CINDY_MANAGED_REFINER_PROVIDER,
  );
  let audioGate: Awaited<ReturnType<typeof createMobileSpeakerGate>> | undefined;
  try {
    audioGate = await createMobileSpeakerGate();
  } catch {
    audioGate = undefined;
  }
  const initialDraft = input.getText();
  const session = createMobileVoiceControllerSession({
    credential,
    ...(audioGate ? { audioGate } : {}),
    connectionProvider: (providerId) => voiceContext.createAsrConnection(providerId),
    refinerTargetProvider: (providerId, options) => voiceContext.createRefinerTarget(providerId, options),
    warmRefiner: (request) => voiceContext.warmRefiner(request),
    initialDraft,
    initialSelection: input.getSelection(),
    readCurrentDraft: input.getText,
    onDraftChanged: (text) => input.setText(text),
    onStateChanged: (state) => {
      if (state === 'listening') input.onListening();
    },
    onError: input.onError,
    onReadyForEndCue: credential.settings?.playInteractionSound ? playMobileVoiceInputEndCue : undefined,
  });
  const run = {
    stop: () => session.stop().then(() => undefined),
    cancel: () => session.cancel(),
  };
  if (input.signal?.aborted) throw new AskCardVoiceCancelledError();
  // Publish the handle before awaiting the handshake. stop() closes native
  // capture immediately and still flushes audio recorded before the press.
  input.onRunCreated?.(run);
  try {
    await session.start();
  } catch (error) {
    await session.cancel().catch(() => undefined);
    throw error;
  }
  // The user may have stopped while the voice service was connecting: the
  // microphone is now open, so release it right away instead of leaving it on.
  if (input.signal?.aborted) {
    await session.cancel().catch(() => undefined);
    throw new AskCardVoiceCancelledError();
  }
  return run;
}

function waitUntilActive(
  isAppActive: () => boolean,
  subscribe: (listener: AppStateListener) => () => void,
  signal: AbortSignal,
): Promise<boolean> {
  if (isAppActive()) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const unsubscribe = subscribe((state) => {
      if (state !== 'active' && !isAppActive()) return;
      unsubscribe();
      resolve(true);
    });
    signal.addEventListener('abort', () => {
      unsubscribe();
      reject(new AskCardVoiceCancelledError());
    }, { once: true });
  });
}
