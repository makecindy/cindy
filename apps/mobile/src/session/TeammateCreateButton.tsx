import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { RemoteResourceRef } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome/NativePullDownMenu';
import { useTheme } from '@/theme';
import { iconSize, iconStroke } from '@/theme/tokens';
import { CompanionCreateSheet } from './CompanionProfileSheet';
import { CompanionSheet } from './CompanionSheet';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { TEAMMATE_COLLECTION_ID } from './useTeammateRoster';

export function TeammateCreateButton({ targets, preferredDeviceId, onInteract, onCreated }: {
  targets: readonly RemoteResourceHostTarget[];
  preferredDeviceId?: string;
  onInteract(): void;
  onCreated(host: RemoteResourceHostTarget, ref: RemoteResourceRef): void;
}) {
  const { accountGeneration } = useAuth();
  // Account changes discard both native menu selections and dismissal receipts.
  return <CreateButton key={accountGeneration} {...{ targets, preferredDeviceId, onInteract, onCreated }} account={accountGeneration} />;
}
function CreateButton({ targets, preferredDeviceId, onInteract, onCreated, account }: Parameters<typeof TeammateCreateButton>[0] & { account: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { accountGeneration } = useAuth();
  const currentAccount = useRef(accountGeneration); currentAccount.current = accountGeneration;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [host, setHost] = useState<RemoteResourceHostTarget | null>(null);
  const [visible, setVisible] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const pendingHost = useRef<RemoteResourceHostTarget | null>(null);
  const receipt = useRef<RemoteResourceRef | null>(null);
  const ordered = [...targets].sort((a, b) => Number(b.deviceId === preferredDeviceId) - Number(a.deviceId === preferredDeviceId));
  const select = (id: string) => {
    onInteract();
    const target = targets.find((item) => item.deviceId === id);
    if (!mounted.current || currentAccount.current !== account || !target) return;
    setHost(target); setVisible(true);
  };
  const label = t('devices.companionProfile.create');
  const button = <HomeHeaderGlassButton accessibilityLabel={label} testID="teammates.create"
        onPress={() => {
          onInteract();
          if (!targets.length) Alert.alert(label, t('devices.resources.noHosts'));
          else if (targets.length === 1) select(targets[0].deviceId);
          else if (targets.length > 1 && !usesNativePullDownMenu()) setChoosing(true);
        }}>
        <Plus color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
      </HomeHeaderGlassButton>;
  return <>
    {targets.length > 1 ? <NativePullDownMenu actions={ordered.map((target) => ({ id: target.deviceId, title: target.deviceName }))} onAction={select}>
      {button}
    </NativePullDownMenu> : button}
    <CompanionSheet visible={choosing} title={label} onClose={() => { pendingHost.current = null; setChoosing(false); }}
      onClosed={() => { const target = pendingHost.current; pendingHost.current = null; if (target) select(target.deviceId); }}>
      {ordered.map((target) => <MainWindowActionButton key={target.deviceId} action={{ label: target.deviceName, onPress: () => {
        pendingHost.current = target; setChoosing(false);
      } }} />)}
    </CompanionSheet>
    {host ? <CompanionCreateSheet visible={visible} deviceId={host.deviceId} deviceName={host.deviceName}
      collectionId={TEAMMATE_COLLECTION_ID} online={targets.some((target) => target.deviceId === host.deviceId)}
      onClose={() => setVisible(false)} onCreated={(ref) => { receipt.current = ref; }}
      onClosed={() => {
        const ref = receipt.current; receipt.current = null;
        if (ref && mounted.current && currentAccount.current === account) onCreated(host, ref);
      }} /> : null}
  </>;
}
