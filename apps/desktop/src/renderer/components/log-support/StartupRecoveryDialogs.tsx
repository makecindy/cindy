import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useLoginHandoff } from '@/contexts/LoginHandoffContext';
import { InterruptedTasksResumeDialog } from '@/features/cc-agent/InterruptedTasksResumeDialog';
import { buildErrorDiagnosisPrompt, prefillErrorDiagnosisDraft } from '@/lib/errorDiagnosisPrompt';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import type { CrashDiagnosisSummary } from '../../../shared/crashDiagnosis';

const log = createLogger('crash-diagnosis');

/** Startup notices are sequential: release notes → interrupted tasks → diagnosis. */
export function StartupRecoveryDialogs({ suspended = false }: { suspended?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { coverHeld, localDbGateStatus } = useAppShellCover();
  const { brandStageMounted } = useLoginHandoff();
  const [pending, setPending] = useState<CrashDiagnosisSummary | null>(null);
  const [resumePending, setResumePending] = useState(true);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const hidden = suspended || coverHeld || brandStageMounted || localDbGateStatus !== 'ready';

  useEffect(() => {
    alive.current = true;
    let active = true;
    void window.electronAPI.getCrashDiagnosis().then((summary) => {
      if (active) setPending(summary);
    }).catch(() => {
      log.warn('Could not check previous exit');
    });
    return () => { active = false; alive.current = false; };
  }, []);

  const dismiss = () => {
    setPending(null);
    void window.electronAPI.dismissCrashDiagnosis().catch(() => {
      log.warn('Could not dismiss previous exit notice');
    });
  };
  const diagnose = async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const evidence = await window.electronAPI.prepareCrashDiagnosis();
      if (!alive.current) return;
      if (!evidence) { dismiss(); return; }
      prefillErrorDiagnosisDraft(buildErrorDiagnosisPrompt(t, null, {
        message: t('crashDiagnosis.title'),
        details: `${evidence.details}\n\n${t('crashDiagnosis.logExcerpt')}\n${evidence.logsUnavailable ? t('crashDiagnosis.logsUnavailable') : evidence.logs}`,
      }));
      dismiss();
      navigate('/cc-agent/new');
    } catch {
      if (alive.current) toast.error(t('crashDiagnosis.failed'));
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  };

  return <>
    <ConfirmDialog
      open={Boolean(pending) && !hidden && !resumePending}
      onOpenChange={(open) => { if (!open && !busy.current) dismiss(); }}
      title={t('crashDiagnosis.title')}
      description={t('crashDiagnosis.description')}
      confirmText={t('crashDiagnosis.diagnose')}
      cancelText={t('crashDiagnosis.later')}
      loading={loading}
      onConfirm={() => { void diagnose(); }}
    />
    <InterruptedTasksResumeDialog suspended={hidden} onPendingChange={setResumePending} />
  </>;
}
