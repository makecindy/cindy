import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { meetingHostPeer, parseMeetingPeer, SESSION_MEETING_HOST_CHANNEL,
  type SessionMeetingHostCommand, type SessionMeetingHostState, type SessionMeetingListItem } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { goBackGuarded } from '@/utils/backGuard';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useSessionMeetingApi } from '@/device-link/useSessionMeetingApi';
import { sessionMeetingErrorKey } from '@/device-link/sessionMeetingCompatibility';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton, MainWindowRowButton } from '@/components/MobilePrimitives';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome/SimpleStackHeader';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { writeClipboardText } from '@/session/messageActions';
import type { RemoteSession } from '@/session/types';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

/** Invitation/account UI only; conversation and input reuse the ordinary remote task screen. */
export default function SharedSessionScreen() {
  const { sessionId, deviceId } = useLocalSearchParams<{ sessionId?: string; deviceId?: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { isAuthenticated, accountGeneration } = useAuth();
  const api = useSessionMeetingApi();
  const link = useDeviceLink();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [invitation, setInvitation] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<SessionMeetingHostState | null>(null);
  const [tasks, setTasks] = useState<SessionMeetingListItem[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const peer = deviceId ? parseMeetingPeer(deviceId) : null;
  const guestId = peer?.role === 'host' ? peer.meetingId : undefined;
  const host = useCallback((command: SessionMeetingHostCommand) => link.invoke(deviceId!, SESSION_MEETING_HOST_CHANNEL, [command]), [deviceId, link.invoke]);
  const load = useCallback(async () => {
    const captured = epoch.current;
    const owner = getMobileAuthOwner();
    if (!isAuthenticated || link.sessionMeetingAvailable !== true) return;
    if (sessionId && deviceId) {
      const value = guestId ? { available: true, detail: await api.get(guestId) }
        : await host({ action: 'state', sessionId }) as SessionMeetingHostState;
      if (mounted.current && captured === epoch.current && isMobileAuthOwnerCurrent(owner)) setState(value);
    } else {
      const value = (await api.list()).filter((task) => task.ownerAccountId !== owner.accountId);
      if (mounted.current && captured === epoch.current && isMobileAuthOwnerCurrent(owner)) setTasks(value);
    }
  }, [api, deviceId, guestId, host, isAuthenticated, link.sessionMeetingAvailable, sessionId]);
  useEffect(() => {
    mounted.current = true;
    epoch.current++; pending.current = false; setBusy(false);
    setState(null); setTasks([]); setInvitation(''); setName(''); setNotice('');
    return () => { mounted.current = false; epoch.current++; };
  }, [accountGeneration, deviceId, sessionId]);
  useEffect(() => {
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (disposed || polling || pending.current) return;
      polling = true;
      const owner = getMobileAuthOwner();
      try {
        await load();
        if (!disposed && isMobileAuthOwnerCurrent(owner)) setNotice('');
      } catch (error) {
        if (!disposed && isMobileAuthOwnerCurrent(owner)) {
          const key = sessionMeetingErrorKey(error);
          if (key === 'sessionMeeting.upgrade' && sessionId) setState({ available: false, detail: null });
          else setNotice(t(key));
        }
      }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 5_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [accountGeneration, load, sessionId, t]);
  const run = async (work: (current: () => boolean) => Promise<void>, reload = true) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice('');
    const owner = getMobileAuthOwner();
    const captured = epoch.current;
    const current = () => mounted.current && captured === epoch.current && isMobileAuthOwnerCurrent(owner);
    if (link.sessionMeetingAvailable !== true) {
      setNotice(t(link.sessionMeetingAvailable === false ? 'sessionMeeting.upgrade' : 'sessionMeeting.retry'));
      pending.current = false; setBusy(false); return;
    }
    try { await work(current); if (reload && current()) await load(); }
    catch (error) { if (current()) setNotice(t(sessionMeetingErrorKey(error))); }
    finally { if (captured === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const openTask = async (meetingId: string, current: () => boolean) => {
    const detail = await api.get(meetingId);
    if (!current()) return;
    const target = meetingHostPeer(meetingId);
    await link.openLink(target);
    if (!current()) return;
    const task = await link.invoke<RemoteSession>(target, 'local-db:sessions:get', [detail.sessionId]);
    if (!current() || task.id !== detail.sessionId) return;
    remoteSessionStore.setDeviceSessions(target, detail.title, [task]);
    router.replace({ pathname: '/sessions/[sessionId]', params: { sessionId: detail.sessionId, deviceId: target, deviceName: detail.title } });
  };
  const detail = state?.detail?.status === 'active' ? state.detail : null;
  return <SafeAreaView style={styles.page} edges={simpleScreenSafeAreaEdges()}>
    <SimpleStackHeader title={t(sessionId ? 'sessionMeeting.title' : 'sessionMeeting.join')} onBack={() => goBackGuarded(router)} />
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      {!!notice && <Text accessibilityRole="alert" style={styles.text}>{notice}</Text>}
      {!isAuthenticated ? <Text style={styles.text}>{t('sessionMeeting.login')}</Text> : link.sessionMeetingAvailable !== true ? <Text style={styles.text}>{t(link.sessionMeetingAvailable === false ? 'sessionMeeting.upgrade' : 'sessionMeeting.retry')}</Text> : sessionId && deviceId ? <>
        {!state ? <Text style={styles.text}>{t('sessionMeeting.sharing')}</Text> : !state.available ? <Text style={styles.text}>{t('sessionMeeting.upgrade')}</Text> : !detail ?
          !guestId && <><Text style={styles.text}>{t('sessionMeeting.sharing')}</Text><MainWindowActionButton action={{ label: t('sessionMeeting.open'), busy: busy, onPress: () => void run(async () => { await host({ action: 'open', sessionId }); }) }} /></> : <>
          <Text style={styles.text}>{t('sessionMeeting.host')}</Text>
          {detail.memberLabels.map((member) => <View key={member.memberId} style={styles.member}>
            <Text style={styles.text}>{member.displayName}</Text>
            {!guestId && <MainWindowActionButton action={{ label: t('sessionMeeting.remove'), disabled: busy, onPress: () => void run(async () => { await host({ action: 'remove', meetingId: detail.meetingId, memberId: member.memberId }); }) }} />}
          </View>)}
          {guestId ? <MainWindowActionButton action={{ label: t('sessionMeeting.leave'), disabled: busy, onPress: () => void run(async (current) => {
            await api.leave(guestId); if (current()) { link.closeLink(deviceId); remoteSessionStore.removeDevice(deviceId); router.replace('/devices'); }
          }, false) }} /> : <>
            <MainWindowActionButton action={{ label: t('sessionMeeting.invite'), disabled: busy, onPress: () => void run(async (current) => {
              const result = await host({ action: 'invite', meetingId: detail.meetingId }) as { invitation: string };
              if (current()) { await writeClipboardText(result.invitation); if (current()) setNotice(t('sessionMeeting.invitationCopied')); }
            }) }} />
            <MainWindowActionButton action={{ label: t('sessionMeeting.close'), disabled: busy, onPress: () => void run(async () => { await host({ action: 'close', meetingId: detail.meetingId }); }) }} />
          </>}
        </>}
      </> : <>
        <Text style={styles.text}>{t('sessionMeeting.joinHint')}</Text>
        <TextInput accessibilityLabel={t('sessionMeeting.invitation')} placeholder={t('sessionMeeting.invitation')} placeholderTextColor={colors.textTertiary}
          style={styles.input} value={invitation} onChangeText={setInvitation} autoCapitalize="none" autoCorrect={false} editable={!busy} />
        <TextInput accessibilityLabel={t('sessionMeeting.nickname')} placeholder={t('sessionMeeting.nickname')} placeholderTextColor={colors.textTertiary}
          style={styles.input} value={name} onChangeText={setName} maxLength={128} editable={!busy} />
        <MainWindowActionButton action={{ label: t('sessionMeeting.requestJoin'), busy: busy, disabled: !invitation.trim() || !name.trim(), onPress: () => void run(async (current) => {
          if (!/^[A-Za-z0-9_-]{43}$/.test(invitation.trim())) { setNotice(t('sessionMeeting.invalid')); return; }
          const joined = await api.join(invitation.trim(), name.trim());
          if (current()) { setInvitation(''); await openTask(joined.meetingId, current); }
        }, false) }} />
        {tasks.map((task) => <MainWindowRowButton key={task.meetingId} accessibilityLabel={task.title} disabled={busy}
          onPress={() => void run((current) => openTask(task.meetingId, current), false)}><Text style={styles.text}>{task.title}</Text></MainWindowRowButton>)}
      </>}
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface },
  body: { padding: spacing.lg, gap: spacing.md },
  text: { color: colors.textPrimary, fontSize: typeScale.body },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    borderRadius: radius.pill, paddingHorizontal: spacing.lg, color: colors.textPrimary,
    backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  member: { gap: spacing.sm },
});
