import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createMobileVoiceConversation, type MobileVoiceConversation, type MobileVoiceConversationState } from './mobileVoiceConversation';
import { isMobileVoiceSpeechAvailable, speakMobileVoiceReply } from './mobileVoiceSpeech';
import {
  clearUntransferredVoiceConversationIntent,
  clearVoiceConversationIntent,
  takeVoiceConversationIntent,
  takeVoiceConversationSessionHandoff,
} from './voiceConversationIntent';
import { findVoiceConversationReply } from './voiceConversationReply';
import type { MobileMessageRenderItem } from './messageRenderModel';

type Options = {
  requestId: string | null;
  scope: string;
  deviceId: string;
  sessionId?: string;
  ready: boolean;
  focused: boolean;
  draft: string;
  getDraft?(): string;
  voiceError: string | null;
  blocked?: boolean;
  startListening(): Promise<void>;
  finishListening(): Promise<string | null>;
  cancelListening(): void | Promise<void>;
  send(text: string): Promise<string | undefined>;
  items?: readonly MobileMessageRenderItem[];
  running?: boolean;
};

type Lifetime = {
  options: Options;
  controller: MobileVoiceConversation | null;
  alive: boolean;
  claimed: boolean;
  checked: boolean;
  ended: boolean;
  expectedClientId: string;
  initialMode: 'capture' | 'waiting' | null;
  started: boolean;
  focusedOnce: boolean;
  foregroundOnce: boolean;
  speech?: { abort: AbortController; work: Promise<unknown> };
};

/** Screen lifetime owns microphone/playback; route parameters alone cannot authorize a replay. */
export function useVoiceConversation(options: Options) {
  const { t, i18n } = useTranslation();
  // Keep each scope's last callbacks; old cleanup cannot read a new scope's adapters.
  const lifetime = useMemo<Lifetime>(() => ({
    options, controller: null, alive: false, claimed: false, checked: false,
    ended: false, expectedClientId: '', initialMode: null, started: false,
    focusedOnce: options.focused, foregroundOnce: AppState.currentState === 'active',
  }), [options.scope, options.requestId]);
  lifetime.options = options;
  const current = useRef(lifetime);
  current.current = lifetime;
  const cleanup = useRef<Promise<void>>(Promise.resolve());
  const text = useRef({ t, language: i18n.language });
  text.current = { t, language: i18n.language };
  const [state, setState] = useState<MobileVoiceConversationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [expectedClientId, setExpectedClientId] = useState('');
  const ownsScreen = (value: Lifetime) => Platform.OS === 'ios'
    && value.alive && !value.ended && current.current === value;

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    lifetime.alive = true;
    lifetime.started = false;
    const previousCleanup = cleanup.current;
    setState('idle');
    if (!lifetime.checked) {
      setVisible(false);
      setError(null);
    }
    setExpectedClientId('');
    const conversation = createMobileVoiceConversation({
      startListening: async () => {
        // dispose() includes late capture completion, so old cleanup cannot
        // release the microphone after a new scope has acquired it.
        await previousCleanup;
        const before = lifetime.options;
        if (!ownsScreen(lifetime) || lifetime.controller !== conversation || conversation.getState() !== 'starting'
          || !before.ready || !before.focused
          || before.blocked || AppState.currentState !== 'active') {
          throw new Error('VOICE_CONVERSATION_INACTIVE');
        }
        if ((before.getDraft?.() ?? before.draft).trim()) throw new Error('VOICE_CONVERSATION_EXISTING_DRAFT');
        await before.startListening();
        if (!ownsScreen(lifetime) || lifetime.controller !== conversation) return; // The disposed controller releases late starts.
        const after = lifetime.options;
        if (!after.ready || !after.focused || after.blocked || AppState.currentState !== 'active') {
          throw new Error('VOICE_CONVERSATION_INACTIVE');
        }
      },
      finishListening: () => {
        const value = lifetime.options;
        if (!ownsScreen(lifetime) || !value.focused || value.blocked || AppState.currentState !== 'active') {
          return Promise.reject(new Error('VOICE_CONVERSATION_INACTIVE'));
        }
        return value.finishListening();
      },
      cancelListening: () => {
        // This hook also mounts on ordinary task pages; without a claimed voice
        // launch it does not own their manual dictation microphone.
        if (lifetime.claimed) return lifetime.options.cancelListening();
      },
      send: async value => {
        const owner = lifetime.options;
        if (!ownsScreen(lifetime) || !owner.focused || owner.blocked || AppState.currentState !== 'active') {
          throw new Error('VOICE_CONVERSATION_INACTIVE');
        }
        // Do not queue the previous turn's late answer during the next send.
        lifetime.expectedClientId = '';
        if (ownsScreen(lifetime) && lifetime.controller === conversation) setExpectedClientId('');
        const clientId = await lifetime.options.send(value);
        if (!clientId) throw new Error(text.current.t('session.voiceConversation.sendFailed'));
        if (ownsScreen(lifetime) && lifetime.controller === conversation) {
          lifetime.expectedClientId = clientId;
          setExpectedClientId(clientId);
        }
      },
      speak: async value => {
        const abort = new AbortController();
        const work = speakMobileVoiceReply(value, { language: text.current.language, signal: abort.signal });
        const speech = { abort, work };
        lifetime.speech = speech;
        try {
          if (await work !== 'done') throw new Error(text.current.t('session.voiceConversation.interrupted'));
        } finally {
          if (lifetime.speech === speech) lifetime.speech = undefined;
        }
      },
      stopSpeaking: async () => {
        const speech = lifetime.speech;
        speech?.abort.abort();
        await speech?.work.catch(() => undefined);
      },
      onStateChanged: next => { if (ownsScreen(lifetime) && lifetime.controller === conversation) setState(next); },
      onError: error => {
        if (!ownsScreen(lifetime) || lifetime.controller !== conversation) return;
        setError(text.current.t(error instanceof Error && error.message === 'VOICE_CONVERSATION_EXISTING_DRAFT'
          ? 'session.voiceConversation.existingDraft' : 'session.voiceConversation.failed'));
      },
    });
    lifetime.controller = conversation;
    return () => {
      lifetime.alive = false;
      cleanup.current = Promise.all([previousCleanup, conversation.dispose()]).then(() => {
        // StrictMode replays effects on the same lifetime; pending device discovery
        // can also change scope before a launch has been claimed.
        if (!lifetime.alive && lifetime.claimed && lifetime.options.requestId) {
          clearUntransferredVoiceConversationIntent(lifetime.options.requestId);
        }
      });
      if (lifetime.controller === conversation) lifetime.controller = null;
    };
  }, [lifetime]);

  const pause = useCallback((cancelPending = false) => {
    if (!ownsScreen(lifetime)) return;
    if (!lifetime.claimed) {
      if (cancelPending) {
        lifetime.ended = true;
        if (lifetime.options.requestId) clearUntransferredVoiceConversationIntent(lifetime.options.requestId);
      }
      return;
    }
    // A first send may finish after the user leaves. Do not let its destination
    // rearm voice; an already transferred handoff survives normal navigation.
    if (!lifetime.options.sessionId && lifetime.controller?.getState() === 'sending') {
      if (lifetime.options.requestId) clearUntransferredVoiceConversationIntent(lifetime.options.requestId);
      lifetime.ended = true;
      setVisible(false);
    }
    void lifetime.controller?.pause();
  }, [lifetime]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const subscription = AppState.addEventListener('change', next => {
      setActive(next === 'active');
      if (next === 'active') lifetime.foregroundOnce = true;
      // Permission sheets can transiently deactivate the app before capture.
      // The capture adapter handles that prompt; post-start guards check again.
      if (next !== 'active' && lifetime.foregroundOnce && lifetime.controller?.getState() !== 'starting') pause(true);
    });
    return () => subscription.remove();
  }, [lifetime, pause]);
  useEffect(() => {
    if (options.focused) lifetime.focusedOnce = true;
    else if (lifetime.focusedOnce) pause(true);
  }, [lifetime, options.focused, pause]);

  useEffect(() => {
    if (!options.requestId || lifetime.started || !options.ready || !options.focused || !active
      || options.blocked || options.voiceError || !ownsScreen(lifetime)) return;
    if (!lifetime.checked) {
      lifetime.checked = true;
      const handoff = options.sessionId
        ? takeVoiceConversationSessionHandoff(options.requestId, { sessionId: options.sessionId, deviceId: options.deviceId })
        : null;
      const accepted = !!handoff || (!options.sessionId && takeVoiceConversationIntent(options.requestId));
      if (!accepted) return;
      lifetime.claimed = true;
      if (handoff) lifetime.expectedClientId = handoff.clientId;
      if (!isMobileVoiceSpeechAvailable()) {
        setVisible(true);
        setError(t('session.voiceConversation.updateRequired'));
        return;
      }
      if (!handoff && (options.getDraft?.() ?? options.draft).trim()) {
        setVisible(true);
        setError(t('session.voiceConversation.existingDraft'));
        return;
      }
      lifetime.initialMode = handoff ? 'waiting' : 'capture';
    }
    if (!lifetime.claimed || !lifetime.initialMode) return;
    lifetime.started = true;
    setVisible(true);
    setExpectedClientId(lifetime.expectedClientId);
    void lifetime.controller?.begin({ waiting: lifetime.initialMode === 'waiting', initialDraft: options.getDraft?.() ?? options.draft });
  }, [lifetime, options.requestId, options.ready, options.focused, options.sessionId, options.deviceId,
    options.draft, options.blocked, options.voiceError, active, t]);

  useEffect(() => { lifetime.controller?.onTranscriptChanged(options.draft); }, [lifetime, options.draft]);
  useEffect(() => {
    if (!lifetime.claimed || !options.voiceError) return;
    setError(options.voiceError);
    pause();
  }, [lifetime, options.voiceError, pause]);
  useEffect(() => { if (options.blocked) pause(); }, [options.blocked, pause]);
  useEffect(() => {
    if (!ownsScreen(lifetime) || expectedClientId !== lifetime.expectedClientId) return;
    const reply = findVoiceConversationReply(options.items ?? [], expectedClientId, options.running === true);
    if (reply && !options.blocked && !options.voiceError && options.focused && active) {
      void lifetime.controller?.onReply(reply);
    }
  }, [lifetime, options.items, options.running, options.blocked, options.voiceError,
    options.focused, expectedClientId, active, state]);

  const stop = useCallback(() => {
    if (current.current !== lifetime) return;
    lifetime.ended = true;
    if (lifetime.options.requestId) clearVoiceConversationIntent(lifetime.options.requestId);
    setVisible(false);
    void lifetime.controller?.stop();
  }, [lifetime]);
  const resume = useCallback(() => {
    const value = lifetime.options;
    if (!ownsScreen(lifetime) || !lifetime.claimed || !value.ready || !value.focused
      || value.blocked || AppState.currentState !== 'active') return;
    if (!isMobileVoiceSpeechAvailable()) { setError(t('session.voiceConversation.updateRequired')); return; }
    if ((value.getDraft?.() ?? value.draft).trim()) { setError(t('session.voiceConversation.existingDraft')); return; }
    setError(null);
    // Resume explicitly retries an ASR error; the recording adapter clears it.
    void lifetime.controller?.begin();
  }, [lifetime, t]);
  const submit = useCallback(() => {
    const value = lifetime.options;
    if (ownsScreen(lifetime) && value.focused && !value.blocked && AppState.currentState === 'active') {
      void lifetime.controller?.submit();
    }
  }, [lifetime]);
  const canHandoff = useCallback(() => ownsScreen(lifetime) && lifetime.claimed
    && lifetime.controller?.getState() === 'sending', [lifetime]);
  const onTranscriptChanged = useCallback((value: string) => {
    if (ownsScreen(lifetime)) lifetime.controller?.onTranscriptChanged(value);
  }, [lifetime]);
  return { visible, state, error, stop, resume, submit, canHandoff, onTranscriptChanged,
    active: visible && state !== 'idle' && state !== 'paused' };
}
