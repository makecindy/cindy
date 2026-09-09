import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { MakeDoctorReportCard } from '@/components/chat/CindyMakeDoctorCard';
import { cancelMakeDoctor, startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { useCindyMakeSettings } from '@/lib/cindyMakeSettings';
import { toast } from '@/lib/toast';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor';

export function CindyMakeSection() {
  const { t } = useTranslation();
  const { forceManagedTools, setForceManagedTools } = useCindyMakeSettings();
  const [report, setReport] = useState<MakeDoctorReport>();
  const [checkVersion, setCheckVersion] = useState(0);
  const [runMode, setRunMode] = useState<'check' | 'prepare'>('check');
  const [runVersion, setRunVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    startMakeDoctor(
      setReport,
      undefined,
      runMode === 'prepare' ? 'cindy-make' : 'cindy-make-doctor',
      {
        forceManagedTools,
        signal: controller.signal,
      },
    );
    return () => controller.abort();
  }, [forceManagedTools, checkVersion, runMode, runVersion]);

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <h2 className="flex items-center gap-2 text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          <Wrench size={17} aria-hidden="true" />
          {t('settings.cindyMake.title')}
        </h2>
        <p className="mt-2 text-13 leading-[1.45] text-[var(--settings-section-desc)]">
          {t('settings.cindyMake.description')}
        </p>
      </div>

      {import.meta.env.DEV && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.cindyMake.forceManaged.title')}
              </p>
              <p className="mt-1 text-12 leading-[1.45] text-[var(--settings-section-desc)]">
                {t('settings.cindyMake.forceManaged.description')}
              </p>
            </div>
            <Switch
              checked={forceManagedTools}
              onCheckedChange={(checked) => {
                // Toggling the developer switch is a diagnostic recheck. Never
                // let it restart an in-progress preparation run implicitly.
                setRunMode('check');
                setForceManagedTools(checked);
              }}
              aria-label={t('settings.cindyMake.forceManaged.ariaLabel')}
            />
          </div>
          {forceManagedTools ? (
            <div className="space-y-2">
              <p className="text-12 leading-[1.45] text-[var(--settings-section-desc)]">
                {t('settings.cindyMake.forceManaged.enabledHint')}
              </p>
            </div>
          ) : null}
        </div>
      )}

      {report ? (
        <MakeDoctorReportCard
          report={report}
          alwaysAllowRecheck
          onPrepare={() => {
            setRunMode('prepare');
            setRunVersion((version) => version + 1);
          }}
          onOpenToolsDir={() => {
            void window.electronAPI
              .openCindyMakeToolsDir()
              .then((result) => {
                if (!result.success) toast.error(t('cindyMakeDoctor.failed'));
              })
              .catch(() => toast.error(t('cindyMakeDoctor.failed')));
          }}
          onStop={() => {
            void cancelMakeDoctor(report.runId, report.mode).catch(() =>
              toast.error(t('cindyMakeDoctor.failed')),
            );
          }}
          onRecheck={() => {
            setRunMode('check');
            setCheckVersion((version) => version + 1);
          }}
        />
      ) : (
        <div className="flex items-center gap-2 text-13 text-[var(--settings-section-desc)]">
          <Spinner size={15} />
          {t('settings.cindyMake.checking')}
        </div>
      )}
    </div>
  );
}
