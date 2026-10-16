import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { makerChatStore, EMPTY_LIGHT_STATE } from '@/lib/makerChatStore';
import type {
  SpeechProtocol,
  VoiceConversationModel,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import { normalizeVoiceConversationSelection, voiceModelKey } from '@/../shared/voiceConversation';
import { referenceSpeechVoices } from '@/../shared/speechVoices';
import { PcmSpeechPlayer } from './PcmSpeechPlayer';
import { VoicePreviewController } from './VoicePreviewController';
import { SpeechVoicePicker } from './SpeechVoicePicker';
import { resolveVoiceConfiguration } from './voiceConfiguration';

type Props = {
  botId: string;
  sessionId?: string;
  beforeLeaveRef?: { current: (() => Promise<boolean>) | null };
  onOpenProviders(): void;
};

/** Per-companion settings. Opening this page never starts ASR or submits a message. */
export function CompanionVoiceSettings(props: Props) {
  const { t } = useTranslation();
  const sentencePlaybackId = useId();
  const session = useSyncExternalStore(
    useCallback(
      (notify) =>
        props.sessionId ? makerChatStore.subscribeLight(props.sessionId, notify) : () => {},
      [props.sessionId],
    ),
    () => (props.sessionId ? makerChatStore.getLightSnapshot(props.sessionId) : EMPTY_LIGHT_STATE),
  );
  const blocked = Boolean(
    session.pendingPermission ||
    session.pendingAskUser ||
    session.pendingPlanReview ||
    session.pendingPluginSetup ||
    session.pendingIssueConfirm ||
    session.pendingRenameSessionsConfirm ||
    session.pendingGhostGrantConfirm ||
    session.pendingRemoteDesktopConfirmation ||
    session.queuePaused,
  );
  const [models, setModels] = useState<VoiceConversationModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [preference, setPreference] = useState<VoiceConversationSelection | null>(null);
  const [voice, setVoice] = useState<string>();
  const [customized, setCustomized] = useState(false);
  const [sentencePlayback, setSentencePlayback] = useState(true);
  const [preferenceOwner, setPreferenceOwner] = useState<string>();
  const [preferenceError, setPreferenceError] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const ready = preferenceOwner === props.botId;
  const {
    selectedModel,
    protocolOverride,
    incompatibleSavedProtocol,
    selectedVoice,
    selection,
    protocol,
  } = resolveVoiceConfiguration(models, preference, voice);
  const validModel = !!selectedModel;
  const preview = useMemo(
    () =>
      new VoicePreviewController({
        api: window.electronAPI.voiceConversation,
        botId: props.botId,
        sessionId: props.sessionId ?? '',
        player: () => new PcmSpeechPlayer(() => undefined),
      }),
    [props.botId, props.sessionId],
  );
  const refreshVersion = useRef(0);
  const preferenceVersion = useRef(0);
  const refresh = useCallback(async (fetchCatalog = false) => {
    const version = ++refreshVersion.current;
    setLoading(true);
    setCatalogError(false);
    try {
      // A Gateway refresh failure must not hide usable local BYOK connections.
      if (fetchCatalog)
        await window.electronAPI.maker.refreshBuiltinProviderModels('xd').catch(() => undefined);
      const next = await window.electronAPI.voiceConversation.models();
      if (version === refreshVersion.current) setModels(next);
    } catch {
      if (version === refreshVersion.current) setCatalogError(true);
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, []);

  const loadPreference = useCallback(() => {
    const version = ++preferenceVersion.current;
    setPreferenceOwner(undefined);
    setPreferenceError(false);
    setPreference(null);
    setVoice(undefined);
    setCustomized(false);
    setSentencePlayback(true);
    setSaving(false);
    dirty.current = false;
    pendingSave.current = null;
    void window.electronAPI.voiceConversation
      .preference(props.botId)
      .then((result) => {
        if (version !== preferenceVersion.current) return;
        setPreference(result.selection);
        setCustomized(result.customized);
        setSentencePlayback(result.sentencePlayback ?? true);
        setPreferenceOwner(props.botId);
      })
      .catch(() => {
        if (version === preferenceVersion.current) setPreferenceError(true);
      });
  }, [props.botId]);

  useEffect(() => {
    void refresh();
    loadPreference();
    return () => {
      ++refreshVersion.current;
      ++preferenceVersion.current;
      void preview.stop();
    };
  }, [preview, loadPreference, refresh]);
  useEffect(() => {
    if (blocked) void preview.stop();
  }, [blocked, preview]);
  useEffect(() => {
    const initialOwner = getDataOwnerGeneration();
    const owner = `${initialOwner.dataOwnerId}:${initialOwner.generation}`;
    const removeAuth = window.electronAPI.onAuthStateChange((next) => {
      if (next.ownerBoundaryPending || `${next.dataOwnerId}:${next.ownerGeneration}` !== owner) {
        ++refreshVersion.current;
        ++preferenceVersion.current;
        setPreferenceOwner(undefined);
        void preview.stop();
      }
    });
    const removePower = window.electronAPI.voiceInput.onPowerStateChange(() => {
      void preview.stop();
    });
    const hidden = () => {
      if (document.hidden) void preview.stop();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      removeAuth();
      removePower();
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [preview]);
  const persist = useCallback(
    (
      next: VoiceConversationSelection | null | undefined,
      playback?: boolean | null,
    ): Promise<boolean> => {
      if (pendingSave.current) return pendingSave.current;
      const version = preferenceVersion.current;
      setSaving(true);
      setPreferenceError(false);
      const api = window.electronAPI.voiceConversation;
      const operation =
        playback === undefined
          ? api.setPreference(props.botId, next)
          : api.setPreference(props.botId, next, playback);
      const pending = operation
        .then((result) => {
          if (version !== preferenceVersion.current) return false;
          // A playback-only change must not erase an unfinished model/voice draft.
          if (next !== undefined) {
            setPreference(result.selection);
            setVoice(undefined);
            dirty.current = false;
          }
          setCustomized(result.customized);
          setSentencePlayback(result.sentencePlayback ?? true);
          return true;
        })
        .catch(() => {
          if (version === preferenceVersion.current) setPreferenceError(true);
          return false;
        })
        .finally(() => {
          if (version === preferenceVersion.current) {
            setSaving(false);
            pendingSave.current = null;
          }
        });
      pendingSave.current = pending;
      return pending;
    },
    [props.botId],
  );
  useEffect(() => {
    const ref = props.beforeLeaveRef;
    if (!ref) return;
    ref.current = async () => {
      const version = preferenceVersion.current;
      await preview.stop();
      if (version !== preferenceVersion.current) return true;
      if (pendingSave.current && !(await pendingSave.current)) return false;
      // Flush a valid manual ID before the drawer/page unmounts. Incomplete
      // choices stay a local draft and never overwrite the last usable route.
      if (ready && dirty.current && selection && protocol) return persist(selection);
      return true;
    };
    return () => {
      ref.current = null;
    };
  }, [props.beforeLeaveRef, persist, ready, selection, protocol, preview]);
  const chooseModel = (key: string) => {
    const model = models.find((item) => voiceModelKey(item) === key);
    if (!model) return;
    const next = {
      providerId: model.providerId,
      agent: model.agent,
      modelId: model.id,
      // Voice compatibility is model-specific, even within the same connection/protocol.
      voice: model.defaultVoice ?? '',
    };
    void preview.stop();
    dirty.current = true;
    setCustomized(true);
    setPreference(next);
    setVoice(next.voice);
    if (
      normalizeVoiceConversationSelection(next) &&
      resolveVoiceConfiguration(models, next).protocol
    )
      void persist(next);
  };

  // Keep unavailable controls out of the empty state, including while its first
  // catalog request is pending. This only changes presentation, not saved preferences.
  if (models.length === 0) {
    return (
      <div className="space-y-4 pt-3">
        {loading ? (
          <p role="status" className="text-13 text-[var(--text-secondary)]">
            {t('bots.voiceMode.status.loading')}
          </p>
        ) : catalogError ? (
          <>
            <p className="text-13 text-[var(--text-secondary)]">
              {t('bots.voiceMode.catalogError')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              compact
              onClick={() => {
                void refresh(true);
                if (!ready) loadPreference();
              }}
            >
              {t('bots.voiceMode.refresh')}
            </Button>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-13 text-[var(--text-secondary)]">{t('bots.voiceMode.noModels')}</p>
            <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
              {t('bots.voiceMode.noModelsSupportedProtocols')}
            </p>
            <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
              {t('bots.voiceMode.noModelsSetupHint')}
            </p>
            <Button variant="secondary" size="sm" compact onClick={props.onOpenProviders}>
              {t('bots.voiceMode.openProviders')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-3">
      <p className="text-13 leading-relaxed text-[var(--text-secondary)]">
        {t('bots.voiceMode.settingsHint')}
      </p>
      {catalogError ? (
        <p className="text-13 text-[var(--text-secondary)]">{t('bots.voiceMode.catalogError')}</p>
      ) : null}
      <div className="flex flex-wrap items-start gap-3">
        <FormField label={t('bots.voiceMode.model')} className="min-w-52 flex-[2]">
          {(control) => (
            <div className="flex items-center gap-2">
              <Select
                {...control}
                label={t('bots.voiceMode.model')}
                value={selectedModel ? voiceModelKey(selectedModel) : ''}
                options={models.map((model) => ({
                  value: voiceModelKey(model),
                  label: [model.name, model.providerName].filter(Boolean).join(' · '),
                }))}
                onValueChange={chooseModel}
                disabled={loading || !ready || saving || models.length === 0}
                className="flex-1"
              />
              <Button
                variant="secondary"
                size="lg"
                className="w-9 shrink-0 px-0"
                disabled={loading}
                aria-label={t('bots.voiceMode.refresh')}
                title={t('bots.voiceMode.refresh')}
                onClick={() => {
                  void refresh(true);
                  if (!ready) loadPreference();
                }}
              >
                <RefreshCw size={15} />
              </Button>
            </div>
          )}
        </FormField>
        {!validModel && preference && models.length > 0 ? (
          <p className="w-full text-12 text-[var(--text-secondary)]">
            {t('bots.voiceMode.modelUnavailable')}
          </p>
        ) : null}
        {selectedModel &&
        selectedModel.providerId !== 'xd' &&
        selectedModel.agent &&
        !selectedModel.protocolLocked ? (
          <FormField
            label={t('bots.voiceMode.protocol')}
            hint={t('bots.voiceMode.protocolHint')}
            className="min-w-52 flex-1"
          >
            {(control) => (
              <Select
                {...control}
                label={t('bots.voiceMode.protocol')}
                value={protocol ?? ''}
                options={[
                  { value: 'openai', label: t('bots.voiceMode.protocolOpenai') },
                  { value: 'elevenlabs', label: 'ElevenLabs' },
                  { value: 'minimax', label: 'MiniMax' },
                ]}
                disabled={!ready || saving}
                onValueChange={(value) => {
                  const next = {
                    providerId: selectedModel.providerId,
                    agent: selectedModel.agent,
                    modelId: selectedModel.id,
                    voice:
                      referenceSpeechVoices(selectedModel.id, value as SpeechProtocol)[0] ?? '',
                    protocol: value as SpeechProtocol,
                  };
                  void preview.stop();
                  dirty.current = true;
                  setCustomized(true);
                  setPreference(next);
                  setVoice(next.voice);
                  if (normalizeVoiceConversationSelection(next)) void persist(next);
                }}
                className="w-full"
              />
            )}
          </FormField>
        ) : null}
      </div>
      {ready && incompatibleSavedProtocol && voice === undefined ? (
        <p role="status" className="text-12 text-[var(--text-secondary)]">
          {t('bots.voiceMode.protocolCorrectedHint')}
        </p>
      ) : null}
      {ready && selectedModel ? (
        <SpeechVoicePicker
          botId={props.botId}
          route={{
            providerId: selectedModel.providerId,
            agent: selectedModel.agent,
            modelId: selectedModel.id,
            protocol: protocolOverride,
          }}
          protocol={protocol}
          voice={selectedVoice}
          disabled={!ready || saving || blocked}
          previewDisabled={!ready || blocked || !props.sessionId}
          preview={preview}
          onChange={(value, save) => {
            dirty.current = true;
            setVoice(value);
            const next = normalizeVoiceConversationSelection({
              providerId: selectedModel.providerId,
              agent: selectedModel.agent,
              modelId: selectedModel.id,
              protocol: protocolOverride,
              voice: value,
            });
            if (save && next && validModel && protocol) void persist(next);
          }}
        />
      ) : null}
      {dirty.current && (!selection || !protocol) ? (
        <p className="text-12 text-[var(--text-secondary)]">
          {t('bots.voiceMode.incompleteSettings')}
        </p>
      ) : null}
      {!props.sessionId ? (
        <p className="text-12 text-[var(--text-secondary)]">
          {t('bots.voiceMode.previewNeedsChat')}
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <label
            htmlFor={sentencePlaybackId}
            className="text-13 font-medium text-[var(--settings-section-title)]"
          >
            {t('bots.voiceMode.sentencePlayback')}
          </label>
          <p
            id={`${sentencePlaybackId}-hint`}
            className="text-12 leading-snug text-[var(--form-field-hint)]"
          >
            {t('bots.voiceMode.sentencePlaybackHint')}
          </p>
        </div>
        <Switch
          id={sentencePlaybackId}
          aria-describedby={`${sentencePlaybackId}-hint`}
          className="shrink-0"
          checked={sentencePlayback}
          disabled={!ready || saving}
          onCheckedChange={(enabled) => void persist(undefined, enabled)}
        />
      </div>
      {preferenceError ? (
        <p role="alert" className="text-13 text-[var(--error-fg)]">
          {t('bots.voiceMode.preferenceError')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-12 text-[var(--text-tertiary)]">
          {t('bots.voiceMode.preferenceHint')}
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={!ready || saving || (!customized && !dirty.current)}
          onClick={() => void persist(null, null)}
        >
          {t('bots.voiceMode.resetPreference')}
        </Button>
      </div>
    </div>
  );
}
