import { useTranslation } from 'react-i18next';

import { DownloadRing } from '@/components/ui/download-meter';
import type { PluginInstallProgressState } from './lib/pluginInstallProgress';

/**
 * The progress shown in place of a plugin's install or update button: the standard ring plus the
 * words only a plugin install has (waiting for the permission confirmation, installed / updated,
 * failed). A failure names its reason where there is room (detail pages, the update-all dialog);
 * a card keeps the short word and offers the reason on hover and to screen readers.
 */
export function PluginInstallRing({
  label,
  progress,
  size,
  explainRetry,
  failure,
  className,
}: {
  /** What is being installed or updated; for screen readers. */
  label: string;
  progress: PluginInstallProgressState;
  size?: 16 | 20 | 24;
  explainRetry?: boolean;
  /** The reason to show when it failed; defaults to the one the runner recorded. */
  failure?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const phase = progress.download.phase;
  const install = progress.intent === 'install';
  const reason = failure ?? progress.failure;
  // Surfaces with room (they pass a failure or explain retries) show the reason itself.
  const showReason = Boolean(failure) || Boolean(explainRetry);
  const failedWord = t(
    install ? 'settings.ghosts.installProgress.installFailed' : 'settings.ghosts.updateAll.statusFailed',
  );
  const status = progress.awaitingConsent
    ? t('settings.ghosts.installProgress.awaitingConsent')
    : phase === 'completed'
      ? t(install ? 'settings.ghosts.market.installed' : 'settings.ghosts.updateAll.statusDone')
      : phase === 'failed'
        ? (showReason && reason ? reason : failedWord)
        : undefined;
  return (
    <DownloadRing
      label={label}
      progress={progress.download}
      size={size}
      status={status}
      explainRetry={explainRetry}
      note={phase === 'failed' && !showReason ? reason : undefined}
      className={className}
    />
  );
}
