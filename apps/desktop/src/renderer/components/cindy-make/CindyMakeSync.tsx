import { useTranslation } from 'react-i18next';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';
import { isSelectableVendor } from '@/lib/agentVendors';
import type { CindyMakeTaskOptions } from '../../../shared/cindyMakeDoctor';
import type { CindyMakeSyncState, CindyMakeSyncWaiting } from '../../../shared/cindyMakeSync';
import { CindyMakeMergeTaskLink } from './CindyMakeMergeTaskLink';

const key = 'cindyMake.sync';

/** A conflict task opened by Sync uses the same Agent preferences as a new Cindy Make task. */
export function cindyMakeSyncTaskOptions(): CindyMakeTaskOptions {
  const draft = getDraft();
  const vendor = isSelectableVendor(draft.vendor) ? draft.vendor : 'cc';
  const prefs = draft.lastByVendor[vendor];
  return {
    agentKind: vendor,
    model: prefs.model,
    effort: prefs.effort,
    providerId: prefs.providerId,
    permissionMode: prefs.permissionMode,
    fastMode: getFastModeForModel(prefs.model),
    planModeEnabled: false,
  };
}

/** What the user reads while Sync waits, from the operation's reason. */
function waitingText(waiting: CindyMakeSyncWaiting): string {
  if (waiting.abandoning) return `${key}.waiting.abandoning`;
  if (waiting.reason === 'working') return `${key}.waiting.working.${waiting.kind}`;
  if (waiting.reason === 'interrupted')
    return `${key}.waiting.interrupted.${waiting.sessionId ? 'task' : 'start'}`;
  return `${key}.waiting.${waiting.reason}`;
}

/**
 * One line under the version summary: what Sync is doing, what it waits for, or
 * how it ended, with the at most few actions that belong to it. Polite live text;
 * the summary keeps the single status region.
 */
export function CindyMakeSyncStatus({
  state,
  onAbandon,
  abandoning = false,
  onAccept,
  accepting = false,
  needsGenerate = false,
  onGenerate,
  generating = false,
  onKeep,
  keeping,
  onResume,
  resuming = false,
}: {
  state?: CindyMakeSyncState;
  /** Give up the operation Sync waits for (asks first). */
  onAbandon?: () => void;
  abandoning?: boolean;
  /** Use a result that lost changes (asks first). */
  onAccept?: () => void;
  accepting?: boolean;
  /** The personal version changed since it was last generated. */
  needsGenerate?: boolean;
  onGenerate?: () => void;
  generating?: boolean;
  /** Keep one side when the two personal versions cannot be combined (asks first). */
  onKeep?: (side: 'github' | 'local') => void;
  keeping?: 'github' | 'local';
  /** Open a task for an operation whose task is not there (the same as Sync). */
  onResume?: () => void;
  resuming?: boolean;
}) {
  const { t } = useTranslation();
  if (state?.running && state.step)
    return (
      <p
        aria-live="polite"
        className="flex items-center gap-2 text-12 text-[var(--text-secondary)]"
      >
        <Spinner size={12} />
        {t(`${key}.step.${state.step}`)}
      </p>
    );
  const waiting = state?.waiting;
  if (waiting)
    return (
      <div className="space-y-2">
        <p
          aria-live="polite"
          className={`flex items-center gap-2 text-12 ${
            ['working', 'input'].includes(waiting.reason) || waiting.abandoning
              ? 'text-[var(--text-secondary)]'
              : 'text-[var(--upgrade-banner-fg)]'
          }`}
        >
          {(waiting.abandoning || waiting.reason === 'working') && <Spinner size={12} />}
          {t(waitingText(waiting), { count: waiting.missing ?? 0 })}
        </p>
        {!waiting.abandoning && waiting.reason !== 'otherAccount' && (
          <div className="flex flex-wrap items-center gap-2">
            {waiting.reason === 'paused' && onResume && (
              <Button variant="secondary" size="md" loading={resuming} onClick={onResume}>
                {t(`${key}.resume`)}
              </Button>
            )}
            {waiting.sessionId && waiting.reason !== 'paused' && (
              <CindyMakeMergeTaskLink sessionId={waiting.sessionId} />
            )}
            {waiting.reason === 'missing' && onAccept && (
              <Button variant="secondary" size="md" loading={accepting} onClick={onAccept}>
                {t(`${key}.accept.action`)}
              </Button>
            )}
            {onAbandon && (
              <Button
                variant="secondary"
                tone="quiet"
                size="md"
                loading={abandoning}
                onClick={onAbandon}
              >
                {t(`${key}.abandon.action`)}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  const done = state?.done;
  const error = state?.error;
  const generate = needsGenerate && onGenerate && (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-[var(--text-secondary)]">{t(`${key}.needsGenerate`)}</p>
      <Button variant="secondary" size="md" loading={generating} onClick={onGenerate}>
        {t('cindyMake.history.generatePersonal')}
      </Button>
    </div>
  );
  if (!done && !error)
    return generate ? (
      <div aria-live="polite" className="text-12">
        {generate}
      </div>
    ) : null;
  return (
    <div aria-live="polite" className="space-y-1 text-12">
      {/* A GitHub problem after a completed local update keeps the result visible above it. */}
      {done && !done.generateFirst && (
        <p className="flex items-center gap-1.5 text-[var(--status-success)]">
          <CircleCheck size={13} aria-hidden />
          {!done.ref
            ? t(`${key}.doneCurrent`)
            : done.ref === 'main'
              ? t(`${key}.doneDevelopment`)
              : t(`${key}.done`, { ref: done.ref })}
        </p>
      )}
      {done?.generateFirst && (
        <p className="text-[var(--upgrade-banner-fg)]">
          {t(`${key}.generateFirst`, { ref: done.generateFirst })}
        </p>
      )}
      {done?.ahead && <p className="text-[var(--upgrade-banner-fg)]">{t(`${key}.ahead`)}</p>}
      {done?.buildFirst && (
        <p className="text-[var(--upgrade-banner-fg)]">{t(`${key}.buildFirst`)}</p>
      )}
      {done?.uploadAfterBuild && !done.buildFirst && (
        <p className="text-[var(--text-secondary)]">{t(`${key}.uploadAfterBuild`)}</p>
      )}
      {done?.held && !done.ahead && (
        <p className="text-[var(--upgrade-banner-fg)]">{t(`${key}.held`, { ref: done.held })}</p>
      )}
      {error && <p className="text-[var(--error-fg)]">{t(`${key}.errors.${error}`)}</p>}
      {onKeep &&
        (error === 'diverged' || (error === 'cancelled' && state?.abandoned === 'combine')) && (
          <div className="space-y-2 pt-1">
            <p className="text-[var(--text-secondary)]">{t(`${key}.keep.hint`)}</p>
            <div className="flex flex-wrap items-center gap-2">
              {(['github', 'local'] as const).map((side) => (
                <Button
                  key={side}
                  variant="secondary"
                  size="md"
                  loading={keeping === side}
                  disabled={!!keeping}
                  onClick={() => onKeep(side)}
                >
                  {t(`${key}.keep.${side}`)}
                </Button>
              ))}
            </div>
          </div>
        )}
      {generate}
    </div>
  );
}
