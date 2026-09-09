import { useEffect, useState, type CSSProperties } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
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
    <div
      className={cn(
        'mx-auto flex select-none items-start gap-2 rounded-md px-3 py-2',
        'border bg-[var(--error-bg)] border-[var(--error-border)]',
        className,
      )}
      style={style}
      data-testid="unread-failed-schedule-banner"
      data-banner-kind="unread-failed-schedule"
    >
      <AlertCircle size={14} className="shrink-0 mt-[2px] text-[var(--error-fg)]" />
      <span className="flex-1 min-w-0 text-xs break-all text-[var(--error-fg)]">
        {t('chat.unreadFailedScheduleBanner.text')}
      </span>
      <Tip text={t('chat.unreadFailedScheduleBanner.dismissTitle')}>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('chat.unreadFailedScheduleBanner.dismissTitle')}
          className="shrink-0 rounded-full p-0.5 text-[var(--error-fg)] hover:bg-[var(--button-primary-hover)] active:bg-[var(--button-primary-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}
