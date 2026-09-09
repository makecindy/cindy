import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  desktopPermissionReady,
  type DesktopPermission,
  type RemoteDesktopPermissions as Permissions,
} from '@cindy/device-link';
import accessibilityIcon from '@/assets/system-settings/accessibility-icon.png';
import screenRecordingIcon from '@/assets/system-settings/screen-recording-icon.png';
import { ComputerPermissionRow } from './ComputerPermissionRow';

/** Compact permission rows backed by the actual remote host. */
export function RemoteDesktopPermissions() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Permissions | null>(null);
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
              label={t(`remoteDesktop.${permission}`)}
              iconSrc={permission === 'screenRecording' ? screenRecordingIcon : accessibilityIcon}
              granted={value === 'granted'}
              pending={!status || pending !== null}
              actionLabel={t(
                !status
                  ? 'remoteDesktop.permissionChecking'
                  : value === 'granted'
                    ? 'remoteDesktop.permissionGranted'
                    : 'remoteDesktop.openPermissionSettings',
              )}
              onAction={() => {
                void open(permission);
              }}
            />
            {value !== 'granted' && (
              <p className="text-12 text-[var(--settings-section-desc)]">
                {value === 'unknown' ? `${t('remoteDesktop.permissionUnknown')} · ` : ''}
                {t(`remoteDesktop.${permission}Help`)}
              </p>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="self-start rounded-full px-2 py-1 text-11 text-[var(--settings-section-title)] hover:bg-[var(--surface-chip)]"
        onClick={() => {
          setError(null);
          void refresh();
        }}
      >
        {t('remoteDesktop.recheckPermissions')}
      </button>
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
