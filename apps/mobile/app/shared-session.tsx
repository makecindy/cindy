import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Check, Clock, FileText, Laptop, Link, Users } from 'lucide-react-native';
import { buildSharedTaskInvitationLink, parseSharedTaskInvitation, sharedTaskAccountName, sharedTaskHostPeer, parseSharedTaskPeer, SHARED_TASK_HOST_CHANNEL,
  type SharedTaskHostCommand, type SharedTaskHostState, type SharedTaskListItem } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { APP_SCHEME, DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { clearSharedTaskInvitationIntent, usePendingSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';
import { goBackGuarded } from '@/utils/backGuard';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useSharedTaskApi } from '@/device-link/useSharedTaskApi';
import { sharedTaskErrorKey } from '@/device-link/sharedTaskCompatibility';
import { isSharedTaskGone } from '@/device-link/sharedTaskAccessWatch';
import { markDeviceAccessRevoked } from '@/device-link/accessRevoked';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton, MainWindowEmptyState, MainWindowRowButton } from '@/components/MobilePrimitives';
import { SharedTaskAction, SharedTaskScreen } from '@/session/SharedTaskScreen';
import { useSharedTaskConfirmation } from '@/session/useSharedTaskConfirmation';
import { SharedTaskEndedState } from '@/session/SharedTaskEndedState';
import { SharedTaskAdmissionDialog } from '@/session/SharedTaskAdmissionDialog';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { writeClipboardText } from '@/session/messageActions';
import type { RemoteSession } from '@/session/types';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Plan B management only; conversation/input continue through the ordinary remote task. */
export default function SharedSessionScreen() {
  const { sessionId, deviceId, sharedTaskId, expectedOwnedSharedTaskId, mode } = useLocalSearchParams<{ sessionId?: string; deviceId?: string; sharedTaskId?: string; expectedOwnedSharedTaskId?: string; mode?: string }>();
  const management = mode === 'manage' && !sessionId && !deviceId && !sharedTaskId;
  const router = useRouter();
  const { t } = useTranslation();
  const { isAuthenticated, accountGeneration, user } = useAuth();
  const incomingInvitation = usePendingSharedTaskInvitationIntent();
  const api = useSharedTaskApi();
  const confirmation = useSharedTaskConfirmation();
  const link = useDeviceLink();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [invitation, setInvitation] = useState('');
  const [incomingLink, setIncomingLink] = useState<{ link: string; owner: ReturnType<typeof getMobileAuthOwner>; expiresAt: number } | null>(null);
  const [state, setState] = useState<SharedTaskHostState | null>(null);
  const [ownedTargetUnavailable, setOwnedTargetUnavailable] = useState(false);
  const [owned, setOwned] = useState<SharedTaskListItem[]>([]);
  const [joined, setJoined] = useState<SharedTaskListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [guestCounts, setGuestCounts] = useState<Record<string, number>>({});
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'current' | 'owned' | 'joined'>('current');
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
    if (!guestId && (management || tab === 'owned')) {
      const value = await api.list();
      if (!current()) return;
      const mine = value.filter((task) => task.ownerAccountId === owner.accountId);
      setOwned(mine);
      setJoined(value.filter((task) => task.ownerAccountId !== owner.accountId));
      setLoaded(true);
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
        // A management list entry identifies one sharing lifetime, not its replacement.
        if (hostContext && expectedOwnedSharedTaskId && (!value.detail
            || value.detail.sharedTaskId !== expectedOwnedSharedTaskId
            || value.detail.sessionId !== sessionId || value.detail.status !== 'active')) {
          setState(null); setOwnedTargetUnavailable(true);
          return;
        }
        setOwnedTargetUnavailable(false);
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
  }, [api, ended, endAccess, expectedOwnedSharedTaskId, guestId, host, hostContext, isAuthenticated, link.readDeviceList, link.sharedTaskAvailable, sessionId, tab, management]);
  useEffect(() => {
    mounted.current = true;
    epoch.current++; pending.current = false; setBusy(false);
    setState(null); setOwnedTargetUnavailable(false); setOwned([]); setJoined([]); setLoaded(false); setManualOpen(false); setGuestCounts({}); setJoinedId(undefined); setEnded(false);
    setInvitation(''); setIncomingLink(null);
    setNotice(''); setLoadError(''); setTab(management ? 'owned' : 'current'); confirmationPending.current = null;
    return () => { mounted.current = false; epoch.current++; };
  }, [accountGeneration, deviceId, sessionId, sharedTaskId, expectedOwnedSharedTaskId, management]);
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
  const joinInvitation = (input: string, enter = false) => void run(async (current) => {
    const parsed = parseSharedTaskInvitation(input, DEVICE_LINK_API_BASE_URL);
    if (!parsed.ok) { setNotice(t(parsed.reason === 'different-server' ? 'sharedTask.invitationDifferentServer' : 'sharedTask.invalid')); return; }
    const joined = await api.join(parsed.invitation, sharedTaskAccountName(user?.name));
    if (!current()) return;
    Keyboard.dismiss(); setInvitation(''); setJoinedId(joined.sharedTaskId);
    setManualOpen(false);
    if (enter) await openTask(joined.sharedTaskId, current);
  }, false, 'join');
  useEffect(() => {
    if (incomingInvitation?.source !== 'link' || !isAuthenticated || sessionId || deviceId || sharedTaskId) return;
    const input = buildSharedTaskInvitationLink(incomingInvitation.invitation, incomingInvitation.server);
    // Claim before waiting for relay capability. Leaving this screen discards the invitation.
    epoch.current++; pending.current = false; setBusy(false);
    setJoinedId(undefined); setState(null); setEnded(false); setTab('current');
    setIncomingLink({ link: input, owner: getMobileAuthOwner(), expiresAt: incomingInvitation.expiresAt });
    clearSharedTaskInvitationIntent();
    setInvitation(input);
  }, [incomingInvitation, isAuthenticated, sessionId, deviceId, sharedTaskId]);
  useEffect(() => {
    if (!incomingLink) return;
    // Claiming the intent transfers its original deadline; waiting for capability
    // must not extend the invitation's in-memory lifetime.
    const timer = setTimeout(() => {
      setIncomingLink(null); setInvitation(''); setNotice(t('sharedTask.invitationUnavailable'));
    }, Math.max(0, incomingLink.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [incomingLink, t]);
  useEffect(() => {
    if (!incomingLink) return;
    // Timers can be suspended in the background; check before any automatic join.
    if (Date.now() >= incomingLink.expiresAt) {
      setIncomingLink(null); setInvitation(''); setNotice(t('sharedTask.invitationUnavailable'));
      return;
    }
    if (!isMobileAuthOwnerCurrent(incomingLink.owner) || !isAuthenticated || link.sharedTaskAvailable !== true || guestId || pending.current) return;
    setIncomingLink(null);
    joinInvitation(incomingLink.link, true);
  });
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
  const leaveListed = (item: SharedTaskListItem) => confirm(t('sharedTask.leaveTitle'), t('sharedTask.leaveBody'), t('sharedTask.leaveKeep'), t('sharedTask.leave'), async current => {
    await api.leave(item.sharedTaskId);
    if (!current()) return;
    const target = sharedTaskHostPeer(item.sharedTaskId, item.hostDeviceId);
    link.closeLink(target); remoteSessionStore.removeDevice(target);
    setJoined(items => items.filter(task => task.sharedTaskId !== item.sharedTaskId));
  });
  const manageListed = (item: SharedTaskListItem) => void run(async current => {
    await link.openLink(item.hostDeviceId);
    if (current()) router.push({ pathname: '/shared-session', params: { sessionId: item.sessionId, deviceId: item.hostDeviceId, expectedOwnedSharedTaskId: item.sharedTaskId, mode: 'detail' } });
  }, false);
  const invitationForm = <>
    <Text style={styles.intro}>{t('sharedTask.joinIntro')}</Text>
    <View style={styles.field}><Text style={styles.label}>{t('sharedTask.invitation')}</Text><TextInput accessibilityLabel={t('sharedTask.invitation')} placeholder={t('sharedTask.invitationPlaceholder')} placeholderTextColor={colors.textPlaceholder} style={[styles.input, styles.invitation]} value={invitation} onChangeText={text => { setIncomingLink(null); setInvitation(text); setNotice(''); }} maxLength={8192} multiline textAlignVertical="top" autoCapitalize="none" autoCorrect={false} editable={!busy} /></View>
    <Text style={styles.smallMuted}>{t('sharedTask.joinNotice')}</Text>
    {!!notice && <Text accessibilityRole="alert" style={styles.noticeText}>{notice}</Text>}
    <View style={styles.footer}>
      <SharedTaskAction grow action={{ label: t('sharedTask.cancelOperation'), disabled: busy, onPress: () => setManualOpen(false) }} />
      <SharedTaskAction grow action={{ label: t('sharedTask.join'), tone: 'primary', busy, disabled: !invitation.trim(), onPress: () => joinInvitation(invitation, true) }} />
    </View>
  </>;
  const managementView = <>
    <View style={styles.managementHeading}>
      <View style={styles.managementHeadingCopy}><Text accessibilityRole="header" style={styles.managementTitle}>{t('sharedTask.title')}</Text><Text style={styles.managementDescription}>{t('sharedTask.managementIntro')}</Text></View>
      <MainWindowActionButton density="compact" style={styles.managementButton} textStyle={styles.managementButtonText} action={{ label: t('sharedTask.join'), disabled: busy, onPress: () => { setNotice(''); setInvitation(''); setManualOpen(true); } }} />
    </View>
    <View style={styles.managementTabs}>{(['owned', 'joined'] as const).map(kind => <Pressable key={kind} accessibilityRole="tab" accessibilityLabel={t(kind === 'owned' ? 'sharedTask.tabOwned' : 'sharedTask.joinedTab')} accessibilityState={{ selected: tab === kind, disabled: busy }} disabled={busy} style={styles.managementTab} onPress={() => { setNotice(''); setTab(kind); }}>
      <View style={styles.managementTabLabel}><Text style={[styles.managementTabText, tab === kind && styles.managementTabTextSelected]}>{t(kind === 'owned' ? 'sharedTask.tabOwned' : 'sharedTask.joinedTab')}</Text>{loaded && <Text style={styles.metadata}>{(kind === 'owned' ? owned : joined).length}</Text>}</View>
      {tab === kind && <View style={styles.managementTabIndicator} />}
    </Pressable>)}</View>
    {!loaded ? !loadError && <Text style={styles.intro}>{t('shared.syncing')}</Text> : (tab === 'owned' ? owned : joined).length === 0 ? <View style={styles.managementEmpty}>
      <View style={styles.managementEmptyIcon}><Users size={iconSize.md} color={colors.textTertiary} /></View><Text style={styles.emptyTitle}>{t(tab === 'owned' ? 'sharedTask.ownedEmptyTitle' : 'sharedTask.joinedEmptyTitle')}</Text><Text style={styles.emptyCopy}>{t(tab === 'owned' ? 'sharedTask.ownedEmptyHint' : 'sharedTask.joinedEmptyHint')}</Text>
      {tab === 'owned' && <MainWindowActionButton density="compact" style={styles.managementButton} textStyle={styles.managementButtonText} action={{ label: t('sharedTask.returnToTasks'), onPress: () => router.replace('/devices') }} />}
    </View> : <>
      <View style={styles.managementList}>{(tab === 'owned' ? owned : joined).map((item, index) => <View key={item.sharedTaskId} style={[styles.managementRow, index > 0 && styles.managementRowDivider]}>
        <View style={styles.grow}>
          <Pressable accessibilityRole="button" accessibilityLabel={item.title} disabled={busy} style={styles.managementTaskTitleTarget} onPress={() => void run(current => openTask(item.sharedTaskId, current), false)}><Text style={styles.taskTitle}>{item.title}</Text></Pressable>
          <Text style={styles.managementMetadata}>{tab === 'owned' ? deviceName(item.hostDeviceId) : t('sharedTask.roleGuest')} · {t('sharedTask.sharingBadge')}</Text>
        </View>
        <View style={styles.managementRowActions}>
          {tab === 'joined' && <MainWindowActionButton density="compact" style={styles.managementButton} textStyle={styles.managementButtonText} action={{ label: t('sharedTask.enterTask'), disabled: busy, onPress: () => void run(current => openTask(item.sharedTaskId, current), false) }} />}
          <MainWindowActionButton density="compact" style={styles.managementButton} textStyle={styles.managementButtonText} action={{ label: t(tab === 'owned' ? 'sharedTask.manage' : 'sharedTask.leaveShort'), tone: tab === 'joined' ? 'danger' : undefined, disabled: busy, onPress: () => tab === 'owned' ? manageListed(item) : leaveListed(item) }} />
        </View>
      </View>)}</View>
      <Text style={styles.managementListNote}>{t(tab === 'owned' ? 'sharedTask.ownedManageIntro' : 'sharedTask.joinedManageIntro')}</Text>
      {tab === 'owned' && <View style={styles.managementDangerZone}>
        <Text style={styles.taskTitle}>{t('sharedTask.closeAllLabel')}</Text><Text style={styles.managementDangerDescription}>{t('sharedTask.closeAllDescription')}</Text>
        <MainWindowActionButton density="compact" style={styles.managementDangerButton} textStyle={styles.managementButtonText} action={{ label: t('sharedTask.closeAllLabel'), tone: 'danger', disabled: busy, onPress: () => closeTasks([...owned]) }} />
      </View>}
    </>}
    {manualOpen && <SharedTaskAdmissionDialog title={t('sharedTask.join')} onClose={() => { if (!pending.current) setManualOpen(false); }}>{invitationForm}</SharedTaskAdmissionDialog>}
  </>;
  return <SharedTaskScreen
    management={management && !guestId}
    title={t(ended ? 'sharedTask.ended' : management ? 'sharedTask.title' : !guestId && tab === 'owned' ? 'sharedTask.ownedTitle' : hostContext || guestId ? 'sharedTask.title' : 'sharedTask.join')}
    onClose={() => { clearSharedTaskInvitationIntent(); setIncomingLink(null); goBackGuarded(router, '/devices'); }}>
    {confirmation.dialog}
    {!isAuthenticated ? <Text style={styles.intro}>{t('sharedTask.login')}</Text> : ended ? <SharedTaskEndedState onReturnToTasks={() => {
      setJoinedId(undefined); setEnded(false); setState(null); setNotice(''); setLoadError('');
      router.replace('/devices');
    }} /> : link.sharedTaskAvailable !== true ? <Text style={styles.intro}>{t(link.sharedTaskAvailable === false ? 'sharedTask.upgrade' : 'sharedTask.retry')}</Text> : <>
      {!guestId && !management && <View style={styles.tabs}>
        <MainWindowRowButton accessibilityLabel={t(hostContext ? 'sharedTask.tabCurrent' : 'sharedTask.join')} selected={tab === 'current'} style={[styles.tab, tab === 'current' && styles.tabSelected]} onPress={() => { setNotice(''); setTab('current'); }}><Text style={styles.small}>{t(hostContext ? 'sharedTask.tabCurrent' : 'sharedTask.join')}</Text></MainWindowRowButton>
        <MainWindowRowButton accessibilityLabel={t('sharedTask.tabOwned')} selected={tab === 'owned'} style={[styles.tab, tab === 'owned' && styles.tabSelected]} onPress={() => { setNotice(''); setTab('owned'); }}><Text style={styles.small}>{t('sharedTask.tabOwned')}</Text><View style={styles.badge}><Text style={styles.metadata}>{owned.length}</Text></View></MainWindowRowButton>
      </View>}
      {!!notice && !manualOpen && <Text accessibilityRole="alert" style={styles.noticeText}>{notice}</Text>}
      {!!loadError && <View><Text accessibilityRole="alert" style={styles.noticeText}>{loadError}</Text><SharedTaskAction action={{ label: t('sharedTask.retryAction'), disabled: busy, onPress: () => void run(async current => { await load(current); if (current()) setLoadError(''); }, false) }} /></View>}
      {management && !guestId ? managementView : !guestId && tab === 'owned' ? owned.length === 0 ? <MainWindowEmptyState centered style={styles.ownedEmpty}
        testID="sharedTask.ownedEmpty" title={t('sharedTask.ownedEmptyTitle')} copy={t('sharedTask.ownedEmptyHint')}>
        {hostContext && <SharedTaskAction action={{ label: t('sharedTask.shareCurrent'), onPress: () => setTab('current') }} />}
      </MainWindowEmptyState> : <>
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
      </> : hostContext ? ownedTargetUnavailable ? <Text style={styles.intro}>{t('sharedTask.unavailable')}</Text> : !state ? <Text style={styles.intro}>{t('shared.syncing')}</Text> : !state.available ? <Text style={styles.intro}>{t('sharedTask.upgrade')}</Text> : !detail ? <>
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
            const invitationApp = APP_SCHEME === 'cindycn' ? 'cindycn' : APP_SCHEME === 'cindydev' ? 'cindydev' : 'cindy';
            const invitationLink = buildSharedTaskInvitationLink(result.invitation, DEVICE_LINK_API_BASE_URL, invitationApp);
            try { await writeClipboardText(t('sharedTask.invitationMessage', { title, link: invitationLink })); if (current()) setNotice(t('sharedTask.invitationCopied')); }
            catch { if (current()) setNotice(t('sharedTask.invitationCopyFailed')); }
          }, false) }} />
        </View>
        <Text style={styles.peopleTitle}>{t('sharedTask.membersWithLimit', { count: detail.memberLabels.length + 1 })}</Text>
        <View style={styles.person}><View style={styles.avatar}><Laptop size={iconSize.sm} color={colors.textTertiary} /></View><View style={styles.grow}><Text style={styles.personName}>{t('sharedTask.me')}</Text><Text style={styles.metadata}>{task?.deviceLinkDeviceName ?? t('sharedTask.hostDevice')}</Text></View><Text style={styles.smallMuted}>{t('sharedTask.roleHost')}</Text></View>
        {detail.memberLabels.map((member) => <View key={member.memberId} style={styles.person}><View style={styles.avatar}><Text style={styles.metadata}>{Array.from(member.displayName)[0]}</Text></View><View style={styles.grow}><Text style={styles.personName}>{member.displayName}</Text><Text style={styles.metadata}>{t('sharedTask.roleGuest')}</Text></View>
          <SharedTaskAction compact action={{ label: t('sharedTask.removeShort'), tone: 'danger', accessibilityLabel: t('sharedTask.removeNamedTitle', { name: member.displayName }), disabled: busy, onPress: () => confirm(t('sharedTask.removeNamedTitle', { name: member.displayName }), t('sharedTask.removeBody'), t('sharedTask.removeKeep'), t('sharedTask.remove'), async () => { await host({ action: 'remove', sharedTaskId: detail.sharedTaskId, memberId: member.memberId }); }) }} />
        </View>)}
        <View style={styles.noticeBox}><Clock size={iconSize.sm} color={colors.textTertiary} /><Text style={[styles.smallMuted, styles.grow]}>{t('sharedTask.remoteHostOfflineNote')}</Text></View>
        <View style={styles.footer}><SharedTaskAction grow action={{ label: t('sharedTask.closeCurrent'), tone: 'danger', disabled: busy, onPress: () => confirm(t('sharedTask.closeOneTitle'), t('sharedTask.closeOneBody'), t('sharedTask.closeAllKeep'), t('sharedTask.close'), async current => {
          await host({ action: 'close', sharedTaskId: detail.sharedTaskId });
          if (current() && mode === 'detail') goBackGuarded(router, { pathname: '/shared-session', params: { mode: 'manage' } });
        }) }} /></View>
      </> : <>
        <Text style={styles.intro}>{t('sharedTask.joinIntro')}</Text>
        <View style={styles.field}><Text style={styles.label}>{t('sharedTask.invitation')}</Text><TextInput accessibilityLabel={t('sharedTask.invitation')} placeholder={t('sharedTask.invitationPlaceholder')} placeholderTextColor={colors.textPlaceholder} style={[styles.input, styles.invitation]} value={invitation} onChangeText={(text) => { setIncomingLink(null); setInvitation(text); }} maxLength={8192} multiline textAlignVertical="top" autoCapitalize="none" autoCorrect={false} editable={!busy} /></View>
        <View style={styles.noticeBox}><Users size={iconSize.sm} color={colors.textTertiary} /><Text style={[styles.smallMuted, styles.grow]}>{t('sharedTask.joinNotice')}</Text></View>
        <View style={styles.footer}><SharedTaskAction grow action={{ label: t('sharedTask.join'), tone: 'primary', busy, disabled: !invitation.trim(), onPress: () => joinInvitation(invitation) }} /></View>
      </>}
    </>}
  </SharedTaskScreen>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  managementEmpty: { alignItems: 'center', paddingVertical: spacing.xxl * 2, paddingHorizontal: spacing.md },
  managementEmptyIcon: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill, marginBottom: spacing.lg + spacing.xs },
  managementHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: spacing.sm + spacing.xs, marginTop: spacing.sm, marginBottom: spacing.lg + spacing.xs },
  managementHeadingCopy: { flex: 1, minWidth: 160 },
  managementTitle: { color: colors.textPrimary, fontSize: typeScale.headline, lineHeight: lineHeight.headline, fontWeight: fontWeight.semibold },
  managementDescription: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginTop: spacing.sm },
  managementButton: { minHeight: 44, paddingHorizontal: spacing.md, backgroundColor: colors.surface, flexShrink: 0 },
  managementButtonText: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  managementTabs: { flexDirection: 'row', gap: spacing.lg + spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginBottom: spacing.xl },
  managementTab: { minHeight: 44, justifyContent: 'center', paddingBottom: spacing.md },
  managementTabLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  managementTabText: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  managementTabTextSelected: { color: colors.textPrimary },
  managementTabIndicator: { position: 'absolute', bottom: -StyleSheet.hairlineWidth, left: 0, right: 0, height: 2, backgroundColor: colors.textPrimary },
  managementList: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.container, overflow: 'hidden' },
  managementRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: spacing.lg, paddingHorizontal: spacing.md, gap: spacing.md },
  managementRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  managementTaskTitleTarget: { minHeight: 44, justifyContent: 'center' },
  managementMetadata: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, marginTop: spacing.xs },
  managementRowActions: { gap: spacing.xs, alignItems: 'flex-end' },
  managementListNote: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginTop: spacing.lg },
  managementDangerZone: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginTop: spacing.xxl, paddingTop: spacing.xl },
  managementDangerDescription: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginTop: spacing.xs },
  managementDangerButton: { minHeight: 44, marginTop: spacing.lg, backgroundColor: colors.surface },
  intro: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginBottom: spacing.lg },
  small: { color: colors.textPrimary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  smallMuted: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  taskTitle: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  metadata: { color: colors.textTertiary, fontSize: typeScale.micro, lineHeight: lineHeight.micro },
  caption: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginBottom: spacing.sm },
  noticeText: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginBottom: spacing.md },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, padding: spacing.md, marginVertical: spacing.sm },
  copyBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, padding: spacing.md, marginVertical: spacing.lg },
  noticeBox: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, backgroundColor: colors.surfaceChip, borderRadius: radius.control, padding: spacing.md, marginVertical: spacing.lg },
  tabs: { flexDirection: 'row', gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: spacing.md, marginBottom: spacing.lg },
  tab: { flex: 1, minHeight: 44, borderBottomWidth: 0, borderRadius: radius.pill, justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  tabSelected: { backgroundColor: colors.surfaceChip },
  badge: { borderRadius: radius.pill, backgroundColor: colors.surfaceChip, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  grow: { flex: 1 },
  field: { gap: spacing.xs, marginBottom: spacing.lg },
  label: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.textPrimary, backgroundColor: colors.surface, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  invitation: { minHeight: 82, borderRadius: radius.control },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingVertical: spacing.sm },
  personName: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  peopleTitle: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, marginTop: spacing.lg, marginBottom: spacing.xs },
  avatar: { width: 28, height: 28, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceChip, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingVertical: spacing.xl, paddingHorizontal: spacing.xs },
  ownedEmpty: { padding: spacing.xl, gap: spacing.md },
  largeIcon: { width: 44, height: 44, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  emptyTitle: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, textAlign: 'center' },
  emptyCopy: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center', maxWidth: 280, marginTop: spacing.sm, marginBottom: spacing.lg },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.lg },
  footer: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
});
