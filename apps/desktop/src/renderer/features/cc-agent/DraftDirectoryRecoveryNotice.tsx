import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { DraftDirectoryRecoveryState } from './draftDirectoryRecovery';

/** Persistent draft-local recovery; picker completion never submits the draft. */
export function DraftDirectoryRecoveryNotice({
  state, onReselect, onCancel, disabled = false, goal = false,
}: {
  state: DraftDirectoryRecoveryState;
  onReselect: () => void;
  onCancel: () => void;
  disabled?: boolean;
  goal?: boolean;
}) {
  const { t } = useTranslation();
  const selecting = state.phase === 'selecting';
  const reason = state.code === 'WRITABLE_DIRECTORY_TARGET_CHANGED'
    ? 'changed'
    : state.code === 'WRITABLE_DIRECTORY_UNAVAILABLE' ? 'unavailable' : 'required';
  const messageKey = state.phase === 'required' ? reason : state.phase === 'ready' && goal ? 'readyGoal' : state.phase;
  return (
    <div className="mt-3 flex w-full flex-col gap-2 text-13 text-[var(--text-secondary)]">
      <p role="status" aria-live="polite" className="break-words [overflow-wrap:anywhere]">
        {t(`ccAgent.draft.directoryRecovery.${messageKey}`, {
          directory: state.context.writableDirs[state.index] ?? '',
          index: state.index + 1,
          count: state.context.writableDirs.length,
        })}
      </p>
      {state.phase !== 'ready' && (
        <div className="flex flex-wrap gap-2">
          <Button size="md" variant="secondary" disabled={selecting || disabled} onClick={onReselect}>
            {t('ccAgent.draft.directoryRecovery.reselect')}
          </Button>
          <Button size="md" variant="secondary" disabled={disabled} onClick={onCancel}>
            {t(selecting ? 'ccAgent.draft.directoryRecovery.cancel' : 'ccAgent.draft.directoryRecovery.edit')}
          </Button>
        </div>
      )}
    </div>
  );
}
