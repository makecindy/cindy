import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, AudioLines } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsTextInput } from './SettingsTextInput';

export interface SpeechModelChoice {
  id: string;
  name: string;
  checked: boolean;
  recommended: boolean;
  reference?: boolean;
  saved?: boolean;
  manual?: boolean;
}

/** Shared by new connections and additions to one existing API-key connection. */
export function SpeechModelChoices({
  choices,
  onToggle,
  onAdd,
  sessionConfirmed = false,
  loading = false,
  mode = 'audio_speech',
}: {
  choices: SpeechModelChoice[];
  onToggle: (id: string) => void;
  onAdd?: (id: string) => void;
  sessionConfirmed?: boolean;
  loading?: boolean;
  mode?: 'audio_speech' | 'realtime';
}) {
  const { t } = useTranslation();
  const title = t(mode === 'realtime' ? 'bots.voiceMode.realtime.title' : 'settings.providers.speechSetup.title');
  const [expanded, setExpanded] = useState(false);
  const [manual, setManual] = useState(false);
  const [id, setId] = useState('');
  const visible = expanded
    ? choices
    : choices.filter((choice, index) => index < 2 || choice.checked);
  const hidden = choices.length - visible.length;
  const add = () => {
    if (!onAdd || loading || !id.trim()) return;
    onAdd(id.trim());
    setId('');
  };
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
        <AudioLines size={16} aria-hidden="true" />
        {title}
      </div>
      {!sessionConfirmed && <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(
          choices.some((choice) => choice.reference)
            ? 'settings.providers.speechSetup.referenceHint'
            : choices.some((choice) => !choice.manual && !choice.saved)
              ? 'settings.providers.speechSetup.discoveryHint'
              : 'settings.providers.speechSetup.manualHint',
        )}
      </p>}
      {choices.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
          {visible.map((choice) => (
            <label
              key={choice.id}
              className={`flex min-h-11 w-full items-center gap-3 border-b border-[var(--border-default)] px-3.5 py-3 text-left last:border-b-0 ${loading || choice.saved ? 'opacity-60' : 'cursor-pointer hover:bg-[var(--settings-menu-bg-hover)]'}`}
            >
              <Checkbox
                data-settings-search-action="Choose whether this discovered speech model is added to the provider"
                checked={choice.checked || choice.saved === true}
                disabled={loading || choice.saved}
                onChange={() => onToggle(choice.id)}
                className="disabled:opacity-100"
              />
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-13 text-[var(--text-primary)]"
                  title={choice.name}
                >
                  {choice.name}
                </span>
                <span
                  className="block truncate text-11 text-[var(--text-tertiary)]"
                  title={choice.id}
                >
                  {choice.id}
                </span>
              </span>
              <span className="shrink-0 text-11 text-[var(--text-secondary)]">
                {choice.saved
                  ? t('settings.providers.speechSetup.saved')
                  : choice.recommended
                    ? t('settings.providers.wizard.recommended')
                    : choice.reference
                      ? t('settings.providers.speechSetup.reference')
                      : choice.manual
                        ? t('settings.providers.speechSetup.manualSource')
                        : t(sessionConfirmed ? 'settings.providers.speechSetup.realtimeConfirmed' : 'settings.providers.speechSetup.discovered')}
              </span>
            </label>
          ))}
        </div>
      )}
      {(onAdd || hidden > 0) && <div className="flex flex-wrap items-center justify-between gap-2">
        {hidden > 0 && (
          <Button variant="secondary" tone="quiet" onClick={() => setExpanded(true)}>
            {t('settings.providers.speechSetup.more', { count: hidden })}
          </Button>
        )}
        {onAdd && <Button
          variant="secondary"
          tone="quiet"
          onClick={() => setManual((value) => !value)}
          disabled={loading}
        >
          <Plus size={14} aria-hidden="true" />
          {t(mode === 'realtime' ? 'bots.voiceMode.realtime.add' : 'settings.providers.speechSetup.manual')}
        </Button>}
      </div>}
      {onAdd && manual && (
        <div className="flex items-center gap-2">
          <SettingsTextInput
            aria-label={t('settings.providers.speechSetup.modelId')}
            placeholder={t('settings.providers.speechSetup.modelId')}
            value={id}
            disabled={loading}
            onChange={setId}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button variant="secondary" disabled={!id.trim() || loading} onClick={add}>
            {t('settings.providers.wizard.addManualModel')}
          </Button>
        </div>
      )}
      {mode === 'audio_speech' && (
        <p className="text-11 leading-relaxed text-[var(--text-tertiary)]">
          {t('settings.providers.speechSetup.modelsHint')}
        </p>
      )}
    </section>
  );
}
