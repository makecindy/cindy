import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useLocalNetworkAccess } from '@/hooks/useLocalNetworkAccess';
import { ComputerPermissionRow } from './ComputerPermissionRow';
import { remoteControlSettings } from './RemoteControlSection.settings-search';

/**
 * macOS Local Network permission on the This device card. Hidden where it does
 * not apply or cannot be determined (no LAN, other platforms).
 */
export function LocalNetworkPermission() {
  const { t } = useTranslation();
  const {
    state,
    requesting,
    prompted,
    openedSettings,
    separateWindowRetry,
    appBundlePath,
    failed,
    request,
    openSettings,
    revealApp,
  } = useLocalNetworkAccess({ poll: true });
  if (!state || (state.access !== 'granted' && state.access !== 'denied')) return null;
  const granted = state.access === 'granted';
  const appName = appBundlePath?.split('/').pop();

  const actionLabel = requesting
    ? t('remoteDesktop.permissionChecking')
    : granted
      ? t('remoteDesktop.permissionGranted')
      : separateWindowRetry
        ? t('remoteDesktop.openPermissionInNewWindow')
        : openedSettings || prompted
          ? t('remoteDesktop.openPermissionSettings')
          : t('sidebar.localNetwork.allow');

  const hintText = openedSettings
    ? t('settings.devices.localNetwork.settingsHint')
    : prompted
      ? t('settings.devices.localNetwork.promptedHint')
      : t('settings.devices.localNetwork.deniedHint');

  return (
    <div
      data-setting-id={remoteControlSettings.localNetwork.id}
      className="mt-3 flex flex-col gap-1 border-t border-[var(--border-default)] pt-3"
    >
      <ComputerPermissionRow
        compact
        label={t('settings.devices.localNetwork.label')}
        icon={<Network size={14} strokeWidth={2} />}
        granted={granted}
        pending={requesting}
        actionLabel={actionLabel}
        onAction={() => {
          if (granted) return;
          void (openedSettings || prompted ? openSettings() : request());
        }}
      />
      {!granted && (
        <p role="status" className="text-12 text-[var(--settings-section-desc)]">
          {hintText}
        </p>
      )}
      {!granted && openedSettings && appBundlePath && appName && (
        <Button
          variant="secondary"
          size="sm"
          compact
          tone="quiet"
          type="button"
          className="max-w-full self-start"
          data-settings-search-action="Reveals the running Cindy application in Finder"
          title={appBundlePath}
          onClick={() => void revealApp()}
        >
          <span className="truncate">{t('remoteDesktop.revealCurrentApp', { app: appName })}</span>
        </Button>
      )}
      {failed && (
        <p role="alert" className="text-12 text-[var(--settings-section-desc)]">
          {t('remoteDesktop.permissionActionFailed')}
        </p>
      )}
    </div>
  );
}
