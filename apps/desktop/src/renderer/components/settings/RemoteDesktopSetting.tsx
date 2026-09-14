import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WindowsDesktopSupport } from '../../../shared/remoteDesktop';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RemoteDesktopPermissions } from './RemoteDesktopPermissions';

export function RemoteDesktopSetting() {
  const { t } = useTranslation();
  const [windowsSupport, setWindowsSupport] = useState<WindowsDesktopSupport>();
  const [serviceError, setServiceError] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const changing = useRef(false);
  useEffect(() => {
    const api = window.electronAPI?.remoteDesktop;
    if (!api) return;
    let active = true;
    let reading = false;
    const refresh = () => {
      if (reading || changing.current) return;
      reading = true;
      const current = revision.current;
      void api
        .state(true)
        .then((state) => {
          if (active && current === revision.current) {
            setEnabled(state.enabled);
            setWindowsSupport(state.windowsSupport);
          }
        })
        .catch(() => {
          if (active) setError(true);
        })
        .finally(() => {
          reading = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
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
            revision.current++;
            changing.current = true;
            setBusy(true);
            setError(false);
            void window.electronAPI.remoteDesktop
              .enable(next)
              .then(() => setEnabled(next))
              .catch(() => setError(true))
              .finally(() => {
                changing.current = false;
                setBusy(false);
              });
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
              </p>
            )}
          </div>
          <Button
            disabled={
              busy || windowsSupport === 'installRequired' || windowsSupport === 'unavailable'
            }
            onClick={() => {
              revision.current++;
              changing.current = true;
              setBusy(true);
              setServiceError(false);
              void window.electronAPI.remoteDesktop
                .windowsSupport(windowsSupport !== 'ready')
                .then(() => window.electronAPI.remoteDesktop.state(true))
                .then((state) => setWindowsSupport(state.windowsSupport))
                .catch(() => setServiceError(true))
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
      {enabled && !windowsSupport && <RemoteDesktopPermissions />}
    </section>
  );
}
