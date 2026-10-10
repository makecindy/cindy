import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AudioLines, Mic, MicOff, PhoneOff, RefreshCw, Send, VolumeX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import type { ChatMessage } from '@/lib/makerChatStore';
import { WebMicAudioEngine } from '@/voice-input/WebMicAudioEngine';
import { getVoiceInputWorkletUrl } from '@/voice-input/workletUrl';
import type {
  VoiceConversationModel,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import { normalizeVoiceConversationSelection } from '@/../shared/voiceConversation';
import { BotAvatar } from '../BotAvatar';
import type { BotChatIdentity } from '../BotSessionContentHeader';
import { VoiceConversationController } from './VoiceConversationController';
import { PcmSpeechPlayer } from './PcmSpeechPlayer';
import './voiceConversation.css';

type Props = {
  bot: BotChatIdentity;
  sessionId: string;
  messages: readonly ChatMessage[];
  blocked: boolean;
  onClose(): void;
  onSend(text: string, onCreated: (id: string) => void, isCurrent: () => boolean): Promise<boolean>;
};

export function CompanionVoicePanel(props: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  const voiceId = useId();
  const latest = useRef(props);
  latest.current = props;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [models, setModels] = useState<VoiceConversationModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [preference, setPreference] = useState<VoiceConversationSelection | null>(
    () => getVoiceInputSettings().conversationSelection ?? null,
  );
  const [voice, setVoice] = useState(preference?.voice ?? 'alloy');
  const modelId = preference?.modelId ?? models[0]?.id ?? '';
  const validModel = models.some((model) => model.id === modelId);
  const selection = normalizeVoiceConversationSelection({ modelId, voice });
  const controller = useMemo(
    () =>
      new VoiceConversationController({
        api: window.electronAPI.voiceConversation,
        botId: props.bot.id,
        sessionId: props.sessionId,
        send: (...args) => latest.current.onSend(...args),
        microphone: (onInterrupted) =>
          new WebMicAudioEngine({
            workletUrl: getVoiceInputWorkletUrl(),
            deviceId: getVoiceInputSettings().microphoneDeviceId ?? undefined,
            chunkMs: 40,
            latencyMs: 10,
            keepAlive: false,
            audioProcessing: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: false,
            },
            onInterrupted,
          }),
        player: (onLevel) => new PcmSpeechPlayer(onLevel),
      }),
    [props.bot.id, props.sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const active = ['connecting', 'listening', 'thinking', 'preparing', 'speaking'].includes(
    state.phase,
  );
  const refreshVersion = useRef(0);
  const refresh = useCallback(async (fetchCatalog = false) => {
    const version = ++refreshVersion.current;
    setLoading(true);
    setCatalogError(false);
    try {
      if (fetchCatalog) await window.electronAPI.maker.refreshBuiltinProviderModels('xd');
      const next = await window.electronAPI.voiceConversation.models();
      if (version === refreshVersion.current) setModels(next);
    } catch {
      if (version === refreshVersion.current) setCatalogError(true);
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    titleRef.current?.focus();
    return () => {
      ++refreshVersion.current;
      controller.end();
    };
  }, [controller, refresh]);
  useEffect(() => controller.setBlocked(props.blocked), [controller, props.blocked]);
  useEffect(() => controller.updateMessages(props.messages), [controller, props.messages]);
  useEffect(() => {
    const initialOwner = getDataOwnerGeneration();
    let owner = `${initialOwner.dataOwnerId}:${initialOwner.generation}`;
    const removeAuth = window.electronAPI.onAuthStateChange((next) => {
      const key = `${next.dataOwnerId}:${next.ownerGeneration}`;
      if (next.ownerBoundaryPending || key !== owner) {
        controller.end();
        latest.current.onClose();
      }
      owner = key;
    });
    const removePower = window.electronAPI.voiceInput.onPowerStateChange(() =>
      controller.setBlocked(true),
    );
    return () => {
      removeAuth();
      removePower();
    };
  }, [controller]);

  const persist = (next: VoiceConversationSelection) => {
    setPreference(next);
    void window.electronAPI.voiceInput
      .updateSettings({ conversationSelection: next })
      .catch(() => setCatalogError(true));
  };
  const start = () => {
    if (!selection || !validModel || props.blocked) return;
    controller.setBlocked(false);
    void controller.start(selection).then(() => controller.retryUnsent());
  };
  const status = props.blocked ? 'confirmation' : state.phase;

  return (
    <section
      className="companion-voice-panel flex max-h-[min(36rem,65vh)] w-full flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]"
      aria-labelledby={labelId}
    >
      <div className="flex shrink-0 items-center gap-2">
        <AudioLines size={16} aria-hidden="true" />
        <h2 ref={titleRef} tabIndex={-1} id={labelId} className="text-13 font-medium outline-none">
          {t('bots.voiceMode.title')}
        </h2>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto w-8 px-0"
          aria-label={t('bots.voiceMode.close')}
          onClick={props.onClose}
        >
          <X size={16} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col items-center gap-3 py-5">
          <div className="flex items-center gap-5">
            <BotAvatar bot={props.bot} size="xl" />
            <div
              className="companion-voice-meter flex h-10 items-center gap-1"
              aria-hidden="true"
              data-active={active}
            >
              {[0.4, 0.7, 1, 0.65, 0.9, 0.5, 0.75].map((weight, index) => (
                <span
                  key={index}
                  className="h-8 w-1 rounded-full bg-[var(--text-secondary)]"
                  style={{ transform: `scaleY(${0.12 + state.level * weight * 0.88})` }}
                />
              ))}
            </div>
          </div>
          <div className="text-center">
            <p className="text-15 font-medium">{props.bot.name}</p>
            <p
              className="mt-1 text-13 text-[var(--text-secondary)]"
              role="status"
              aria-live="polite"
            >
              {t(`bots.voiceMode.status.${status}`)}
            </p>
          </div>
        </div>

        {state.transcript ? (
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-center text-13">
            {state.transcript}
          </p>
        ) : null}
        {state.unsent ? (
          <div className="my-3 rounded-xl border border-[var(--border-default)] p-3">
            <p className="mb-1 text-12 text-[var(--text-secondary)]">
              {t('bots.voiceMode.unsent')}
            </p>
            <p className="max-h-24 select-text overflow-y-auto whitespace-pre-wrap break-words text-13">
              {state.unsent}
            </p>
          </div>
        ) : null}
        {state.error ? (
          <p role="alert" className="mb-3 text-13 text-[var(--error-fg)]">
            {t(`bots.voiceMode.errors.${state.error}`)}
          </p>
        ) : null}

        {!active ? (
          <div className="space-y-3">
            {catalogError || (!loading && models.length === 0) ? (
              <p className="text-13 text-[var(--text-secondary)]">
                {t(catalogError ? 'bots.voiceMode.catalogError' : 'bots.voiceMode.noModels')}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                label={t('bots.voiceMode.model')}
                value={validModel ? modelId : ''}
                options={models.map((model) => ({ value: model.id, label: model.name }))}
                onValueChange={(id) => persist({ modelId: id, voice: selection?.voice ?? 'alloy' })}
                disabled={loading || models.length === 0}
                className="min-w-40 flex-1"
              />
              <Button
                variant="secondary"
                size="md"
                disabled={loading}
                aria-label={t('bots.voiceMode.refresh')}
                title={t('bots.voiceMode.refresh')}
                onClick={() => void refresh(true)}
              >
                <RefreshCw size={15} />
              </Button>
            </div>
            {!validModel && preference && models.length > 0 ? (
              <p className="text-12 text-[var(--text-secondary)]">
                {t('bots.voiceMode.modelUnavailable')}
              </p>
            ) : null}
            {models.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={voiceId} className="text-13 text-[var(--text-secondary)]">
                  {t('bots.voiceMode.voice')}
                </label>
                <Input
                  id={voiceId}
                  value={voice}
                  maxLength={128}
                  onChange={setVoice}
                  onBlur={() => {
                    if (selection && validModel) persist(selection);
                  }}
                  className="min-w-24 flex-1"
                  aria-describedby={`${voiceId}-hint`}
                />
                <p id={`${voiceId}-hint`} className="w-full text-12 text-[var(--text-tertiary)]">
                  {t('bots.voiceMode.voiceHint')}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-center gap-2">
        {!active ? (
          <Button
            variant="primary"
            size="lg"
            onClick={start}
            disabled={!validModel || !selection || props.blocked || loading}
          >
            <Mic size={16} />
            {t(
              state.unsent
                ? 'bots.voiceMode.retrySend'
                : state.phase === 'idle'
                  ? 'bots.voiceMode.start'
                  : 'bots.voiceMode.resume',
            )}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => controller.toggleMute()}
              disabled={state.phase === 'connecting'}
            >
              <MicOff size={16} />
              {t('bots.voiceMode.mute')}
            </Button>
            {state.phase === 'speaking' || state.phase === 'preparing' ? (
              <Button variant="secondary" size="lg" onClick={() => controller.interrupt()}>
                <VolumeX size={16} />
                {t('bots.voiceMode.interrupt')}
              </Button>
            ) : null}
            {state.transcript ? (
              <Button variant="secondary" size="lg" onClick={() => controller.finishUtterance()}>
                <Send size={16} />
                {t('bots.voiceMode.send')}
              </Button>
            ) : null}
            <Button variant="primary" size="lg" onClick={() => controller.end()}>
              <PhoneOff size={16} />
              {t('bots.voiceMode.end')}
            </Button>
          </>
        )}
      </div>
      <p className="mt-3 shrink-0 text-center text-12 leading-relaxed text-[var(--text-tertiary)]">
        {t('bots.voiceMode.hint')}
      </p>
    </section>
  );
}
