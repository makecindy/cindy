import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WindowsDesktopSupport } from '../../../shared/remoteDesktop';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { extractIpcError } from '../../utils/ipcError';
import { RemoteDesktopPermissions } from './RemoteDesktopPermissions';

/** The failed setup step the helper reported, such as `service-create 5`. */
const SETUP_DETAIL = /^[a-z-]+(?:\/[a-z-]+)? -?\d+$/;

export function RemoteDesktopSetting() {
  const { t } = useTranslation();
  const [windowsSupport, setWindowsSupport] = useState<WindowsDesktopSupport>();
  const [serviceError, setServiceError] = useState(false);
  const [serviceErrorDetail, setServiceErrorDetail] = useState<string>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const changing = useRef(false);
  const refreshStatus = useRef<() => void>(undefined);
  const isWindows = window.electronAPI?.platform === 'win32';
  useEffect(() => {
    const api = window.electronAPI?.remoteDesktop;
    if (!api) return;
    let reading: number | undefined;
    const refresh = () => {
      const current = revision.current;
      if (reading === current || changing.current) return;
      reading = current;
      void api
        .state(true)
        .then((state) => {
          if (current === revision.current) {
            setEnabled(state.enabled);
            setWindowsSupport(state.windowsSupport);
          }
        })
        .catch(() => {
          if (current === revision.current) setError(true);
        })
        .finally(() => {
          if (reading === current) reading = undefined;
        });
    };
    refreshStatus.current = refresh;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      revision.current++;
      refreshStatus.current = undefined;
      clearInterval(timer);
    };
  }, []);
  if (!window.electronAPI?.remoteDesktop) return null;
  return (
    <section
      aria-label={t('remoteDesktop.allow')}
      className="flex flex-col gap-3 rounded-lg bg-[var(--settings-input-bg)] p-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('remoteDesktop.allow')}
          </p>
          <p className="text-12 text-[var(--text-tertiary)]">{t('remoteDesktop.allowHint')}</p>
          {error && (
            <p role="alert" className="text-12 text-[var(--text-primary)]">
              {t('remoteDesktop.permissionHint')}
            </p>
          )}
        </div>
        <Switch
          aria-label={t('remoteDesktop.allow')}
          disabled={busy}
          checked={enabled}
          onCheckedChange={(next) => {
            const current = ++revision.current;
            changing.current = true;
            setBusy(true);
            setError(false);
            void window.electronAPI.remoteDesktop
              .enable(next)
              .finally(() => {
                changing.current = false;
                setBusy(false);
              })
              .then(() => {
                if (revision.current !== current) return;
                setEnabled(next);
                if (!next) setWindowsSupport(undefined);
                else if (isWindows) refreshStatus.current?.();
              })
              .catch(() => setError(true));
          }}
        />
      </div>
      {enabled && windowsSupport && (
        <div className="flex items-center justify-between gap-4 border-t border-[var(--border-default)] pt-3">
          <div className="flex flex-col gap-1">
            <p className="text-13 font-medium text-[var(--text-primary)]">
              {t('remoteDesktop.windowsTitle')}
            </p>
            <p className="text-12 text-[var(--text-tertiary)]">
              {t(`remoteDesktop.windows${windowsSupport}`)}
            </p>
            {serviceError && (
              <p role="alert" className="text-12 text-[var(--text-primary)]">
                {t('remoteDesktop.windowsError')}
                {serviceErrorDetail && (
                  <span className="text-[var(--text-tertiary)]">
                    {' '}
                    {t('remoteDesktop.windowsErrorDetail', { code: serviceErrorDetail })}
                  </span>
                )}
              </p>
            )}
          </div>
          <Button
            disabled={
              busy || windowsSupport === 'installRequired' || windowsSupport === 'unavailable'
            }
            onClick={() => {
              const current = ++revision.current;
              changing.current = true;
              setBusy(true);
              setServiceError(false);
              setServiceErrorDetail(undefined);
              void window.electronAPI.remoteDesktop
                .windowsSupport(windowsSupport !== 'ready')
                .then(async () => {
                  if (revision.current !== current) return;
                  const state = await window.electronAPI.remoteDesktop.state(true);
                  if (revision.current === current) setWindowsSupport(state.windowsSupport);
                })
                .catch((err: unknown) => {
                  const message = extractIpcError(err)?.message;
                  setServiceErrorDetail(
                    message && SETUP_DETAIL.test(message) ? message : undefined,
                  );
                  setServiceError(true);
                })
                .finally(() => {
                  changing.current = false;
                  setBusy(false);
                });
            }}
          >
            {t(
              windowsSupport === 'ready'
                ? 'remoteDesktop.windowsDisable'
                : 'remoteDesktop.windowsEnable',
            )}
          </Button>
        </div>
      )}
      {enabled && !isWindows && !windowsSupport && <RemoteDesktopPermissions />}
    </section>
  );
}
