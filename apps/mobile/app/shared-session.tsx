import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Check, Clock, FileText, Laptop, Link, Users } from 'lucide-react-native';
import { sharedTaskHostPeer, parseSharedTaskPeer, SHARED_TASK_HOST_CHANNEL,
  type SharedTaskHostCommand, type SharedTaskHostState, type SharedTaskListItem } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { goBackGuarded } from '@/utils/backGuard';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useSharedTaskApi } from '@/device-link/useSharedTaskApi';
import { sharedTaskErrorKey } from '@/device-link/sharedTaskCompatibility';
import { isSharedTaskGone } from '@/device-link/sharedTaskAccessWatch';
import { markDeviceAccessRevoked } from '@/device-link/accessRevoked';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowRowButton } from '@/components/MobilePrimitives';
import { SharedTaskAction, SharedTaskScreen } from '@/session/SharedTaskScreen';
import { useSharedTaskConfirmation } from '@/session/useSharedTaskConfirmation';
import { SharedTaskEndedState } from '@/session/SharedTaskEndedState';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { writeClipboardText } from '@/session/messageActions';
import type { RemoteSession } from '@/session/types';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Plan B management only; conversation/input continue through the ordinary remote task. */
export default function SharedSessionScreen() {
  const { sessionId, deviceId, sharedTaskId } = useLocalSearchParams<{ sessionId?: string; deviceId?: string; sharedTaskId?: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { isAuthenticated, accountGeneration } = useAuth();
  const api = useSharedTaskApi();
  const confirmation = useSharedTaskConfirmation();
  const link = useDeviceLink();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [invitation, setInvitation] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<SharedTaskHostState | null>(null);
  const [owned, setOwned] = useState<SharedTaskListItem[]>([]);
  const [guestCounts, setGuestCounts] = useState<Record<string, number>>({});
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'current' | 'owned'>('current');
  const [joinedId, setJoinedId] = useState<string>();
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmationPending = useRef<object | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const pageGeneration = useRef(0);
  const peer = deviceId ? parseSharedTaskPeer(deviceId) : null;
  const guestId = peer?.role === 'host' ? peer.sharedTaskId : joinedId ?? sharedTaskId;
  const guestTarget = peer?.role === 'host' ? deviceId
    : guestId && state?.detail ? sharedTaskHostPeer(guestId, state.detail.hostDeviceId) : undefined;
  const hostContext = !!sessionId && !!deviceId && !guestId;
  const host = useCallback((command: SharedTaskHostCommand) => link.invoke(deviceId!, SHARED_TASK_HOST_CHANNEL, [command]), [deviceId, link.invoke]);
  const endAccess = useCallback(() => {
    confirmationPending.current = null;
    setEnded(true); setState(null); setNotice('');
    if (guestTarget) {
      const target = guestTarget;
      markDeviceAccessRevoked(target);
      link.closeLink(target);
      remoteSessionStore.removeDevice(target);
    }
  }, [guestTarget, link.closeLink]);
  const load = useCallback(async (visible: () => boolean = () => true) => {
    const captured = epoch.current;
    const owner = getMobileAuthOwner();
    const current = () => visible() && mounted.current && captured === epoch.current && isMobileAuthOwnerCurrent(owner);
    if (!isAuthenticated || link.sharedTaskAvailable !== true || ended) return;
    if (!guestId && tab === 'owned') {
      const value = await api.list();
      if (!current()) return;
      const mine = value.filter((task) => task.ownerAccountId === owner.accountId);
      setOwned(mine);
      const counts: Record<string, number> = {};
      for (const task of mine) {
        if (!current()) return;
        const detail = await api.get(task.sharedTaskId).catch(() => null);
        if (detail) counts[task.sharedTaskId] = detail.memberLabels.length;
      }
      if (current()) setGuestCounts(counts);
      // Device names are account-owned display data; a failed name lookup does not hide tasks.
      const devices = await link.readDeviceList().catch(() => null);
      if (current() && devices) setDeviceNames(Object.fromEntries(devices.devices.map((device) => [device.deviceId, device.name])));
    } else if (guestId || hostContext) {
      try {
        const value = guestId ? { available: true, detail: await api.get(guestId) }
          : await host({ action: 'state', sessionId: sessionId! }) as SharedTaskHostState;
        if (!current()) return;
        if (guestId && value.detail?.status === 'closed') endAccess();
        else setState(value);
        if (hostContext) {
          const all = await api.list().catch(() => null);
          if (current() && all) setOwned(all.filter((task) => task.ownerAccountId === owner.accountId));
        }
      } catch (error) {
        if (current() && guestId && isSharedTaskGone(error)) endAccess();
        else throw error;
      }
    } else {
      const value = await api.list();
      if (current()) {
        setOwned(value.filter((task) => task.ownerAccountId === owner.accountId));
      }
    }
  }, [api, ended, endAccess, guestId, host, hostContext, isAuthenticated, link.readDeviceList, link.sharedTaskAvailable, sessionId, tab]);
  useEffect(() => {
    mounted.current = true;
    epoch.current++; pending.current = false; setBusy(false);
    setState(null); setOwned([]); setGuestCounts({}); setJoinedId(undefined); setEnded(false);
    setInvitation(''); setName(''); setNotice(''); setLoadError(''); setTab('current'); confirmationPending.current = null;
    return () => { mounted.current = false; epoch.current++; };
  }, [accountGeneration, deviceId, sessionId, sharedTaskId]);
  useFocusEffect(useCallback(() => {
    const captured = ++pageGeneration.current;
    return () => {
      if (pageGeneration.current === captured) pageGeneration.current++;
      confirmationPending.current = null;
      pending.current = false;
      setBusy(false);
    };
  }, []));
  useFocusEffect(useCallback(() => {
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (disposed || polling || pending.current || AppState.currentState !== 'active') return;
      polling = true;
      const owner = getMobileAuthOwner();
      try { await load(() => !disposed); if (!disposed && isMobileAuthOwnerCurrent(owner)) setLoadError(''); }
      catch (error) {
        if (!disposed && isMobileAuthOwnerCurrent(owner)) {
          const key = sharedTaskErrorKey(error);
          if (key === 'sharedTask.upgrade' && sessionId) setState({ available: false, detail: null });
          else setLoadError(t(key));
        }
      } finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [accountGeneration, load, sessionId, t]));
  const run = async (work: (current: () => boolean) => Promise<void>, reload = true, context: 'join' | 'operation' = 'operation') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice('');
    const owner = getMobileAuthOwner();
    // A read already in flight must not restore state from before this action.
    const captured = ++epoch.current;
    const page = pageGeneration.current;
    const current = () => mounted.current && captured === epoch.current && page === pageGeneration.current && isMobileAuthOwnerCurrent(owner);
    try {
      if (link.sharedTaskAvailable !== true) { setNotice(t(link.sharedTaskAvailable === false ? 'sharedTask.upgrade' : 'sharedTask.retry')); return; }
      await work(current);
      if (reload && current()) await load();
    } catch (error) {
      if (current()) {
        if (guestId && isSharedTaskGone(error)) endAccess();
        else setNotice(t(sharedTaskErrorKey(error, context)));
      }
    } finally { if (captured === epoch.current && page === pageGeneration.current) { pending.current = false; setBusy(false); } }
  };
  const confirm = (title: string, body: string, cancel: string, action: string, work: (current: () => boolean) => Promise<void>, reload = true, extra?: { items?: string[]; note?: string }) => {
    if (confirmationPending.current || pending.current) return;
    const owner = getMobileAuthOwner();
    const captured = epoch.current;
    const page = pageGeneration.current;
    const request = {};
    confirmationPending.current = request;
    Keyboard.dismiss();
    void confirmation.confirm({
      title, message: [body, extra?.items?.join('\n'), extra?.note].filter(Boolean).join('\n\n'),
      cancelLabel: cancel, confirmLabel: action, destructive: true, cancelable: true,
    }).then((accepted) => {
      if (confirmationPending.current !== request) return;
      confirmationPending.current = null;
      if (accepted && mounted.current && captured === epoch.current && page === pageGeneration.current && isMobileAuthOwnerCurrent(owner)) void run(work, reload);
    });
  };
  const openTask = async (id: string, current: () => boolean) => {
    const owner = getMobileAuthOwner();
    const detail = await api.get(id);
    if (!current()) return;
    if (detail.status !== 'active') { endAccess(); return; }
    const isOwner = detail.ownerAccountId === owner.accountId;
    const target = isOwner ? detail.hostDeviceId : sharedTaskHostPeer(id, detail.hostDeviceId);
    let targetName = detail.title;
    if (isOwner) {
      const devices = await link.readDeviceList();
      if (!current()) return;
      const device = devices.devices.find(item => item.deviceId === target);
      if (device?.remoteControlEnabled === false) { setNotice(t('deviceLink.connectStep3')); return; }
      targetName = device?.name ?? t('sharedTask.hostDevice');
    }
    await link.openLink(target);
    if (!current()) return;
    const task = await link.invoke<RemoteSession>(target, 'local-db:sessions:get', [detail.sessionId]);
    if (!current() || task.id !== detail.sessionId) return;
    if (isOwner) remoteSessionStore.upsertDeviceSession(target, targetName, task);
    else remoteSessionStore.setDeviceSessions(target, targetName, [task]);
    router.replace({ pathname: '/sessions/[sessionId]', params: { sessionId: detail.sessionId, deviceId: target, deviceName: targetName } });
  };
  const detail = state?.detail?.status === 'active' ? state.detail : null;
  const ownDetail = !!detail && detail.ownerAccountId === getMobileAuthOwner().accountId;
  const task = remoteSessionStore.getSessions().find((task) => task.id === sessionId && task.deviceLinkDeviceId === deviceId);
  const title = detail?.title ?? task?.title ?? t('sharedTask.title');
  const deviceName = (id: string) => deviceNames[id] ?? remoteSessionStore.getSessions().find((task) => task.deviceLinkDeviceId === id)?.deviceLinkDeviceName ?? t('sharedTask.hostDevice');
  const closeTasks = (items: SharedTaskListItem[]) => confirm(
    t('sharedTask.closeAllTitle'),
    t('sharedTask.closeAllBody'),
    t('sharedTask.closeAllKeep'), t('sharedTask.closeAllAction', { count: items.length }), async (current) => {
      const closed = new Set<string>();
      const failed: SharedTaskListItem[] = [];
      for (const item of items) {
        if (!current()) return;
        try {
          await api.close(item.sharedTaskId);
          if (!current()) return;
          closed.add(item.sharedTaskId);
        } catch {
          if (!current()) return;
          failed.push(item);
        }
      }
      if (!current()) return;
      setOwned((value) => value.filter((item) => !closed.has(item.sharedTaskId)));
      const failedCount = failed.length;
      setNotice(t(failedCount ? 'sharedTask.closeFailedToast' : 'sharedTask.closedToast', { count: failedCount || closed.size }));
    }, true, { items: items.map((item) => item.title + ' · ' + deviceName(item.hostDeviceId)), note: t('sharedTask.closeAllScopeNote') });
  const leave = () => confirm(t('sharedTask.leaveTitle'), t('sharedTask.leaveBody'), t('sharedTask.leaveKeep'), t('sharedTask.leave'), async (current) => {
    await api.leave(guestId!);
    if (!current()) return;
    if (guestTarget) { link.closeLink(guestTarget); remoteSessionStore.removeDevice(guestTarget); }
    router.replace('/devices');
  }, false);
  const taskCard = <View style={styles.taskRow}><FileText size={iconSize.md} color={colors.textTertiary} /><View style={styles.grow}><Text style={styles.taskTitle}>{title}</Text><Text style={styles.metadata}>{task?.deviceLinkDeviceName ?? t('sharedTask.runsOnHostDevice')}</Text></View></View>;
  return <SharedTaskScreen
    title={t(ended ? 'sharedTask.ended' : !guestId && tab === 'owned' ? 'sharedTask.ownedTitle' : hostContext || guestId ? 'sharedTask.title' : 'sharedTask.join')}
    onClose={() => goBackGuarded(router, '/devices')}>
    {confirmation.dialog}
    {!isAuthenticated ? <Text style={styles.intro}>{t('sharedTask.login')}</Text> : ended ? <SharedTaskEndedState onRejoin={() => {
      setJoinedId(undefined); setEnded(false); setState(null); setNotice(''); setLoadError('');
      router.replace('/shared-session');
    }} /> : link.sharedTaskAvailable !== true ? <Text style={styles.intro}>{t(link.sharedTaskAvailable === false ? 'sharedTask.upgrade' : 'sharedTask.retry')}</Text> : <>
      {!guestId && <View style={styles.tabs}>
        <MainWindowRowButton accessibilityLabel={t(hostContext ? 'sharedTask.tabCurrent' : 'sharedTask.join')} selected={tab === 'current'} style={[styles.tab, tab === 'current' && styles.tabSelected]} onPress={() => { setNotice(''); setTab('current'); }}><Text style={styles.small}>{t(hostContext ? 'sharedTask.tabCurrent' : 'sharedTask.join')}</Text></MainWindowRowButton>
        <MainWindowRowButton accessibilityLabel={t('sharedTask.tabOwned')} selected={tab === 'owned'} style={[styles.tab, tab === 'owned' && styles.tabSelected]} onPress={() => { setNotice(''); setTab('owned'); }}><Text style={styles.small}>{t('sharedTask.tabOwned')}</Text><View style={styles.badge}><Text style={styles.metadata}>{owned.length}</Text></View></MainWindowRowButton>
      </View>}
      {!!notice && <Text accessibilityRole="alert" style={styles.noticeText}>{notice}</Text>}
      {!!loadError && <Text accessibilityRole="alert" style={styles.noticeText}>{loadError}</Text>}
      {!guestId && tab === 'owned' ? owned.length === 0 ? <View style={styles.empty}>
        <View style={styles.largeIcon}><Check size={iconSize.md} color={colors.textPrimary} /></View>
        <Text style={styles.emptyTitle}>{t('sharedTask.ownedEmptyTitle')}</Text><Text style={styles.emptyCopy}>{t('sharedTask.ownedEmptyHint')}</Text>
        {hostContext && <SharedTaskAction action={{ label: t('sharedTask.shareCurrent'), onPress: () => setTab('current') }} />}
      </View> : <>
        <Text style={styles.intro}>{t('sharedTask.ownedIntro', { count: owned.length })}</Text>
        {owned.map((item) => <View key={item.sharedTaskId} style={styles.taskRow}><Users size={iconSize.md} color={colors.textTertiary} /><View style={styles.grow}><Text style={styles.taskTitle}>{item.title}</Text><Text style={styles.metadata}>{deviceName(item.hostDeviceId)}{guestCounts[item.sharedTaskId] !== undefined ? ' · ' + t('sharedTask.guestCount', { count: guestCounts[item.sharedTaskId] }) : ''}</Text></View>
          {item.sessionId === sessionId && item.hostDeviceId === deviceId ? <SharedTaskAction compact action={{ label: t('sharedTask.manage'), onPress: () => setTab('current') }} /> : <SharedTaskAction compact action={{ label: t('sharedTask.enterTask'), disabled: busy, onPress: () => void run(current => openTask(item.sharedTaskId, current), false) }} />}
        </View>)}
        <View style={styles.rule} /><Text style={styles.smallMuted}>{t('sharedTask.closeAllNote')}</Text>
        <View style={styles.footer}><SharedTaskAction grow action={{ label: t('sharedTask.closeAll', { count: owned.length }), tone: 'danger', disabled: busy, onPress: () => closeTasks([...owned]) }} /></View>
      </> : guestId ? !detail ? <Text style={styles.intro}>{t('shared.syncing')}</Text> : <>
        <View style={styles.empty}>
          <View style={styles.largeIcon}><Check size={iconSize.md} color={colors.textPrimary} /></View>
          <Text style={styles.emptyTitle}>{ownDetail ? detail.title : detail ? t('sharedTask.joinedTitle', { title: detail.title }) : t('sharedTask.joined')}</Text>
          <Text style={styles.emptyCopy}>{t(ownDetail ? 'sharedTask.roleHost' : 'sharedTask.joinedBody')}</Text>
          <SharedTaskAction action={{ label: t('sharedTask.enterTask'), tone: 'primary', busy, onPress: () => void run((current) => openTask(guestId, current), false) }} />
        </View>
        {!ownDetail && <><View style={styles.rule} /><SharedTaskAction action={{ label: t('sharedTask.leave'), tone: 'danger', disabled: busy, onPress: leave }} /></>}
      </> : hostContext ? !state ? <Text style={styles.intro}>{t('shared.syncing')}</Text> : !state.available ? <Text style={styles.intro}>{t('sharedTask.upgrade')}</Text> : !detail ? <>
        <Text style={styles.intro}>{t('sharedTask.startIntro')}</Text>{taskCard}
        <View style={styles.noticeBox}><Users size={iconSize.sm} color={colors.textTertiary} /><Text style={[styles.smallMuted, styles.grow]}>{t('sharedTask.inviteNotice')}</Text></View>
        <Text style={styles.smallMuted}>{t('sharedTask.offlineAutoClose')}</Text>
        <View style={styles.footer}><SharedTaskAction grow action={{ label: t('sharedTask.open'), tone: 'primary', busy, onPress: () => void run(async () => { await host({ action: 'open', sessionId: sessionId! }); }) }} /></View>
      </> : <>
        <Text style={styles.caption}>{title}</Text>
        <View style={styles.copyBox}><Link size={iconSize.md} color={colors.textTertiary} /><View style={styles.grow}><Text style={styles.smallMuted}>{t('sharedTask.inviteBoxTitle')}</Text><Text style={styles.smallMuted}>{t('sharedTask.inviteBoxHint')}</Text></View>
          <SharedTaskAction compact action={{ label: t('sharedTask.invite'), tone: 'primary', disabled: busy, onPress: () => void run(async (current) => {
            const result = await host({ action: 'invite', sharedTaskId: detail.sharedTaskId }) as { invitation: string };
            if (!current()) return;
            try { await writeClipboardText(result.invitation); if (current()) setNotice(t('sharedTask.invitationCopied')); }
            catch { if (current()) setNotice(t('sharedTask.invitationCopyFailed')); }
          }, false) }} />
        </View>
        <Text style={styles.peopleTitle}>{t('sharedTask.membersWithLimit', { count: detail.memberLabels.length + 1 })}</Text>
        <View style={styles.person}><View style={styles.avatar}><Laptop size={iconSize.sm} color={colors.textTertiary} /></View><View style={styles.grow}><Text style={styles.personName}>{t('sharedTask.me')}</Text><Text style={styles.metadata}>{task?.deviceLinkDeviceName ?? t('sharedTask.hostDevice')}</Text></View><Text style={styles.smallMuted}>{t('sharedTask.roleHost')}</Text></View>
        {detail.memberLabels.map((member) => <View key={member.memberId} style={styles.person}><View style={styles.avatar}><Text style={styles.metadata}>{Array.from(member.displayName)[0]}</Text></View><View style={styles.grow}><Text style={styles.personName}>{member.displayName}</Text><Text style={styles.metadata}>{t('sharedTask.roleGuest')}</Text></View>
          <SharedTaskAction compact action={{ label: t('sharedTask.removeShort'), tone: 'danger', accessibilityLabel: t('sharedTask.removeNamedTitle', { name: member.displayName }), disabled: busy, onPress: () => confirm(t('sharedTask.removeNamedTitle', { name: member.displayName }), t('sharedTask.removeBody'), t('sharedTask.removeKeep'), t('sharedTask.remove'), async () => { await host({ action: 'remove', sharedTaskId: detail.sharedTaskId, memberId: member.memberId }); }) }} />
        </View>)}
        <View style={styles.noticeBox}><Clock size={iconSize.sm} color={colors.textTertiary} /><Text style={[styles.smallMuted, styles.grow]}>{t('sharedTask.remoteHostOfflineNote')}</Text></View>
        <View style={styles.footer}><SharedTaskAction grow action={{ label: t('sharedTask.closeCurrent'), tone: 'danger', disabled: busy, onPress: () => confirm(t('sharedTask.closeOneTitle'), t('sharedTask.closeOneBody'), t('sharedTask.closeAllKeep'), t('sharedTask.close'), async () => { await host({ action: 'close', sharedTaskId: detail.sharedTaskId }); }) }} /></View>
      </> : <>
        <Text style={styles.intro}>{t('sharedTask.joinIntro')}</Text>
        <View style={styles.field}><Text style={styles.label}>{t('sharedTask.invitation')}</Text><TextInput accessibilityLabel={t('sharedTask.invitation')} placeholder={t('sharedTask.invitationPlaceholder')} placeholderTextColor={colors.textTertiary} style={[styles.input, styles.invitation]} value={invitation} onChangeText={setInvitation} multiline textAlignVertical="top" autoCapitalize="none" autoCorrect={false} editable={!busy} /></View>
        <View style={styles.field}><Text style={styles.label}>{t('sharedTask.joinNickname')}</Text><TextInput accessibilityLabel={t('sharedTask.joinNickname')} placeholder={t('sharedTask.nicknamePlaceholder')} placeholderTextColor={colors.textTertiary} style={styles.input} value={name} onChangeText={setName} maxLength={32} editable={!busy} /></View>
        <View style={styles.noticeBox}><Users size={iconSize.sm} color={colors.textTertiary} /><Text style={[styles.smallMuted, styles.grow]}>{t('sharedTask.joinNotice')}</Text></View>
        <View style={styles.footer}><SharedTaskAction grow action={{ label: t('sharedTask.join'), tone: 'primary', busy, disabled: !invitation.trim() || !name.trim(), onPress: () => void run(async (current) => {
          if (!/^[A-Za-z0-9_-]{43}$/.test(invitation.trim()) || name.trim().length > 32) { setNotice(t('sharedTask.invalid')); return; }
          const joined = await api.join(invitation.trim(), name.trim());
          if (!current()) return;
          Keyboard.dismiss(); setInvitation(''); setJoinedId(joined.sharedTaskId);
        }, false, 'join') }} /></View>
      </>}
    </>}
  </SharedTaskScreen>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  intro: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.listBody, marginBottom: spacing.lg },
  small: { color: colors.textPrimary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  smallMuted: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  taskTitle: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.listBody, fontWeight: fontWeight.medium },
  metadata: { color: colors.textTertiary, fontSize: typeScale.micro, lineHeight: lineHeight.micro },
  caption: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, marginBottom: spacing.sm },
  noticeText: { color: colors.errorText, fontSize: typeScale.caption, lineHeight: lineHeight.caption, marginBottom: spacing.md },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, padding: spacing.md, marginVertical: spacing.sm },
  copyBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, padding: spacing.md, marginVertical: spacing.lg },
  noticeBox: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, backgroundColor: colors.surfaceChip, borderRadius: radius.control, padding: spacing.md, marginVertical: spacing.lg },
  tabs: { flexDirection: 'row', gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: spacing.md, marginBottom: spacing.lg },
  tab: { flex: 1, minHeight: 44, borderBottomWidth: 0, borderRadius: radius.pill, justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  tabSelected: { backgroundColor: colors.surfaceChip },
  badge: { borderRadius: radius.pill, backgroundColor: colors.surfaceChip, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  grow: { flex: 1 },
  field: { gap: spacing.xs, marginBottom: spacing.lg },
  label: { color: colors.textPrimary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.textPrimary, backgroundColor: colors.surface, fontSize: typeScale.listBody, lineHeight: lineHeight.listBody },
  invitation: { minHeight: 82, borderRadius: radius.control },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingVertical: spacing.sm },
  personName: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.listBody, fontWeight: fontWeight.medium },
  peopleTitle: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, marginTop: spacing.lg, marginBottom: spacing.xs },
  avatar: { width: 28, height: 28, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceChip, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingVertical: spacing.xl, paddingHorizontal: spacing.xs },
  largeIcon: { width: 44, height: 44, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  emptyTitle: { color: colors.textPrimary, fontSize: typeScale.listBody, lineHeight: lineHeight.listBody, fontWeight: fontWeight.medium, textAlign: 'center' },
  emptyCopy: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, textAlign: 'center', maxWidth: 280, marginTop: spacing.sm, marginBottom: spacing.lg },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.lg },
  footer: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
});
