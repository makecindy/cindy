import { usesMacProtectionOverride } from '../../../shared/macControlPermission';
import { Button } from '@/components/ui/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  desktopPermissionReady,
  type DesktopPermission,
} from '@cindy/device-link';
import accessibilityIcon from '@/assets/system-settings/accessibility-icon.png';
import screenRecordingIcon from '@/assets/system-settings/screen-recording-icon.png';
import type { LocalDesktopPermissions } from '../../../shared/remoteDesktop';
import { ComputerPermissionRow } from './ComputerPermissionRow';

/** Compact permission rows backed by the actual remote host. */
export function RemoteDesktopPermissions() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LocalDesktopPermissions | null>(null);
  const [pending, setPending] = useState<DesktopPermission | null>(null);
  const [error, setError] = useState<'check' | 'action' | null>(null);
  const mounted = useRef(false);
  const reading = useRef(false);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const next = await window.electronAPI.remoteDesktop.permissions();
      if (mounted.current) {
        setStatus(next);
        setError((previous) => (previous === 'check' ? null : previous));
      }
    } catch {
      if (mounted.current) setError((previous) => (previous === 'action' ? previous : 'check'));
    } finally {
      reading.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1500);
    window.addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  if (status?.screenRecording === 'notRequired' && status.accessibility === 'notRequired')
    return null;
  const modernPermissions = usesMacProtectionOverride(window.electronAPI.platform, window.electronAPI.osRelease);
  const ready =
    status &&
    desktopPermissionReady(status.screenRecording) &&
    desktopPermissionReady(status.accessibility);
  const open = async (permission: DesktopPermission) => {
    if (pending) return;
    setPending(permission);
    setError(null);
    try {
      await window.electronAPI.remoteDesktop.openPermission(permission);
      if (mounted.current) await refresh();
    } catch {
      if (mounted.current) setError('action');
    } finally {
      if (mounted.current) setPending(null);
    }
  };
  const bundle = status?.appBundlePath;
  return (
    <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
      <p role="status" className="text-12 text-[var(--settings-section-desc)]">
        {t(ready ? 'remoteDesktop.permissionsReady' : 'remoteDesktop.permissionsIntro')}
      </p>
      {(['screenRecording', 'accessibility'] as const).map((permission) => {
        const value = status?.[permission];
        return (
          <div key={permission} className="flex flex-col gap-1">
            <ComputerPermissionRow
              compact
              label={t(modernPermissions && permission === 'accessibility' ? 'macControlPermission.pane' : `remoteDesktop.${permission}`)}
              iconSrc={permission === 'screenRecording' ? screenRecordingIcon : accessibilityIcon}
              granted={value === 'granted'}
              pending={!status || pending !== null}
              actionLabel={t(
                !status
                  ? 'remoteDesktop.permissionChecking'
                  : value === 'granted'
                    ? 'remoteDesktop.permissionGranted'
                    : status.separateWindowRetries?.includes(permission)
                      ? 'remoteDesktop.openPermissionInNewWindow'
                      : 'remoteDesktop.openPermissionSettings',
              )}
              onAction={() => {
                void open(permission);
              }}
            />
            {value !== 'granted' && (
              <p className="whitespace-pre-line text-12 text-[var(--settings-section-desc)]">
                {value === 'unknown' ? `${t('remoteDesktop.permissionUnknown')} · ` : ''}
                {modernPermissions && permission === 'accessibility'
                  // Remote keyboard and mouse are system-wide: macOS 27.3 drops them
                  // unless Cindy may control every app, so never suggest Choose Apps here.
                  ? t(
                      status?.accessibilityChosenAppsOnly
                        ? 'macControlPermission.chosenAppsOnly'
                        : 'macControlPermission.reviewWholeMac',
                      { app: window.electronAPI.macPermissionAppName ?? 'Cindy' },
                    )
                  : t(`remoteDesktop.${permission}Help`)}
              </p>
            )}
          </div>
        );
      })}
      {!ready && bundle && (
        <Button
          variant="secondary"
          size="sm"
          compact
          tone="quiet"
          type="button"
          className="max-w-full self-start"
          data-settings-search-action="Reveals the running Cindy application in Finder"
          title={bundle}
          onClick={async () => {
            try {
              const result = await window.electronAPI.showItemInFolder({ filePath: bundle });
              if (!result.success) setError('action');
            } catch {
              setError('action');
            }
          }}
        >
          <span className="truncate">{t('remoteDesktop.revealCurrentApp', { app: bundle.split('/').pop() })}</span>
        </Button>
      )}
      <Button
        variant="secondary"
        size="sm"
        compact
        tone="quiet"
        type="button"
        className="self-start"
        onClick={() => {
          setError(null);
          void refresh();
        }}
      >
        {t('remoteDesktop.recheckPermissions')}
      </Button>
      {error && (
        <p role="alert" className="text-12 text-[var(--settings-section-desc)]">
          {t(
            error === 'check'
              ? 'remoteDesktop.permissionCheckFailed'
              : 'remoteDesktop.permissionActionFailed',
          )}
        </p>
      )}
    </div>
  );
}
