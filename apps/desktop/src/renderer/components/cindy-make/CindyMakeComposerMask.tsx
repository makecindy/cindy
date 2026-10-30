import { LockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import type { CindyMakeComposerPhase } from '@/lib/cindyMakeComposer';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor';
import { CindyMakeTaskCard } from './CindyMakeTaskCard';

/** Preparation lives in the composer; interaction prompts keep their existing priority. */
export function CindyMakeComposerMask({
  phase,
  report,
  request,
  readOnly = false,
}: {
  phase: CindyMakeComposerPhase;
  report?: MakeDoctorReport;
  request?: string;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  if (report?.task) {
    return (
      <CindyMakeTaskCard
        key={report.runId}
        report={report}
        request={request}
        readOnly={readOnly}
        variant="composer"
      />
    );
  }
  const stopped = phase === 'failed' || phase === 'cancelled';
  const heading =
    phase === 'failed'
      ? 'cindyMake.code.preparationFailed'
      : phase === 'cancelled'
        ? 'cindyMake.prepare.cancelled'
        : 'cindyMake.code.phases.' + phase;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[90px] w-full items-center justify-between gap-3 rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--sidebar-item-hover))] text-[var(--workingdir-icon)]">
          {stopped ? <LockKeyhole size={16} aria-hidden /> : <Spinner size={16} />}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-14 font-medium leading-tight text-[var(--msg-assistant-text)]">
            {t(heading)}
          </p>
          <p className="text-12 leading-snug text-[var(--workingdir-text)]">
            {t(stopped ? 'cindyMake.code.inputLocked.retry' : 'cindyMake.code.inputLocked.hint')}
          </p>
        </div>
      </div>
    </div>
  );
}
