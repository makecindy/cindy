import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocalNetworkAccess } from '@/hooks/useLocalNetworkAccess';
import { ComputerPermissionRow } from './ComputerPermissionRow';
import { remoteControlSettings } from './RemoteControlSection.settings-search';

/**
 * macOS Local Network permission on the This device card. Hidden where it does
 * not apply or cannot be determined (no LAN, other platforms).
 */
export function LocalNetworkPermission() {
  const { t } = useTranslation();
  const { state, requesting, openedSettings, failed, request } = useLocalNetworkAccess({ poll: true });
  if (!state || (state.access !== 'granted' && state.access !== 'denied')) return null;
  const granted = state.access === 'granted';
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
        actionLabel={t(
          requesting
            ? 'remoteDesktop.permissionChecking'
            : granted
              ? 'remoteDesktop.permissionGranted'
              : 'remoteDesktop.openPermissionSettings',
        )}
        onAction={() => {
          if (!granted) void request();
        }}
      />
      {!granted && (
        <p role="status" className="text-12 text-[var(--settings-section-desc)]">
          {t(openedSettings ? 'settings.devices.localNetwork.settingsHint' : 'settings.devices.localNetwork.deniedHint')}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-12 text-[var(--settings-section-desc)]">
          {t('remoteDesktop.permissionActionFailed')}
        </p>
      )}
    </div>
  );
}
