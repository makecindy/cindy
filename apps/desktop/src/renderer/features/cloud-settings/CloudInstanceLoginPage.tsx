import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoginPageView } from '@/components/login/LoginPage';
import {
  cloudLoginActionSchema,
  type CloudInstanceLoginView,
} from '../../../shared/cloudInstanceLogin';
import type { DesktopLoginAction } from '../../../shared/authIpc';

import type { CloudLoginApi, CloudLoginWindowState } from '../../../shared/cloudLoginWindow';
import { cloudInstanceName } from './instanceName';

/** Same login UI and actions; scoped to an independent window, never local AuthContext. */
export function CloudInstanceLoginFlow({
  target,
  api,
  onClose,
}: {
  target: NonNullable<CloudLoginWindowState['target']>;
  api: CloudLoginApi;
  onClose(): void;
}) {
  const { deviceId } = target;
  const { t } = useTranslation();
  const [view, setView] = useState<CloudInstanceLoginView | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const handle = useRef<string | null>(null);
  const live = useRef(false);
  const inFlight = useRef(false);
  const name = cloudInstanceName(t, target);
  useEffect(() => {
    live.current = true;
    let disposed = false;
    let ownedHandle: string | null = null;
    void (async () => {
      try {
        const initial = await api.instanceLoginStart({ deviceId });
        ownedHandle = initial.handle;
        if (disposed) {
          await api.instanceLoginClose({ handle: initial.handle });
          return;
        }
        handle.current = initial.handle;
        setView(initial);
      } catch {
        if (!disposed) setErrorCode('AUTH_SERVICE_UNAVAILABLE');
      } finally {
        if (!disposed) setBusy(false);
      }
    })();
    const timer = window.setInterval(() => {
      if (disposed || inFlight.current || !ownedHandle) return;
      inFlight.current = true;
      void api
        .instanceLoginPoll({ handle: ownedHandle })
        .then((next) => {
          if (!disposed) {
            setView(next);
            if (next.errorCode) setErrorCode(next.errorCode);
          }
        })
        .catch(() => {
          if (!disposed) setErrorCode('AUTH_REQUEST_FAILED');
        })
        .finally(() => {
          inFlight.current = false;
        });
    }, 2000);
    return () => {
      disposed = true;
      live.current = false;
      handle.current = null;
      clearInterval(timer);
      if (ownedHandle) void api.instanceLoginClose({ handle: ownedHandle }).catch(() => undefined);
    };
  }, [api, deviceId]);

  const dispatchWithResult = async (action: DesktopLoginAction) => {
    const parsed = cloudLoginActionSchema.safeParse(action);
    if (!parsed.success || !handle.current) return { success: false, code: 'AUTH_REQUEST_FAILED' };
    if (inFlight.current) return { success: false, code: null };
    inFlight.current = true;
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await api.instanceLoginDispatch({
        handle: handle.current,
        action: parsed.data,
      });
      if (!live.current) return { success: false, code: null };
      setView(result);
      setErrorCode(result.errorCode ?? null);
      return { success: !result.errorCode, code: result.errorCode ?? null };
    } catch {
      if (live.current) setErrorCode('AUTH_REQUEST_FAILED');
      return { success: false, code: 'AUTH_REQUEST_FAILED' };
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <LoginPageView
      intent="cloud-instance"
      targetLabel={name}
      captchaChallengeUrl={view?.captchaChallengeUrl}
      onClose={onClose}
      login={{
        isLoading: busy,
        errorCode,
        retryAt: view?.retryAt,
        loginState:
          view?.state ??
          (errorCode ? { step: 'error', code: errorCode, recoverTo: 'identifier' } : null),
        dispatchWithResult,
        dispatch: async (action) => (await dispatchWithResult(action)).success,
        clearError: () => setErrorCode(null),
      }}
    />
  );
}
