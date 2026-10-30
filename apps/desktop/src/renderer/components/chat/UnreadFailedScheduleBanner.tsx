import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNotice } from '@/components/ui/error-notice';
import type { ErrorDiagnosisSource } from '@/lib/errorDiagnosisPrompt';
import { cn } from '@/lib/utils';
import { scheduleFailureMessageKey } from '@cindy/maker-shared/schedule-model';
import {
  compareFailedScheduleRuns,
  dismissScheduleFailure,
  failedScheduleDismissalPrefix,
  readLatestDismissedScheduleFailure,
  type FailedScheduleRunSnapshot,
} from '@/features/scheduler/lib/failedScheduleDismissal';

interface BannerProps {
  dataOwnerId: string | null;
  sessionId: string;
  latestFailedRun: FailedScheduleRunSnapshot;
  onDiagnose?: (error: ErrorDiagnosisSource) => void;
  className?: string;
  style?: CSSProperties;
}

/** 历史定时失败看过即已读；需要重试或继续的错误仍由各自的操作横幅负责。 */
export function UnreadFailedScheduleBanner(props: BannerProps) {
  return (
    <FailedScheduleNotice
      key={JSON.stringify([props.dataOwnerId, props.sessionId, props.latestFailedRun])}
      {...props}
    />
  );
}

function FailedScheduleNotice({
  dataOwnerId,
  sessionId,
  latestFailedRun,
  onDiagnose,
  className,
  style,
}: BannerProps) {
  const { t } = useTranslation();
  // 关闭是本机 UI 偏好，不修改运行记录或已读回执。
  const prefix = dataOwnerId ? failedScheduleDismissalPrefix(dataOwnerId, sessionId) : null;
  const [dismissedRun, setDismissedRun] = useState(() =>
    readLatestDismissedScheduleFailure(prefix),
  );

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        prefix &&
        (event.key?.startsWith(prefix) || event.key === null) &&
        event.storageArea === localStorage
      ) {
        const stored = readLatestDismissedScheduleFailure(prefix);
        // 回收旧 key 的事件不能撤销本窗口在写失败时的临时关闭；显式 clear 仍重置。
        setDismissedRun((previous) =>
          event.key !== null &&
          previous &&
          (!stored || compareFailedScheduleRuns(previous, stored) > 0)
            ? previous
            : stored,
        );
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [prefix]);

  if (dismissedRun && compareFailedScheduleRuns(dismissedRun, latestFailedRun) >= 0) return null;

  const dismiss = () => {
    try {
      if (prefix) dismissScheduleFailure(prefix, latestFailedRun);
    } catch {
      // 偏好保存失败仍允许关闭当前提示；失败历史和未读记录保持不变。
    }
    setDismissedRun(latestFailedRun);
  };

  return (
    <ErrorNotice
      className={cn('mx-auto', className)}
      style={style}
      data-testid="unread-failed-schedule-banner"
      data-banner-kind="unread-failed-schedule"
      message={t(`chat.unreadFailedScheduleBanner.${scheduleFailureMessageKey(latestFailedRun)}`)}
      details={latestFailedRun.errorMsg}
      onDiagnose={onDiagnose && latestFailedRun.errorMsg ? () => onDiagnose({
        message: t(`chat.unreadFailedScheduleBanner.${scheduleFailureMessageKey(latestFailedRun)}`),
        details: latestFailedRun.errorMsg!,
      }) : undefined}
      onDismiss={dismiss}
      dismissLabel={t('chat.unreadFailedScheduleBanner.dismissTitle')}
    />
  );
}
