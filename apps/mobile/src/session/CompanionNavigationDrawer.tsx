import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { AccountSwitcherSheet } from './AccountSwitcherSheet';
import { HomeChromeDrawer } from './HomeChromeDrawer';
import { remoteSessionStore } from './remoteSessionStore';
import { useTeammateNavigation } from './useTeammateNavigation';

/** Reuse the home drawer and account boundary without walking back through earlier chats. */
export function CompanionNavigationDrawer({ open, onClose, onSearch }: { open: boolean; onClose(): void; onSearch(): void }) {
  const auth = useAuth();
  const { t } = useTranslation();
  const navigation = useTeammateNavigation();
  const push = useGuardedPush();
  const [accounts, setAccounts] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const current = useRef<number | null>(auth.accountGeneration); current.current = auth.accountGeneration;
  useEffect(() => () => { current.current = null; pending.current = null; }, []);
  const hasRunningTasks = useSyncExternalStore(
    useCallback(listener => accounts ? remoteSessionStore.subscribe(listener) : () => {}, [accounts]),
    useCallback(() => accounts && remoteSessionStore.getSessions().some(session => remoteSessionStore.isSessionRunning(session.id)), [accounts]),
  );
  const afterClose = (action: () => void) => { const owner = auth.accountGeneration; pending.current = () => { if (current.current === owner) action(); }; onClose(); };
  const finish = () => { const action = pending.current; pending.current = null; action?.(); };
  return <>
    <HomeChromeDrawer open={open} user={auth.user} loggingOut={loggingOut} mode="teammates"
      onClose={() => { pending.current = null; onClose(); }} onClosed={finish}
      onModeChange={mode => afterClose(() => { if (mode !== 'teammates') void navigation.chooseMode(mode); })}
      onOpenSearch={() => afterClose(onSearch)} onOpenDevices={() => afterClose(() => push('/devices/manage'))}
      onOpenSettings={() => afterClose(() => push('/settings'))} onOpenAccounts={() => afterClose(() => setAccounts(true))}
      onLogout={() => {
        if (loggingOut) return;
        setLoggingOut(true); const owner = auth.accountGeneration;
        void auth.logout().catch(cause => { if (current.current === owner) Alert.alert(t('devices.list.alert.actionFailed'), formatRemoteError(cause)); })
          .finally(() => { if (current.current === owner) setLoggingOut(false); });
      }} />
    <AccountSwitcherSheet visible={accounts} hasRunningTasks={hasRunningTasks} onClose={() => { pending.current = null; setAccounts(false); }} onClosed={finish}
      onAddAccount={() => { const owner = auth.accountGeneration; pending.current = () => { if (current.current === owner) { void auth.beginAddAccount(); push('/add-account'); } }; setAccounts(false); }} />
  </>;
}
