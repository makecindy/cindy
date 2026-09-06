import { useEffect, useState, type CSSProperties } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

function readDismissedRun(key: string | null): string | null {
  try {
    return key ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

interface BannerProps {
  dataOwnerId: string | null;
  sessionId: string;
  latestFailedRunId: string;
  className?: string;
  style?: CSSProperties;
}

/** 历史定时失败看过即已读；需要重试或继续的错误仍由各自的操作横幅负责。 */
export function UnreadFailedScheduleBanner(props: BannerProps) {
  return (
    <FailedScheduleNotice
      key={JSON.stringify([props.dataOwnerId, props.sessionId, props.latestFailedRunId])}
      {...props}
    />
  );
}

function FailedScheduleNotice({
  dataOwnerId,
  sessionId,
  latestFailedRunId,
  className,
  style,
}: BannerProps) {
  const { t } = useTranslation();
  // 关闭是本机 UI 偏好，不修改运行记录或已读回执。按运行身份记录，
  // 避免另一个窗口关闭旧提示时覆盖新提示的关闭状态。
  const key = dataOwnerId
    ? `scheduleFailureDismissal:${JSON.stringify([dataOwnerId, sessionId, latestFailedRunId])}`
    : null;
  const [dismissedRunId, setDismissedRunId] = useState(() => readDismissedRun(key));

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (key && (event.key === key || event.key === null) && event.storageArea === localStorage) {
        setDismissedRunId(readDismissedRun(key));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  if (dismissedRunId === latestFailedRunId) return null;

  const dismiss = () => {
    try {
      if (key) localStorage.setItem(key, latestFailedRunId);
    } catch {
      // 偏好保存失败仍允许关闭当前提示；失败历史和未读记录保持不变。
    }
    setDismissedRunId(latestFailedRunId);
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
          className="shrink-0 rounded-full p-0.5 text-[var(--error-fg)] hover:bg-[var(--error-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}
