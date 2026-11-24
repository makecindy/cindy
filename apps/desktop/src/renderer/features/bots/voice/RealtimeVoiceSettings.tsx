import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/components/ui/form-field';
import { Select } from '@/components/ui/select';
import type { VoicePreviewController } from './VoicePreviewController';
import { RealtimeVoicePicker } from './RealtimeVoicePicker';
import { voiceModelKey } from '@/../shared/voiceConversation';
import {
  normalizeRealtimeVoiceSelection,
  realtimeSystemVoices,
  REALTIME_PROTOCOLS,
  type RealtimeVoiceModel,
  type RealtimeVoiceSelection,
} from '@/../shared/realtimeVoice';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

/** Independent from TTS: changing call transport must not change message read-aloud. */
export function RealtimeVoiceSettings({ botId, disabled, preview, previewDisabled, beforeLeaveRef, children }: {
  botId: string;
  disabled: boolean;
  preview: VoicePreviewController;
  previewDisabled: boolean;
  beforeLeaveRef: { current: (() => Promise<boolean>) | null };
  children: (readAloudOnly: boolean, hidden: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<RealtimeVoiceModel[]>([]);
  const [selection, setSelection] = useState<RealtimeVoiceSelection | null>(null);
  const previousSelection = useRef<RealtimeVoiceSelection | null>(null);
  const [readAloudOpen, setReadAloudOpen] = useState(false);
  const readAloudId = useId();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const version = useRef(0);
  const saveLock = useRef(false);
  const lastWrite = useRef<Promise<boolean> | null>(null);
  const manualInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    beforeLeaveRef.current = async () => {
      // Keyboard dismissal can precede the manual input's blur.
      manualInput.current?.blur();
      const write = lastWrite.current;
      if (!write) return true;
      const allowed = await write;
      if (lastWrite.current === write) lastWrite.current = null;
      return allowed;
    };
    return () => { beforeLeaveRef.current = null; };
  }, [beforeLeaveRef]);
  const loadedOwner = useRef<ReturnType<typeof getDataOwnerGeneration> | null>(null);
  const [api] = useState(() => window.electronAPI.voiceConversation);
  useEffect(() => {
    if (!api.realtimeModels || !api.setRealtimePreference) return;
    const load = () => {
      const generation = getDataOwnerGeneration(),
        epoch = ++version.current;
      loadedOwner.current = null;
      const current = () => version.current === epoch && generation === getDataOwnerGeneration();
      setLoading(true);
      setError(false);
      setSelection(null);
      saveLock.current = false;
      lastWrite.current = null;
      setSaving(false);
      previousSelection.current = null;
      setReadAloudOpen(false);
      void Promise.all([api.realtimeModels?.() ?? [], api.preference(botId)])
        .then(([list, pref]) => {
          if (current()) {
            loadedOwner.current = generation;
            setModels(list);
            previousSelection.current = pref.realtimeSelection ?? pref.previousRealtimeSelection ?? null;
            setSelection(pref.realtimeSelection ?? null);
          }
        })
        .catch(() => {
          if (current()) setError(true);
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    };
    load();
    const unsubscribe = window.electronAPI.onAuthStateChange(load);
    const unsubscribeProviders = window.electronAPI.maker?.onProvidersChanged?.(load);
    return () => {
      unsubscribeProviders?.();
      ++version.current;
      unsubscribe();
    };
  }, [botId, api]);
  const selectedModel = models.find(
    (m) => selection && voiceModelKey(m) === voiceModelKey(selection),
  );
  const visible = models.filter((m) => m.pickerVisible !== false || m === selectedModel);
  const save = (value: RealtimeVoiceSelection | null) => {
    if (
      saveLock.current ||
      disabled ||
      loading ||
      !api.setRealtimePreference ||
      loadedOwner.current !== getDataOwnerGeneration()
    )
      return;
    const generation = getDataOwnerGeneration(),
      epoch = version.current;
    const current = () => version.current === epoch && generation === getDataOwnerGeneration();
    if (value && !normalizeRealtimeVoiceSelection(value)) {
      setError(true);
      return;
    }
    saveLock.current = true;
    setSaving(true);
    setError(false);
    lastWrite.current = api.setRealtimePreference(botId, value).then(result => {
      if (current()) {
        previousSelection.current = result.realtimeSelection ?? result.previousRealtimeSelection ?? previousSelection.current;
        setSelection(result.realtimeSelection ?? null);
        if (!value) setReadAloudOpen(false);
      }
      return true;
    }).catch(() => {
      if (current()) setError(true);
      return !current();
    }).finally(() => {
      if (current()) {
        saveLock.current = false;
        setSaving(false);
      }
    });
  };
  if (!api.realtimeModels || !api.setRealtimePreference) return children(false, false);
  const chooseRoute = (next: RealtimeVoiceSelection, protocolConfirmed: boolean) => {
    if (protocolConfirmed && next.voice) void save(next);
    else setSelection(next);
  };
  const hideSpeech = loading || (!!selection && !readAloudOpen);
  return (
    <>
      <section
        className="space-y-3"
        aria-label={t('bots.voiceMode.realtime.title')}
        aria-busy={loading || saving}
      >
        <FormField label={t('bots.voiceMode.realtime.callMode')}>
          {(control) => (
            <Select
              {...control}
              label={t('bots.voiceMode.realtime.callMode')}
              value={selection ? voiceModelKey(selection) : 'speech'}
              options={[
                { value: 'speech', label: t('bots.voiceMode.realtime.off') },
                ...visible.map((m) => ({
                  value: voiceModelKey(m),
                  label: `${m.name} · ${m.providerName}`,
                })),
                ...(selection && !selectedModel
                  ? [{ value: voiceModelKey(selection), label: selection.modelId, disabled: true }]
                  : []),
              ]}
              disabled={disabled || loading || saving}
              onValueChange={(key) => {
                if (key === 'speech') {
                  void save(null);
                  return;
                }
                const model = models.find((m) => voiceModelKey(m) === key);
                if (!model) return;
                const previous = previousSelection.current;
                if (previous && voiceModelKey(previous) === key && (!model.protocolLocked || previous.protocol === model.protocol)) {
                  void save(previous);
                  return;
                }
                const protocol = model.protocol ?? 'openai-realtime';
                chooseRoute({
                  mode: 'realtime',
                  providerId: model.providerId,
                  agent: model.agent,
                  modelId: model.id,
                  protocol,
                  voice: (model.systemVoices ?? realtimeSystemVoices(protocol, model.id))[0]?.id ?? '',
                }, !!model.protocol);
              }}
            />
          )}
        </FormField>
        {selection && (
          <div className="flex flex-wrap items-start gap-3">
            {!selectedModel?.protocolLocked && (
              <FormField label={t('bots.voiceMode.protocol')} className="min-w-48 flex-1">
                {(control) => (
                  <Select
                    {...control}
                    label={t('bots.voiceMode.protocol')}
                    value={selection.protocol}
                    options={REALTIME_PROTOCOLS.map((p) => ({
                      value: p,
                      label: p === 'openai-realtime' ? 'OpenAI Realtime' : 'Qwen-Audio Realtime',
                    }))}
                    disabled={disabled || saving || !selectedModel}
                    onValueChange={(protocol) =>
                      chooseRoute({
                        ...selection,
                        protocol: protocol as RealtimeVoiceSelection['protocol'],
                        voice: realtimeSystemVoices(
                          protocol as RealtimeVoiceSelection['protocol'],
                          selection.modelId,
                        )[0]?.id ?? '',
                      }, true)
                    }
                  />
                )}
              </FormField>
            )}
            <RealtimeVoicePicker key={JSON.stringify([voiceModelKey(selection), selection.protocol])}
              preview={preview} previewDisabled={previewDisabled || !selectedModel || loading || saving}
              manualInput={manualInput} model={selectedModel} selection={selection} disabled={disabled || saving || !selectedModel}
              onSelect={(voice) => void save({ ...selection, voice })}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-13 text-[var(--error-fg)]">
            {t('bots.voiceMode.preferenceError')}
          </p>
        )}
      </section>
      <div className={selection ? 'space-y-3 border-t border-[var(--border-default)] pt-3' : undefined}>
        {selection && (
          <button
            type="button"
            aria-expanded={readAloudOpen}
            aria-controls={readAloudId}
            onClick={() => setReadAloudOpen(!readAloudOpen)}
            className="flex min-h-9 w-full items-center justify-between gap-3 rounded-full px-3 text-left text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            {t('bots.voiceMode.realtime.messageReadAloud')}
            <ChevronDown size={15} aria-hidden className={readAloudOpen ? 'rotate-180' : undefined} />
          </button>
        )}
        <div id={readAloudId} hidden={hideSpeech}>
          {children(!!selection, hideSpeech)}
        </div>
      </div>
    </>
  );
}
