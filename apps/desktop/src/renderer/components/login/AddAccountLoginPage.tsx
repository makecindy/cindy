import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import { LoginPage } from './LoginPage';

interface AddAccountLocationState {
  returnTo?: string;
}

export function AddAccountLoginPage() {
  const { loginState, beginAddAccount, cancelAddAccount } = useAuth();
  const { reportLocalDbGate } = useAppShellCover();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const initializedRef = useRef(false);
  const flowFinishedRef = useRef(false);
  const closeStartedRef = useRef(false);
  const returnTo = (location.state as AddAccountLocationState | null)?.returnTo ?? '/cc-agent';

  useEffect(() => {
    // This protected route intentionally sits outside LocalDbGate: adding another account must
    // remain available even if the current account's database cannot open. After a renderer
    // reload/HMR, AppShellCoverProvider starts at `pending`; without an explicit bypass no gate is
    // mounted to release the startup cover, leaving this page behind “Waking Cindy…” forever.
    // Passive effect ordering matters here: LocalDbGate's unmount cleanup runs before this mount
    // effect, so `ready` wins when navigating from the main app into this route.
    reportLocalDbGate('ready');
    return () => reportLocalDbGate('pending');
  }, [reportLocalDbGate]);

  useEffect(() => {
    if (loginState || initializedRef.current) return;
    initializedRef.current = true;
    void beginAddAccount().catch(() => {
      toast.error(t('sidebar.accountSwitcher.startFailed'));
      navigate(returnTo, { replace: true });
    });
  }, [beginAddAccount, loginState, navigate, returnTo, t]);

  useEffect(() => {
    if (loginState?.step !== 'completed') return;
    flowFinishedRef.current = true;
    navigate(returnTo, { replace: true });
  }, [loginState?.step, navigate, returnTo]);

  useEffect(
    () => () => {
      // Browser history and parent navigation can remove this route without
      // invoking LoginPage's close action. Invalidate the add-account epoch so
      // a late verification or account-selection response cannot switch users.
      if (flowFinishedRef.current || closeStartedRef.current) return;
      void cancelAddAccount();
    },
    [cancelAddAccount],
  );

  const cancel = async () => {
    closeStartedRef.current = true;
    try {
      await cancelAddAccount();
    } finally {
      navigate(returnTo, { replace: true });
    }
  };

  return <LoginPage intent="add-account" onClose={() => void cancel()} />;
}
