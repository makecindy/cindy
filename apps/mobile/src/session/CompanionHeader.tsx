import { ListTodo } from 'lucide-react-native';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { CompanionTodos } from './CompanionTodos';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteResource } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { radius, spacing, iconSize, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { CHAT_HEADER_GLYPH_STROKE, CHAT_HEADER_MARK_SIZE, ChatIdentityHeader, ChatIdentitySubtitle } from './ChatIdentityHeader';
import { CompanionPresenceRing } from './CompanionPresenceRing';
import { CompanionProfileSheet } from './CompanionProfileSheet';
import { useTeammateNavigation } from './useTeammateNavigation';
import { CloudHomeSwitchSheet } from './CloudHomeSwitchSheet';
import { useCloudCompanionHome } from '@/chat/useCloudCompanion';

/** Presence dot before the computer name (the list's dot, sized for a 12pt line). */
const PRESENCE_DOT = 6;

/**
 * 伙伴私聊顶栏（C1，与群聊顶栏同一个 ChatIdentityHeader）：返回 + 身份（32 头像、名字、在线点与
 * 电脑名）+ 伙伴设置；宿主提供 Todo 能力时增加独立入口。点身份区与设置按钮都打开
 * 伙伴资料；切换伙伴回到列表里做。
 */
export function CompanionHeader(props: {
  resource: RemoteResource; deviceId: string; deviceName: string; online: boolean; controlsReady?: boolean;
  /** The companion is working on a reply (the avatar breathes). */
  working?: boolean;
  settingsRequest?: { page: 'memory' | 'capabilities'; sequence: number };
  onSearch(): void; onBack(): void;
}) {
  const { accountGeneration } = useAuth();
  return <CompanionHeaderContent key={accountGeneration} {...props} />;
}

function CompanionHeaderContent({ resource, deviceId, deviceName, online, controlsReady = true, working = false, onSearch, onBack, settingsRequest }: Parameters<typeof CompanionHeader>[0]) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const {colors}=useTheme();
  const navigation = useTeammateNavigation();
  // A cloud companion is one teammate wherever it runs: name its main computer and offer to change it.
  const cloud = useCloudCompanionHome(true);
  const homed = cloud.supported && cloud.actors.some(actor => actor.kind === 'bot' && actor.externalId === resource.ref.id && actor.homeDeviceId === deviceId);
  const [homeSheet, setHomeSheet] = useState(false);
  const [profile, setProfile] = useState(false);
  const [todos, setTodos] = useState(false);
  const [initialPage, setInitialPage] = useState<'home' | 'memory' | 'capabilities'>('home');
  useEffect(() => { if (settingsRequest) { setInitialPage(settingsRequest.page); setProfile(true); } }, [settingsRequest]);
  const pending = useRef<(() => void) | null>(null);
  const name = resolveRemoteText(resource.display.title, i18n.language);
  const afterProfile = (action: () => void) => { pending.current = action; setProfile(false); };
  // A cloud companion does not show its computer's presence (it belongs to the account, like an IM
  // contact); a message that cannot get through is what asks to switch computers.
  const connection = online || homed ? '' : t('devices.resources.hostOffline');
  return <>
    <ChatIdentityHeader testIDPrefix="companion"
      mark={<>
        <RemoteCompanionAvatar avatar={resource.display.avatar} name={name} deviceId={deviceId} online={online} size={CHAT_HEADER_MARK_SIZE} framed />
        <CompanionPresenceRing active={working} width={1.5} />
      </>}
      title={name}
      subtitle={<View style={styles.subtitleRow}>
        {homed ? null : <View style={[styles.presence, online ? styles.presenceOn : styles.presenceOff]} testID="companion.header.presence" />}
        <ChatIdentitySubtitle>{[connection, homed ? t('devices.cloudCompanion.runsOn', { device: deviceName }) : deviceName].filter(Boolean).join(' · ')}</ChatIdentitySubtitle>
      </View>}
      identityLabel={[name, deviceName, connection].filter(Boolean).join(', ')}
      identityHint={t('devices.companions.openProfile', { name })}
      controlsReady={controlsReady}
      onBack={onBack}
      onOpenSettings={() => { setInitialPage('home'); setProfile(true); }}
      accessory={resource.links?.some(link=>link.target.kind==='resource'&&link.target.ref.id==='todos:'+resource.ref.id)?<HomeHeaderGlassButton testID="companion.todos.open" disabled={!controlsReady} accessibilityLabel={t('devices.teammateTodo.title')} onPress={()=>setTodos(true)}><ListTodo size={iconSize.lg} strokeWidth={CHAT_HEADER_GLYPH_STROKE} color={colors.textPrimary}/></HomeHeaderGlassButton>:undefined}
      settingsLabel={t('devices.companionProfile.settingsTitle')} />
    <CompanionTodos visible={todos} onClose={()=>setTodos(false)} botId={resource.ref.id} deviceId={deviceId} deviceName={deviceName} online={online}/>
    <CompanionProfileSheet initialPage={initialPage} visible={profile} onClose={() => setProfile(false)} onClosed={() => { const action = pending.current; pending.current = null; action?.(); }}
      resource={resource} collectionId={resource.ref.collectionId} deviceId={deviceId} deviceName={deviceName} online={online}
      onDeleted={() => void navigation.chooseMode('teammates')}
      onOpenSearch={() => afterProfile(onSearch)}
      {...(homed && online ? { onOpenHome: () => afterProfile(() => setHomeSheet(true)) } : {})} />
    {homed ? <CloudHomeSwitchSheet visible={homeSheet} onClose={() => setHomeSheet(false)} botId={resource.ref.id} name={name}
      homeDeviceId={deviceId} homeName={deviceName}
      onMoved={() => { setHomeSheet(false); void navigation.chooseMode('teammates'); }} /> : null}
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  presence: { width: PRESENCE_DOT, height: PRESENCE_DOT, borderRadius: radius.pill },
  // Same tones as the list's StatusDot: ready when connected, the quiet border tone when not.
  presenceOn: { backgroundColor: colors.statusReady },
  presenceOff: { backgroundColor: colors.borderStrong },
});
