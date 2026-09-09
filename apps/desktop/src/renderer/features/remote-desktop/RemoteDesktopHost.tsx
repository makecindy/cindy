import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DesktopLocalState } from '../../../shared/remoteDesktop';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { RemoteDesktopPermissions } from '@/components/settings/RemoteDesktopPermissions';

/** Main-window status and permission UI; it has no capture or media bridge. */
export function RemoteDesktopHost() {
  const { t } = useTranslation();
  const [state, setState] = useState<DesktopLocalState | null>(null);
  const stateRevision = useRef(0);
  const dismissing = useRef(false);
  useEffect(() => {
    const api = window.electronAPI?.remoteDesktop;
    if (!api) return;
    let disposed = false;
    let readingState = false;
    const refresh = () => {
      if (readingState || dismissing.current) return;
      readingState = true;
      const revision = stateRevision.current;
      void api
        .state()
        .then((next) => {
          if (!disposed && revision === stateRevision.current) setState(next);
        })
        .catch(() => {})
        .finally(() => {
          readingState = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  if (!state) return null;
  return (
    <>
      <ConfirmDialog
        open={Boolean(state.permissionGuide)}
        onOpenChange={(open) => {
          if (!open) {
            stateRevision.current++;
            dismissing.current = true;
            setState((previous) => (previous ? { ...previous, permissionGuide: false } : previous));
            void window.electronAPI.remoteDesktop
              .dismissPermissionGuide()
              .catch(() => {})
              .finally(() => {
                dismissing.current = false;
              });
          }
        }}
        title={t('remoteDesktop.permissionsTitle')}
        describeContent
        content={state.permissionGuide ? <RemoteDesktopPermissions /> : null}
        confirmText={t('remoteDesktop.closePermissionGuide')}
        showCancel={false}
        maxWidth={460}
      />
      {state.active && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[var(--border-default)] bg-[var(--settings-theme-card-bg)] px-4 py-2 text-13 text-[var(--text-primary)]"
        >
          <span>
            {t(
              state.active.controlling
                ? 'remoteDesktop.beingControlled'
                : 'remoteDesktop.beingViewed',
            )}
          </span>
          <button
            className="min-h-11 rounded-full px-3 font-medium hover:bg-sidebar-item-hover"
            onClick={() => void window.electronAPI.remoteDesktop.stop()}
          >
            {t('remoteDesktop.disconnect')}
          </button>
        </div>
      )}
    </>
  );
}
