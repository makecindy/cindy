import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteResource } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import type { TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { radius, spacing, useThemedStyles, type ThemeColors } from '@/theme';
import { CHAT_HEADER_MARK_SIZE, ChatIdentityHeader, ChatIdentitySubtitle } from './ChatIdentityHeader';
import { CompanionGlanceSheet } from './CompanionGlanceSheet';
import { dueTodos, useCompanionGlanceTodos, useGlanceDueSeen } from './useCompanionGlanceTodos';
import { CompanionPresenceRing } from './CompanionPresenceRing';
import { CompanionProfileSheet } from './CompanionProfileSheet';
import { useTeammateNavigation } from './useTeammateNavigation';
import { CloudHomeSwitchSheet } from './CloudHomeSwitchSheet';
import { useCloudCompanionHome } from '@/chat/useCloudCompanion';
import { useRouter } from 'expo-router';

/** Presence dot before the computer name (the list's dot, sized for a 12pt line). */
const PRESENCE_DOT = 6;
/** Due-todo dot on the avatar's top-right, the same dot as the due row in 近况. */
const DUE_DOT = 7;

/**
 * 伙伴私聊顶栏（C1，与群聊顶栏同一个 ChatIdentityHeader）：返回 + 身份（32 头像、名字、在线点与
 * 电脑名）+ 伙伴设置。点身份区打开伙伴近况（电脑 / 待办 / 输出内容），设置按钮打开伙伴资料；
 * 有没看过的到期待办时头像右上亮小红点，打开近况即灭。
 */
export function CompanionHeader(props: {
  nativeHeader?: boolean;
  resource: RemoteResource; deviceId: string; deviceName: string; online: boolean; controlsReady?: boolean;
  /** The companion is working on a reply (the avatar breathes). */
  working?: boolean;
  settingsRequest?: { page: 'memory' | 'capabilities'; sequence: number };
  /** The teammate's conversation (this chat), whose delegations carry 近况's outputs. */
  sessionId: string;
  /** Put a todo into this chat's composer as a reference; the owner then tells the teammate what to do. */
  onQuoteTodo(todo: TeammateTodo): void;
  /** Say something to the teammate as the owner: sent right away when the composer is empty, otherwise put into it. */
  onAskCompanion(text: string): void;
  /** The composer can take that line now (writable and its draft restored); otherwise 「帮我查查」 is disabled. */
  askCompanionReady?: boolean;
  onSearch(): void; onBack(): void;
}) {
  const { accountGeneration } = useAuth();
  return <CompanionHeaderContent key={accountGeneration} {...props} />;
}

function CompanionHeaderContent({ nativeHeader, resource, deviceId, deviceName, online, controlsReady = true, working = false, sessionId, onQuoteTodo, onAskCompanion, askCompanionReady = true, onSearch, onBack, settingsRequest }: Parameters<typeof CompanionHeader>[0]) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const navigation = useTeammateNavigation();
  const router = useRouter();
  // A cloud companion is one teammate wherever it runs: name its main computer and offer to change it.
  const cloud = useCloudCompanionHome(true);
  const homed = cloud.supported && cloud.actors.some(actor => actor.kind === 'bot' && actor.externalId === resource.ref.id && actor.homeDeviceId === deviceId);
  const [homeSheet, setHomeSheet] = useState(false);
  const [profile, setProfile] = useState(false);
  const [glance, setGlance] = useState(false);
  // Older hosts do not advertise todos; their 近况 simply has no todo section.
  const todosOffered = !!resource.links?.some(link => link.target.kind === 'resource' && link.target.ref.id === 'todos:' + resource.ref.id);
  const todos = useCompanionGlanceTodos({ deviceId, deviceName, botId: resource.ref.id, enabled: todosOffered && online });
  const due = dueTodos(todos.todos);
  const dueSeen = useGlanceDueSeen({ deviceId, botId: resource.ref.id }, due);
  const [initialPage, setInitialPage] = useState<'home' | 'memory' | 'capabilities'>('home');
  useEffect(() => { if (settingsRequest) { setInitialPage(settingsRequest.page); setProfile(true); } }, [settingsRequest]);
  const pending = useRef<(() => void) | null>(null);
  const name = resolveRemoteText(resource.display.title, i18n.language);
  const afterProfile = (action: () => void) => { pending.current = action; setProfile(false); };
  // A cloud companion does not show its computer's presence (it belongs to the account, like an IM
  // contact); a message that cannot get through is what asks to switch computers.
  const connection = online || homed ? '' : t('devices.resources.hostOffline');
  return <>
    <ChatIdentityHeader testIDPrefix="companion" nativeHeader={nativeHeader}
      mark={<>
        <RemoteCompanionAvatar avatar={resource.display.avatar} name={name} deviceId={deviceId} online={online} size={CHAT_HEADER_MARK_SIZE} framed />
        <CompanionPresenceRing active={working} width={1.5} />
        {dueSeen.unseen ? <View style={styles.dueDot} testID="companion.header.dueDot" /> : null}
      </>}
      title={name}
      subtitle={<View style={styles.subtitleRow}>
        {homed ? null : <View style={[styles.presence, online ? styles.presenceOn : styles.presenceOff]} testID="companion.header.presence" />}
        <ChatIdentitySubtitle>{[connection, homed ? t('devices.cloudCompanion.runsOn', { device: deviceName }) : deviceName].filter(Boolean).join(' · ')}</ChatIdentitySubtitle>
      </View>}
      identityLabel={[name, deviceName, connection, dueSeen.unseen ? t('devices.glance.dueUnseen') : ''].filter(Boolean).join(', ')}
      identityHint={t('devices.glance.open', { name })}
      controlsReady={controlsReady}
      onBack={onBack}
      onOpenIdentity={() => { setGlance(true); dueSeen.markSeen(); void todos.refresh(); }}
      onOpenSettings={() => { setInitialPage('home'); setProfile(true); }}
      settingsLabel={t('devices.companionProfile.settingsTitle')} />
    <CompanionGlanceSheet visible={glance} onClose={() => setGlance(false)} name={name} avatar={resource.display.avatar} botId={resource.ref.id}
      deviceId={deviceId} deviceName={deviceName} sessionId={sessionId} online={online} cloudHome={homed} todos={todos}
      onQuoteTodo={onQuoteTodo}
      onCheckTodos={askCompanionReady ? () => onAskCompanion(t('devices.glance.checkPrompt')) : undefined}
      onOpenTask={taskId => router.push({ pathname: '/sessions/[sessionId]', params: { sessionId: taskId, deviceId } })}
      onOpenCindy={hosted => void navigation.openTeammate(hosted, { replace: true })}
      onSwitchHome={() => setHomeSheet(true)} />
    <CompanionProfileSheet initialPage={initialPage} visible={profile} onClose={() => setProfile(false)} onClosed={() => { const action = pending.current; pending.current = null; action?.(); }}
      resource={resource} collectionId={resource.ref.collectionId} deviceId={deviceId} deviceName={deviceName} online={online}
      onDeleted={() => navigation.returnHome()}
      onOpenSearch={() => afterProfile(onSearch)}
      {...(homed && online ? { onOpenHome: () => afterProfile(() => setHomeSheet(true)) } : {})} />
    {homed ? <CloudHomeSwitchSheet visible={homeSheet} onClose={() => setHomeSheet(false)} botId={resource.ref.id} name={name}
      homeDeviceId={deviceId} homeName={deviceName}
      onMoved={() => { setHomeSheet(false); navigation.returnHome(); }} /> : null}
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  presence: { width: PRESENCE_DOT, height: PRESENCE_DOT, borderRadius: radius.pill },
  // Same tones as the list's StatusDot: ready when connected, the quiet border tone when not.
  presenceOn: { backgroundColor: colors.statusReady },
  presenceOff: { backgroundColor: colors.borderStrong },
  dueDot: {
    position: 'absolute', top: -1, right: -1, width: DUE_DOT, height: DUE_DOT, borderRadius: radius.pill,
    backgroundColor: colors.statusError,
  },
});
