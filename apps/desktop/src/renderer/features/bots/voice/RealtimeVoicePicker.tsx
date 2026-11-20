import { useEffect, useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SpeechVoiceMenu } from './SpeechVoiceMenu';
import type { VoicePreviewController } from './VoicePreviewController';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import { getDataOwnerGeneration, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  realtimeSystemVoices,
  type RealtimeVoiceModel,
  type RealtimeVoiceSelection,
} from '@/../shared/realtimeVoice';
import type { SpeechVoice, SpeechVoiceCatalog } from '@/../shared/voiceConversation';

type Props = {
  model?: RealtimeVoiceModel;
  selection: RealtimeVoiceSelection;
  disabled: boolean;
  preview: VoicePreviewController;
  previewDisabled: boolean;
  onSelect(voice: string): void;
};

export function RealtimeVoicePicker({ model, selection, disabled, preview, previewDisabled, onSelect }: Props) {
  const { t } = useTranslation();
  const { modelId, protocol, providerId, agent, voice } = selection;
  const system = model?.systemVoices ?? realtimeSystemVoices(protocol, modelId);
  const list = model?.hasCustomVoiceCatalog
    ? window.electronAPI.voiceConversation.realtimeCustomVoices
    : undefined;
  const [revision, setRevision] = useState(0);
  const owner = getDataOwnerGeneration();
  const [result, setResult] = useState<{ owner: DataOwnerGeneration; revision: number; catalog: SpeechVoiceCatalog }>();
  const catalog = list && result?.owner === owner ? result.catalog : undefined;
  const loading = !!list && (!catalog || result?.revision !== revision);
  const [manualDraft, setManualDraft] = useState<string>();
  const manual = manualDraft !== undefined || !voice;
  useEffect(() => {
    if (!list) return;
    let active = true;
    const accept = (catalog: SpeechVoiceCatalog) => {
      if (active && owner === getDataOwnerGeneration()) setResult({ owner, revision, catalog });
    };
    list({ providerId, agent, modelId }).then(accept, () =>
      accept({ source: 'manual', voices: [], customVoicesUnavailable: true }),
    );
    return () => {
      active = false;
    };
  }, [list, providerId, agent, modelId, revision, owner]);

  const [previewVoice, setPreviewVoice] = useState<string>();
  const phase = useSyncExternalStore(preview.subscribe, preview.getSnapshot);
  useEffect(() => () => { void preview.stop(); }, [preview]);
  const stop = () => {
    void preview.stop();
    setPreviewVoice(undefined);
  };
  const publicIds = new Set(system.map((item) => item.id));
  const custom = catalog?.voices.filter((item) => !publicIds.has(item.id)) ?? [];
  const toOption = (item: SpeechVoice) => ({
    value: 'voice:' + item.id,
    label: item.name,
    title: item.id,
  });
  const unknown = voice && !publicIds.has(voice) && !custom.some((item) => item.id === voice);
  const catalogStatus = catalog?.customVoicesUnavailable
    ? t('bots.voiceMode.voicesCustomError')
    : catalog?.truncated
      ? t('bots.voiceMode.voicesTruncated')
      : null;
  const groups = [
    ...(custom.length
      ? [{ label: t('bots.voiceMode.realtime.myVoices'), options: custom.map(toOption) }]
      : []),
    ...(system.length ? [{ label: t('bots.voiceMode.realtime.systemVoices'), options: system.map(toOption) }] : []),
    {
      options: [
        ...(unknown ? [toOption({ id: voice, name: voice })] : []),
        { value: 'manual', label: t('bots.voiceMode.manualVoice') },
      ],
    },
  ];
  return (
    <div className="min-w-0 flex-[2] basis-48 space-y-2">
      <FormField label={t('bots.voiceMode.realtime.callVoice')}>
        {(control) => (
          <div className="flex min-w-0 items-center gap-2">
            <SpeechVoiceMenu
              {...control}
              label={t('bots.voiceMode.realtime.callVoice')}
              groups={groups}
              value={manual ? 'manual' : 'voice:' + voice}
              disabled={disabled}
              className="min-w-0 flex-1"
              previewVoice={previewVoice}
              previewPhase={phase}
              previewDisabled={previewDisabled || disabled}
              onOpenChange={stop}
              onPreview={(id) => {
                if (previewVoice === id && (phase === 'preparing' || phase === 'playing')) {
                  stop();
                } else if (!previewDisabled && !disabled) {
                  setPreviewVoice(id);
                  void preview.start({ ...selection, voice: id }, t('bots.voiceMode.previewText'));
                }
              }}
              onValueChange={(value) => {
                if (value === 'manual') setManualDraft(voice);
                else {
                  setManualDraft(undefined);
                  onSelect(value.slice('voice:'.length));
                }
              }}
            />
            {list && (
              <Button
                variant="secondary"
                size="lg"
                className="w-9 shrink-0 px-0"
                aria-label={t('bots.voiceMode.realtime.refreshMyVoices')}
                title={t('bots.voiceMode.realtime.refreshMyVoices')}
                disabled={disabled}
                loading={loading}
                onClick={() => setRevision((value) => value + 1)}
              >
                <RefreshCw size={15} aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </FormField>
      {manual && (
        <FormField label={t('bots.voiceMode.voiceId')}>
          {(control) => (
            <SettingsTextInput
              {...control}
              value={manualDraft ?? voice}
              disabled={disabled}
              maxLength={128}
              onChange={setManualDraft}
              onBlur={() => {
                const value = manualDraft?.trim();
                if (value && value !== voice) onSelect(value);
                else setManualDraft(voice);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
              }}
            />
          )}
        </FormField>
      )}
      {!loading && catalogStatus && (
        <p role="status" className="text-12 text-[var(--text-secondary)]">
          {catalogStatus}
        </p>
      )}
    </div>
  );
}
