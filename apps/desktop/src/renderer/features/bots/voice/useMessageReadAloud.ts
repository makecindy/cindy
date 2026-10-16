import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { MessageReadAloud } from '@/components/chat/MessageReadAloudContext';
import { toast } from '@/lib/toast';
import { MessageReadAloudController } from './MessageReadAloudController';
import { PcmSpeechPlayer } from './PcmSpeechPlayer';
import { resolveVoiceConfiguration } from './voiceConfiguration';
import { speechText } from './VoiceReplyTracker';

const canRead = (text: string) => Boolean(speechText(text));

export function useMessageReadAloud(options: {
  botId?: string;
  sessionId: string;
  enabled: boolean;
  voiceModeOpen: boolean;
}) {
  const { t } = useTranslation();
  const api = window.electronAPI.voiceConversation;
  const latest = useRef(options);
  latest.current = options;
  const ownerValid = useRef(true);
  const scopeVersion = useRef(0);
  const controller = useMemo(
    () =>
      new MessageReadAloudController({
        api,
        botId: options.botId ?? '',
        sessionId: options.sessionId,
        player: () => new PcmSpeechPlayer(() => {}),
      }),
    [api, options.botId, options.sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [availability, setAvailability] = useState({ controller, available: false });
  const refreshVersion = useRef(0);
  const enabled = options.enabled && Boolean(api?.startPlayback);

  const loadSelection = useCallback(async () => {
    const [models, preference] = await Promise.all([api.models(), api.preference(options.botId!)]);
    // A message action must use an already chosen route, never silently pick the first model.
    if (!preference.selection) return undefined;
    const { selection, protocol } = resolveVoiceConfiguration(models, preference.selection);
    return protocol && selection ? selection : undefined;
  }, [api, options.botId]);

  useEffect(() => {
    if (!enabled) {
      void controller.stop();
      return;
    }
    let disposed = false;
    const refresh = async () => {
      const version = ++refreshVersion.current;
      const selection = await loadSelection().catch(() => undefined);
      if (disposed || version !== refreshVersion.current || !ownerValid.current) return;
      setAvailability({ controller, available: Boolean(selection) });
      if (!selection) void controller.stop();
    };
    const removeSettings = window.electronAPI.voiceInput.onDataChanged(() => {
      void refresh();
    });
    const removeProviders = window.electronAPI.maker.onProvidersChanged(() => {
      void refresh();
    });
    window.addEventListener('focus', refresh);
    void refresh();
    return () => {
      disposed = true;
      ++scopeVersion.current;
      ++refreshVersion.current;
      removeSettings();
      removeProviders();
      window.removeEventListener('focus', refresh);
      void controller.stop();
    };
  }, [enabled, controller, loadSelection]);

  useEffect(() => {
    if (options.voiceModeOpen) void controller.stop();
  }, [controller, options.voiceModeOpen]);

  useEffect(() => {
    if (!enabled) return;
    const owner = getDataOwnerGeneration();
    ownerValid.current = true;
    const removeAuth = window.electronAPI.onAuthStateChange((next) => {
      if (
        next.ownerBoundaryPending ||
        next.dataOwnerId !== owner.dataOwnerId ||
        next.ownerGeneration !== owner.generation
      ) {
        ownerValid.current = false;
        ++scopeVersion.current;
        ++refreshVersion.current;
        setAvailability({ controller, available: false });
        void controller.stop();
      }
    });
    const removePower = window.electronAPI.voiceInput.onPowerStateChange(() => {
      ++scopeVersion.current;
      void controller.stop();
    });
    return () => {
      removeAuth();
      removePower();
    };
  }, [enabled, controller]);

  useEffect(() => {
    if (state.phase === 'error') toast.warning(t('bots.voiceMode.readAloudFailed'));
  }, [state.phase, t]);

  const toggle = useCallback(
    (messageId: string, text: string) => {
      if (controller.getSnapshot().messageId === messageId) {
        void controller.stop();
        return;
      }
      if (!latest.current.enabled || latest.current.voiceModeOpen || !ownerValid.current) return;
      void controller.start(messageId, text, async () => {
        const selection = await loadSelection();
        if (
          !latest.current.enabled ||
          latest.current.voiceModeOpen ||
          !ownerValid.current ||
          latest.current.botId !== options.botId ||
          latest.current.sessionId !== options.sessionId
        )
          return undefined;
        setAvailability({ controller, available: Boolean(selection) });
        return selection;
      });
    },
    [controller, loadSelection, options.botId, options.sessionId],
  );

  const value = useMemo<MessageReadAloud | null>(
    () =>
      enabled
        ? {
            sessionId: options.sessionId,
            available: availability.controller === controller && availability.available,
            disabled: options.voiceModeOpen,
            ...state,
            canRead,
            toggle,
          }
        : null,
    [enabled, options.sessionId, options.voiceModeOpen, availability, controller, state, toggle],
  );
  const stopForVoiceMode = useCallback(async () => {
    const version = scopeVersion.current;
    await controller.stop();
    // A pending handover must not reopen capture after navigation, suspend or account change.
    return version === scopeVersion.current && ownerValid.current;
  }, [controller]);
  return { value, stopForVoiceMode };
}
