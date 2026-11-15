import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RemoteResourceRef } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { NativePullDownMenu, usesNativePullDownMenu, type NativePullDownAction } from '@/platform/chrome/NativePullDownMenu';
import { BotGroupCreateSheet } from './BotGroupCreateSheet';
import { CompanionCreateSheet } from './CompanionProfileSheet';
import { CompanionSettingsRow } from './CompanionSettingsRow';
import { CompanionSheet } from './CompanionSheet';
import { TEAMMATE_COLLECTION_ID } from './useTeammateRoster';

type CreateKind = 'bot' | 'group';
type Choice = { kind: CreateKind; host: RemoteResourceHostTarget };

type CreateOptions = {
  targets: readonly RemoteResourceHostTarget[];
  /** Online computers that support group chats; empty keeps the single-purpose button. */
  groupTargets?: readonly RemoteResourceHostTarget[];
  preferredDeviceId?: string;
  /** Available to a signed-in account without a connected computer. */
  onInvite?(): void;
  onCreated(host: RemoteResourceHostTarget, ref: RemoteResourceRef): void;
  onGroupCreated?(host: RemoteResourceHostTarget, groupId: string): void;
};

/**
 * 新建伙伴 / 新建群聊的菜单与表单。支持群聊时是一个菜单（多台电脑时再选电脑）；旧版电脑不支持
 * 群聊时直接新建伙伴。表单关闭后才回报创建结果，避免两个 Modal 叠加。
 * The trigger is drawn by the caller: the task home's teammate section moves it between states, and
 * a moving trigger must not unmount an open form or drop its receipt. It starts over on an account
 * switch by itself: the root-hosted home list (Android, wide screens) keeps its state across the
 * account-keyed route.
 */
export function useTeammateCreateController({ targets, groupTargets = [], preferredDeviceId, onCreated, onGroupCreated, onInvite }: CreateOptions) {
  const { t } = useTranslation();
  const { accountGeneration } = useAuth();
  const [account, setAccount] = useState(accountGeneration);
  const currentAccount = useRef(accountGeneration); currentAccount.current = accountGeneration;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState<Choice | null>(null);
  const [visible, setVisible] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const pendingChoice = useRef<Choice | null>(null);
  const pendingInvite = useRef(false);
  const receipt = useRef<RemoteResourceRef | null>(null);
  const groupReceipt = useRef<string | null>(null);
  // Callbacks already handed out keep the old account and stay fenced; new ones serve the new account.
  if (account !== accountGeneration) {
    setAccount(accountGeneration); setOpen(null); setVisible(false); setChoosing(false);
  }
  useEffect(() => { pendingChoice.current = null; pendingInvite.current = false; receipt.current = null; groupReceipt.current = null; }, [accountGeneration]);
  const withGroups = groupTargets.length > 0 && !!onGroupCreated;
  const order = (hosts: readonly RemoteResourceHostTarget[]) => [...hosts]
    .sort((a, b) => Number(b.deviceId === preferredDeviceId) - Number(a.deviceId === preferredDeviceId));
  const ordered = order(targets);
  const orderedGroups = order(groupTargets);
  const start = (kind: CreateKind, deviceId: string) => {
    const target = (kind === 'bot' ? targets : groupTargets).find((item) => item.deviceId === deviceId);
    if (!mounted.current || currentAccount.current !== account || !target) return;
    setOpen({ kind, host: target }); setVisible(true);
  };
  const botLabel = t(withGroups ? 'devices.companions.createTeammate' : 'devices.companionProfile.create');
  const groupLabel = t('groupChat.create.title');
  const entry = (kind: CreateKind, hosts: readonly RemoteResourceHostTarget[]): NativePullDownAction => ({
    id: hosts.length === 1 ? `${kind}:${hosts[0]!.deviceId}` : kind,
    title: kind === 'bot' ? botLabel : groupLabel,
    image: kind === 'bot' ? 'person.crop.circle.badge.plus' : 'person.2',
    ...(hosts.length > 1 ? { subactions: hosts.map((host) => ({ id: `${kind}:${host.deviceId}`, title: host.deviceName })) } : {}),
  });
  const withMenu = withGroups || !!onInvite;
  const menuActions: NativePullDownAction[] = withMenu
    ? [...(ordered.length ? [entry('bot', ordered)] : []), ...(withGroups ? [entry('group', orderedGroups)] : [])]
    : ordered.map((target) => ({ id: target.deviceId, title: target.deviceName }));
  if (onInvite) menuActions.push({ id: 'invitation-section', title: '', displayInline: true,
    subactions: [{ id: 'invite', title: t('groupChat.invitation.entry'), image: 'link' }] });
  const onMenu = (id: string) => {
    if (!mounted.current || currentAccount.current !== account) return;
    if (id === 'invite') { onInvite?.(); return; }
    if (!withMenu) { start('bot', id); return; }
    const split = id.indexOf(':');
    if (split > 0) start(id.slice(0, split) as CreateKind, id.slice(split + 1));
  };
  const label = withMenu ? t('devices.companions.createMenu') : botLabel;
  const needsMenu = withMenu || targets.length > 1;
  const press = () => {
    // The empty state names the next step instead of only reporting that nothing is available.
    if (!withMenu && !targets.length) Alert.alert(label, t('devices.companions.noCreateHosts'));
    else if (!needsMenu) start('bot', targets[0]!.deviceId);
    else if (!usesNativePullDownMenu()) setChoosing(true);
  };
  const fallbackChoices: Choice[] = [
    ...ordered.map((host) => ({ kind: 'bot' as const, host })),
    ...(withGroups ? orderedGroups.map((host) => ({ kind: 'group' as const, host })) : []),
  ];
  const choiceLabel = (choice: Choice) => {
    if (!withMenu) return choice.host.deviceName;
    const verb = choice.kind === 'bot' ? botLabel : groupLabel;
    return (choice.kind === 'bot' ? ordered : orderedGroups).length > 1 ? `${verb} · ${choice.host.deviceName}` : verb;
  };
  const groupOpen = open?.kind === 'group' ? open : null;
  const menu = needsMenu && menuActions.length > 0;
  /** Wraps the caller's button in the native menu when one is needed. */
  const renderTrigger = (button: ReactElement) => menu
    ? <NativePullDownMenu actions={menuActions} onAction={onMenu} testID="teammates.createMenu">{button}</NativePullDownMenu>
    : button;
  const sheets = <>
    <CompanionSheet visible={choosing} title={label} testID="teammates.createChooser" onClose={() => { pendingChoice.current = null; pendingInvite.current = false; setChoosing(false); }}
      onClosed={() => { if (!mounted.current || currentAccount.current !== account) return;
        const choice = pendingChoice.current; pendingChoice.current = null; if (choice) start(choice.kind, choice.host.deviceId);
        const invite = pendingInvite.current; pendingInvite.current = false;
        if (invite && mounted.current && currentAccount.current === account) onInvite?.(); }}>
      {/* Same choice as the header's native menu: one plain row per choice, not full-width buttons. */}
      {fallbackChoices.map((choice) => <CompanionSettingsRow key={`${choice.kind}:${choice.host.deviceId}`} icon={null} label={choiceLabel(choice)}
        testID={`teammates.createChooser.${choice.kind}.${choice.host.deviceId}`}
        onPress={() => { pendingChoice.current = choice; setChoosing(false); }} />)}
      {onInvite ? <CompanionSettingsRow icon={null} label={t('groupChat.invitation.entry')} testID="teammates.invite"
        onPress={() => { if (mounted.current && currentAccount.current === account) { pendingInvite.current = true; setChoosing(false); } }} /> : null}
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
  return { press, label, renderTrigger, sheets };
}
