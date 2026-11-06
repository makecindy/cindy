import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import type { ErrorDiagnosisSource } from '@/lib/errorDiagnosisPrompt';
import { cn } from '@/lib/utils';
import {
  scheduleFailureMessageKey,
  type ScheduleMissingPlugin,
} from '@cindy/maker-shared/schedule-model';
import { installedGhostStoragePart, resolvePluginInstanceQuery } from '../../../shared/pluginIdentity';
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
  /** Remote tasks run on another computer; the plugin pages here would act on this one. */
  remote?: boolean;
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
  remote,
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

  const missingPlugin = latestFailedRun.failureKind === 'precheck' ? latestFailedRun.missingPlugin : undefined;
  const message = t(`chat.unreadFailedScheduleBanner.${scheduleFailureMessageKey(latestFailedRun)}`, {
    name: missingPlugin?.name,
  });

  return (
    <ErrorNotice
      className={cn('mx-auto', className)}
      style={style}
      data-testid="unread-failed-schedule-banner"
      data-banner-kind="unread-failed-schedule"
      message={message}
      actions={missingPlugin && !remote ? <MissingPluginAction plugin={missingPlugin} /> : undefined}
      details={latestFailedRun.errorMsg}
      onDiagnose={onDiagnose && latestFailedRun.errorMsg ? () => onDiagnose({
        message,
        details: latestFailedRun.errorMsg!,
      }) : undefined}
      onDismiss={dismiss}
      dismissLabel={t('chat.unreadFailedScheduleBanner.dismissTitle')}
    />
  );
}

/** Opens the plugin where the user can fix it: its installed page, else its market detail. */
function MissingPluginAction({ plugin }: { plugin: ScheduleMissingPlugin }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const resolved = resolvePluginInstanceQuery(readInstalledGhostsSnapshot(), plugin.ghostId, plugin.namespace ?? null);
  const installed = resolved.status === 'unique' ? resolved.ghost : null;
  const open = () => navigate(
    installed ? `/plugins?ghost=${encodeURIComponent(installedGhostStoragePart(installed))}`
      : plugin.pluginId ? `/plugins?market=${encodeURIComponent(plugin.pluginId)}`
        : '/plugins',
  );
  return (
    <Button size="sm" compact type="button" onClick={open}>
      {t(installed ? 'chat.unreadFailedScheduleBanner.openPlugin' : 'chat.unreadFailedScheduleBanner.installPlugin')}
    </Button>
  );
}
