import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteResource } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { radius, spacing, useThemedStyles, type ThemeColors } from '@/theme';
import { CHAT_HEADER_MARK_SIZE, ChatIdentityHeader, ChatIdentitySubtitle } from './ChatIdentityHeader';
import { CompanionPresenceRing } from './CompanionPresenceRing';
import { CompanionProfileSheet } from './CompanionProfileSheet';
import { useTeammateNavigation } from './useTeammateNavigation';

/** Presence dot before the computer name (the list's dot, sized for a 12pt line). */
const PRESENCE_DOT = 6;

/**
 * 伙伴私聊顶栏（C1，与群聊顶栏同一个 ChatIdentityHeader）：返回 + 身份（32 头像、名字、在线点与
 * 电脑名）+ 伙伴设置。点身份区与设置按钮都打开伙伴资料；切换伙伴回到列表里做。
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
  const navigation = useTeammateNavigation();
  const [profile, setProfile] = useState(false);
  const [initialPage, setInitialPage] = useState<'home' | 'memory' | 'capabilities'>('home');
  useEffect(() => { if (settingsRequest) { setInitialPage(settingsRequest.page); setProfile(true); } }, [settingsRequest]);
  const pending = useRef<(() => void) | null>(null);
  const name = resolveRemoteText(resource.display.title, i18n.language);
  const afterProfile = (action: () => void) => { pending.current = action; setProfile(false); };
  const connection = online ? '' : t('devices.resources.hostOffline');
  return <>
    <ChatIdentityHeader testIDPrefix="companion"
      mark={<>
        <RemoteCompanionAvatar avatar={resource.display.avatar} name={name} deviceId={deviceId} online={online} size={CHAT_HEADER_MARK_SIZE} framed />
        <CompanionPresenceRing active={working} width={1.5} />
      </>}
      title={name}
      subtitle={<View style={styles.subtitleRow}>
        <View style={[styles.presence, online ? styles.presenceOn : styles.presenceOff]} testID="companion.header.presence" />
        <ChatIdentitySubtitle>{connection ? `${connection} · ${deviceName}` : deviceName}</ChatIdentitySubtitle>
      </View>}
      identityLabel={[name, deviceName, connection].filter(Boolean).join(', ')}
      identityHint={t('devices.companions.openProfile', { name })}
      controlsReady={controlsReady}
      onBack={onBack}
      onOpenSettings={() => { setInitialPage('home'); setProfile(true); }}
      settingsLabel={t('devices.companionProfile.settingsTitle')} />
    <CompanionProfileSheet initialPage={initialPage} visible={profile} onClose={() => setProfile(false)} onClosed={() => { const action = pending.current; pending.current = null; action?.(); }}
      resource={resource} collectionId={resource.ref.collectionId} deviceId={deviceId} deviceName={deviceName} online={online}
      onDeleted={() => void navigation.chooseMode('teammates')}
      onOpenSearch={() => afterProfile(onSearch)} />
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  presence: { width: PRESENCE_DOT, height: PRESENCE_DOT, borderRadius: radius.pill },
  // Same tones as the list's StatusDot: ready when connected, the quiet border tone when not.
  presenceOn: { backgroundColor: colors.statusReady },
  presenceOff: { backgroundColor: colors.borderStrong },
});
