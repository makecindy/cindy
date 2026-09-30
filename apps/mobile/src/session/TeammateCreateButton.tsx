import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { RemoteResourceRef } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { NativePullDownMenu, usesNativePullDownMenu, type NativePullDownAction } from '@/platform/chrome/NativePullDownMenu';
import { useTheme } from '@/theme';
import { iconSize, iconStroke } from '@/theme/tokens';
import { BotGroupCreateSheet } from './BotGroupCreateSheet';
import { CompanionCreateSheet } from './CompanionProfileSheet';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { CompanionSettingsRow } from './CompanionSettingsRow';
import { CompanionSheet } from './CompanionSheet';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { TEAMMATE_COLLECTION_ID } from './useTeammateRoster';

type CreateKind = 'bot' | 'group';
type Choice = { kind: CreateKind; host: RemoteResourceHostTarget };

/**
 * 伙伴页顶栏的「+」。支持群聊时是一个菜单：新建伙伴 / 新建群聊（多台电脑时再选电脑）；
 * 旧版电脑不支持群聊时保持原来的直接新建伙伴。表单关闭后才回报创建结果，避免两个 Modal 叠加。
 */
export function TeammateCreateButton({ targets, groupTargets = [], preferredDeviceId, onCreated, onGroupCreated, appearance = 'glass' }: {
  targets: readonly RemoteResourceHostTarget[];
  /** `cta`: the empty list's primary button; it only creates a teammate. */
  appearance?: 'glass' | 'cta';
  /** Online computers that support group chats; empty keeps the single-purpose button. */
  groupTargets?: readonly RemoteResourceHostTarget[];
  preferredDeviceId?: string;
  onCreated(host: RemoteResourceHostTarget, ref: RemoteResourceRef): void;
  onGroupCreated?(host: RemoteResourceHostTarget, groupId: string): void;
}) {
  const { accountGeneration } = useAuth();
  // Account changes discard both native menu selections and dismissal receipts.
  return <CreateButton key={accountGeneration} {...{ targets, groupTargets, preferredDeviceId, onCreated, onGroupCreated, appearance }} account={accountGeneration} />;
}

function CreateButton({ targets, groupTargets = [], preferredDeviceId, onCreated, onGroupCreated, appearance, account }: Parameters<typeof TeammateCreateButton>[0] & { account: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { accountGeneration } = useAuth();
  const currentAccount = useRef(accountGeneration); currentAccount.current = accountGeneration;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState<Choice | null>(null);
  const [visible, setVisible] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const pendingChoice = useRef<Choice | null>(null);
  const receipt = useRef<RemoteResourceRef | null>(null);
  const groupReceipt = useRef<string | null>(null);
  const cta = appearance === 'cta';
  const withGroups = !cta && groupTargets.length > 0 && !!onGroupCreated;
  const order = (hosts: readonly RemoteResourceHostTarget[]) => [...hosts]
    .sort((a, b) => Number(b.deviceId === preferredDeviceId) - Number(a.deviceId === preferredDeviceId));
  const ordered = order(targets);
  const orderedGroups = order(groupTargets);
  const start = (kind: CreateKind, deviceId: string) => {
    const target = (kind === 'bot' ? targets : groupTargets).find((item) => item.deviceId === deviceId);
    if (!mounted.current || currentAccount.current !== account || !target) return;
    setOpen({ kind, host: target }); setVisible(true);
  };
  const botLabel = t(withGroups || cta ? 'devices.companions.createTeammate' : 'devices.companionProfile.create');
  const groupLabel = t('groupChat.create.title');
  const entry = (kind: CreateKind, hosts: readonly RemoteResourceHostTarget[]): NativePullDownAction => ({
    id: hosts.length === 1 ? `${kind}:${hosts[0]!.deviceId}` : kind,
    title: kind === 'bot' ? botLabel : groupLabel,
    image: kind === 'bot' ? 'person.crop.circle.badge.plus' : 'person.2',
    ...(hosts.length > 1 ? { subactions: hosts.map((host) => ({ id: `${kind}:${host.deviceId}`, title: host.deviceName })) } : {}),
  });
  const menuActions: NativePullDownAction[] = withGroups
    ? [...(ordered.length ? [entry('bot', ordered)] : []), entry('group', orderedGroups)]
    : ordered.map((target) => ({ id: target.deviceId, title: target.deviceName }));
  const onMenu = (id: string) => {
    if (!withGroups) { start('bot', id); return; }
    const split = id.indexOf(':');
    if (split > 0) start(id.slice(0, split) as CreateKind, id.slice(split + 1));
  };
  const label = withGroups ? t('devices.companions.createMenu') : botLabel;
  const needsMenu = withGroups || targets.length > 1;
  const press = () => {
    // The empty state names the next step instead of only reporting that nothing is available.
    if (!withGroups && !targets.length) Alert.alert(label, t('devices.companions.noCreateHosts'));
    else if (!needsMenu) start('bot', targets[0]!.deviceId);
    else if (cta || !usesNativePullDownMenu()) setChoosing(true);
  };
  const button = cta
    ? <MainWindowActionButton action={{ label: botLabel, tone: 'primary', onPress: press, testID: 'teammates.emptyCreate' }} />
    : <HomeHeaderGlassButton accessibilityLabel={label} testID="teammates.create" onPress={press}>
      <Plus color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />
    </HomeHeaderGlassButton>;
  const fallbackChoices: Choice[] = [
    ...ordered.map((host) => ({ kind: 'bot' as const, host })),
    ...(withGroups ? orderedGroups.map((host) => ({ kind: 'group' as const, host })) : []),
  ];
  const choiceLabel = (choice: Choice) => {
    if (!withGroups) return choice.host.deviceName;
    const verb = choice.kind === 'bot' ? botLabel : groupLabel;
    return (choice.kind === 'bot' ? ordered : orderedGroups).length > 1 ? `${verb} · ${choice.host.deviceName}` : verb;
  };
  const groupOpen = open?.kind === 'group' ? open : null;
  return <>
    {!cta && needsMenu && menuActions.length ? <NativePullDownMenu actions={menuActions} onAction={onMenu} testID="teammates.createMenu">{button}</NativePullDownMenu> : button}
    <CompanionSheet visible={choosing} title={label} testID="teammates.createChooser" onClose={() => { pendingChoice.current = null; setChoosing(false); }}
      onClosed={() => { const choice = pendingChoice.current; pendingChoice.current = null; if (choice) start(choice.kind, choice.host.deviceId); }}>
      {/* Same choice as the header's native menu: one plain row per choice, not full-width buttons. */}
      {fallbackChoices.map((choice) => <CompanionSettingsRow key={`${choice.kind}:${choice.host.deviceId}`} icon={null} label={choiceLabel(choice)}
        testID={`teammates.createChooser.${choice.kind}.${choice.host.deviceId}`}
        onPress={() => { pendingChoice.current = choice; setChoosing(false); }} />)}
    </CompanionSheet>
    {open?.kind === 'bot' ? <CompanionCreateSheet visible={visible} deviceId={open.host.deviceId} deviceName={open.host.deviceName}
      collectionId={TEAMMATE_COLLECTION_ID} online={targets.some((target) => target.deviceId === open.host.deviceId)}
      onClose={() => setVisible(false)} onCreated={(ref) => { receipt.current = ref; }}
      onClosed={() => {
        const ref = receipt.current; receipt.current = null;
        if (ref && mounted.current && currentAccount.current === account) onCreated(open.host, ref);
      }} /> : null}
    {withGroups ? <BotGroupCreateSheet visible={visible && !!groupOpen} host={groupOpen?.host ?? null}
      online={!!groupOpen && groupTargets.some((target) => target.deviceId === groupOpen.host.deviceId)}
      onClose={() => setVisible(false)}
      onCreated={(groupId) => { groupReceipt.current = groupId; }}
      onClosed={() => {
        const groupId = groupReceipt.current; groupReceipt.current = null;
        if (groupId && groupOpen && mounted.current && currentAccount.current === account) onGroupCreated?.(groupOpen.host, groupId);
      }} /> : null}
  </>;
}
