import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { CompanionSheet } from './CompanionSheet';
import { TeammateList } from './TeammateList';
import { useTeammateRoster } from './useTeammateRoster';
import type { LastTeammateIdentity } from './homeViewPreferenceStore';
import { sameTeammate, teammateIdentity } from './teammateNavigation';

/** Name-pill picker. onSelect fires after the shared sheet has dismissed, not through a second Modal. */
export function TeammatePicker({ visible, onClose, onSelect, onCreate, current }: {
  visible: boolean;
  onClose(): void;
  onCreate?(): void;
  onSelect(item: HostedRemoteCollectionItem): void;
  current?: LastTeammateIdentity | null;
}) {
  const { t } = useTranslation();
  const { accountGeneration } = useAuth();
  const currentAccount = useRef(accountGeneration); currentAccount.current = accountGeneration;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  const pending = useRef<{ account: number; item?: HostedRemoteCollectionItem } | null>(null);
  const roster = useTeammateRoster(visible);
  useEffect(() => { if (visible) { pending.current = null; } }, [visible, accountGeneration]);
  const close = () => { pending.current = null; onClose(); };
  return <CompanionSheet visible={visible} onClose={close} title={t('devices.companions.title')} testID="teammates.picker"
    onClosed={() => { const selected = pending.current; pending.current = null;
      if (mounted.current && selected?.account === currentAccount.current) { if (selected.item) onSelect(selected.item); else onCreate?.(); } }}>
      {onCreate && roster.createTargets.some(host => !current || host.deviceId === current.deviceId) ? <MainWindowActionButton action={{ label: t('devices.companionProfile.create'), onPress: () => {
        pending.current = { account: accountGeneration }; onClose();
      } }} /> : null}
      <TeammateList {...roster} embedded current={current} onRefresh={() => void roster.refresh()}
        onSelect={(item) => {
          // Selecting the current identity only dismisses the picker; do not put a second
          // instance of the same chat over its unsent composer draft.
          if (sameTeammate(current ?? null, teammateIdentity(item))) { close(); return; }
          pending.current = { account: accountGeneration, item }; onClose();
        }} />
  </CompanionSheet>;
}
