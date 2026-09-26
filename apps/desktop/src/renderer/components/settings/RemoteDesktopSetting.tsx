import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DesktopLocalState,
  WindowsDesktopSetupPhase,
  WindowsDesktopSetupState,
  WindowsDesktopSupport,
} from '../../../shared/remoteDesktop';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RemoteDesktopPermissions } from './RemoteDesktopPermissions';
import { extractIpcError } from '@/utils/ipcError';

const phaseCopy: Record<WindowsDesktopSetupPhase, string> = {
  preparing: 'remoteDesktop.windowsPreparing',
  compilingHost: 'remoteDesktop.windowsCompilingHost',
  compilingInput: 'remoteDesktop.windowsCompilingInput',
  authorizing: 'remoteDesktop.windowsAuthorizing',
  verifying: 'remoteDesktop.windowsVerifying',
  removing: 'remoteDesktop.windowsRemoving',
};

export function RemoteDesktopSetting() {
  const { t } = useTranslation();
  const [windowsSupport, setWindowsSupport] = useState<WindowsDesktopSupport>();
  const [serviceError, setServiceError] = useState<'prepare' | 'setup' | null>(null);
  const [windowsDevelopment, setWindowsDevelopment] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupPending, setSetupPending] = useState(false);
  const [setup, setSetup] = useState<WindowsDesktopSetupState>();
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const changing = useRef(false);
  const mounted = useRef(false);
  const setupRevision = useRef(-1);
  const applyState = useCallback((state: DesktopLocalState) => {
    if (!mounted.current) return;
    setEnabled(state.enabled);
    setWindowsSupport(state.windowsSupport);
    setWindowsDevelopment(state.windowsDevelopment === true);
    if (state.windowsSetup && state.windowsSetup.revision >= setupRevision.current) {
      setupRevision.current = state.windowsSetup.revision;
      setSetup(state.windowsSetup);
      setServiceError(state.windowsSetup.error);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
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
            applyState(state);
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
      mounted.current = false;
      active = false;
      clearInterval(timer);
    };
  }, [applyState]);
  if (!window.electronAPI?.remoteDesktop) return null;
  const setupBusy = setupPending || !!setup?.phase;
  const setupPhase = setup?.phase ?? (setupPending ? 'preparing' : null);
  const configureSupport = (enabled: boolean) => {
    revision.current++;
    // Setup outlives this settings page. Keep polling its Main-owned
    // phase so leaving/reopening never hides a compiler or UAC wait.
    setSetupPending(true);
    setServiceError(null);
    void window.electronAPI.remoteDesktop
      .windowsSupport(enabled)
      .then(() => window.electronAPI.remoteDesktop.state(true))
      .then(applyState)
      .catch((error) => {
        if (mounted.current)
          setServiceError(
            extractIpcError(error)?.code === 'PRECONDITION_FAILED' ? 'prepare' : 'setup',
          );
      })
      .finally(() => {
        if (mounted.current) {
          setSetupPending(false);
          void window.electronAPI.remoteDesktop
            .state(true)
            .then(applyState)
            .catch(() => {});
        }
      });
  };
  const actionDisabled = busy || setupBusy || windowsSupport === 'installRequired';
  const retryRemoval = serviceError === 'setup' && setup?.failedEnabled === false;
  const failedUpdate =
    serviceError === 'setup' &&
    setup?.failedEnabled === true &&
    windowsSupport === 'missing';
  const showRemove =
    !setupBusy &&
    (windowsSupport === 'updateRequired' ||
      windowsSupport === 'unavailable' ||
      retryRemoval ||
      failedUpdate);
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
          disabled={busy || setupBusy}
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
              {t(
                setupPhase
                  ? phaseCopy[setupPhase]
                  : windowsDevelopment && windowsSupport === 'missing'
                    ? 'remoteDesktop.windowsDevelopmentMissing'
                    : `remoteDesktop.windows${windowsSupport}`,
              )}
            </p>
            {windowsDevelopment && (
              <p className="text-12 text-[var(--text-tertiary)]">
                {t('remoteDesktop.windowsDevelopmentHint')}
              </p>
            )}
            {serviceError && !setupBusy && (
              <p role="alert" className="text-12 text-[var(--text-primary)]">
                {t(
                  serviceError === 'prepare'
                    ? 'remoteDesktop.windowsPreparationError'
                    : 'remoteDesktop.windowsError',
                )}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {showRemove && (
              <Button
                variant="secondary"
                disabled={actionDisabled}
                onClick={() => configureSupport(false)}
              >
                {t('remoteDesktop.windowsDisable')}
              </Button>
            )}
            <Button
              disabled={actionDisabled}
              onClick={() =>
                configureSupport(retryRemoval ? false : windowsSupport !== 'ready')
              }
            >
              {t(
                setupBusy
                  ? 'remoteDesktop.windowsSettingUp'
                  : windowsSupport === 'ready'
                    ? 'remoteDesktop.windowsDisable'
                    : windowsSupport === 'unavailable' || serviceError
                      ? 'remoteDesktop.windowsRetry'
                      : windowsSupport === 'updateRequired'
                        ? 'remoteDesktop.windowsUpdate'
                        : 'remoteDesktop.windowsEnable',
              )}
            </Button>
          </div>
        </div>
      )}
      {enabled && !windowsSupport && <RemoteDesktopPermissions />}
    </section>
  );
}
