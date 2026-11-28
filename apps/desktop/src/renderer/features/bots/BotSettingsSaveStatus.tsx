import { Check } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useBotTranslation } from './botPronounContext';
import type { BotSettingsAutosaveController } from './useBotSettingsAutosave';

/** Shared settings header feedback; only a confirmed receipt becomes saved. */
export function BotSettingsSaveStatus({ autosave, modelPage, sourceTooLong }: {
  autosave: Pick<BotSettingsAutosaveController, 'status' | 'modelSelectionSaved' | 'errorKey' | 'retry'>;
  modelPage: boolean;
  sourceTooLong: boolean;
}) {
  const { t } = useBotTranslation();
  if (autosave.status === 'saving') return (
    <span role="status" className="inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]">
      <Spinner size={12} /> {t('bots.autosave.saving')}
    </span>
  );
  if (autosave.status === 'saved') return (
    <span role="status" className="inline-flex animate-fade-in items-center gap-1 text-11 text-[var(--text-tertiary)]">
      <Check size={12} /> {t(modelPage && autosave.modelSelectionSaved ? 'bots.autosave.savedModel' : 'bots.autosave.saved')}
    </span>
  );
  if (autosave.status === 'error') return (
    <p className="flex items-center gap-2 text-11 text-[var(--text-danger)]" role="alert">
      {t(autosave.errorKey ?? 'bots.profileSaveFailed')}
      {!sourceTooLong && <button type="button" onClick={() => void autosave.retry()}
        className="shrink-0 font-medium text-[var(--text-primary)]">
        {t('bots.autosave.retry')}
      </button>}
    </p>
  );
  return null;
}
