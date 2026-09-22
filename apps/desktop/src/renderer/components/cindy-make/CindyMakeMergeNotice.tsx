import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { useCindyMakeMergeResolution } from './useCindyMakeMergeResolution';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import { CindyMakeMergeTaskLink } from './CindyMakeMergeTaskLink';

function ResolveMergeButton({
  state,
  disabled,
}: {
  state: CindyMakeMergeState;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { resolveMerge, busy } = useCindyMakeMergeResolution();
  const cancelling = state.cancellationRequested || state.error === 'cancelFailed';
  return (
    <Tip
      text={t(cancelling ? 'cindyMake.merge.errors.cancelFailed' : 'cindyMake.merge.resolveHint')}
    >
      <Button
        variant="secondary"
        disabled={busy || disabled}
        onClick={() => void resolveMerge(state)}
      >
        {busy && <Spinner size={14} />}
        {t(cancelling ? 'cindyMake.merge.retryCancel' : 'cindyMake.merge.resolve')}
      </Button>
    </Tip>
  );
}

/** Source updates keep recovery in the same action slot as their normal update button. */
export function CindyMakeMergeActions({
  state,
  busy,
  children,
}: {
  state?: CindyMakeMergeState;
  busy?: boolean;
  children?: ReactNode;
}) {
  if (!state || state.ownedByAnotherAccount) return children;
  const active = ['fetching', 'merging', 'checking'].includes(state.status);
  const canResolve =
    (!state.sessionId || (state.status === 'failed' && state.error !== 'interrupted')) &&
    !active &&
    (state.hasWorkspace || state.cancellationRequested || state.error === 'cancelFailed') &&
    state.status !== 'merged' &&
    state.status !== 'cancelled';
  if (!state.sessionId && !canResolve) return children;
  return (
    <>
      {state.sessionId && <CindyMakeMergeTaskLink sessionId={state.sessionId} />}
      {canResolve && <ResolveMergeButton state={state} disabled={busy} />}
    </>
  );
}

export function CindyMakeMergeNotice({
  state,
  busy,
  showActions = true,
}: {
  state: CindyMakeMergeState;
  busy?: boolean;
  showActions?: boolean;
}) {
  const { t } = useTranslation();
  const active = ['fetching', 'merging', 'checking'].includes(state.status);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3 text-12">
      <div className="min-w-0 flex-1 space-y-1 text-[var(--text-secondary)]" role="status">
        <p className="flex items-center gap-2">
          {active && <Spinner size={14} />}
          {t(`cindyMake.merge.status.${state.status}`)}
        </p>
        {state.error && (
          <p className="text-[var(--error-fg)]">{t(`cindyMake.merge.errors.${state.error}`)}</p>
        )}
        {state.ownedByAnotherAccount && <p>{t('cindyMake.merge.otherAccount')}</p>}
      </div>
      {showActions && <CindyMakeMergeActions state={state} busy={busy} />}
    </div>
  );
}
