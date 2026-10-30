import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, AudioLines } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  loading = false,
}: {
  choices: SpeechModelChoice[];
  onToggle: (id: string) => void;
  onAdd: (id: string) => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [manual, setManual] = useState(false);
  const [id, setId] = useState('');
  const visible = expanded
    ? choices
    : choices.filter((choice, index) => index < 2 || choice.checked);
  const hidden = choices.length - visible.length;
  const add = () => {
    if (loading || !id.trim()) return;
    onAdd(id.trim());
    setId('');
  };
  return (
    <section className="flex flex-col gap-3" aria-label={t('settings.providers.speechSetup.title')}>
      <div className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
        <AudioLines size={16} aria-hidden="true" />
        {t('settings.providers.speechSetup.title')}
      </div>
      <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(
          choices.some((choice) => choice.reference)
            ? 'settings.providers.speechSetup.referenceHint'
            : choices.some((choice) => !choice.manual && !choice.saved)
              ? 'settings.providers.speechSetup.discoveryHint'
              : 'settings.providers.speechSetup.manualHint',
        )}
      </p>
      {choices.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
          {visible.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="checkbox"
              aria-checked={choice.checked || choice.saved === true}
              disabled={loading || choice.saved}
              onClick={() => onToggle(choice.id)}
              className="flex min-h-11 w-full items-center gap-3 border-b border-[var(--border-default)] px-3.5 py-3 text-left last:border-b-0 enabled:hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${choice.checked || choice.saved ? 'border-[var(--accent-cta-bg)] bg-[var(--accent-cta-bg)] text-[var(--surface-on-card)]' : 'border-[var(--text-tertiary)]'}`}
              >
                {(choice.checked || choice.saved) && (
                  <Check size={11} strokeWidth={3} aria-hidden="true" />
                )}
              </span>
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
                        : t('settings.providers.speechSetup.discovered')}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {hidden > 0 && (
          <Button variant="secondary" tone="quiet" onClick={() => setExpanded(true)}>
            {t('settings.providers.speechSetup.more', { count: hidden })}
          </Button>
        )}
        <Button
          variant="secondary"
          tone="quiet"
          onClick={() => setManual((value) => !value)}
          disabled={loading}
        >
          <Plus size={14} aria-hidden="true" />
          {t('settings.providers.speechSetup.manual')}
        </Button>
      </div>
      {manual && (
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
      <p className="text-11 leading-relaxed text-[var(--text-tertiary)]">
        {t('settings.providers.speechSetup.modelsHint')}
      </p>
    </section>
  );
}
