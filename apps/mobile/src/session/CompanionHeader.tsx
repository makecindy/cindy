import { useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, PanelLeft, Settings2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteResource, type RemoteResourceRef } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { fontWeight, iconSize, iconStroke, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { TeammatePicker } from './TeammatePicker';
import { CompanionCreateSheet, CompanionProfileSheet } from './CompanionProfileSheet';
import { CompanionAutomationSheet } from './CompanionAutomationSheet';
import { useTeammateNavigation } from './useTeammateNavigation';

const AVATAR_SIZE = 32;

export function CompanionHeader(props: {
  resource: RemoteResource; deviceId: string; deviceName: string; online: boolean; onSearch(): void; onOpenNavigation(): void;
}) {
  const { accountGeneration } = useAuth();
  return <CompanionHeaderContent key={accountGeneration} {...props} />;
}
function CompanionHeaderContent({ resource, deviceId, deviceName, online, onSearch, onOpenNavigation }: Parameters<typeof CompanionHeader>[0]) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const navigation = useTeammateNavigation();
  const [picker, setPicker] = useState(false);
  const [profile, setProfile] = useState(false);
  const [automation, setAutomation] = useState(false);
  const [creating, setCreating] = useState(false);
  const created = useRef<RemoteResourceRef | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const name = resolveRemoteText(resource.display.title, i18n.language);
  const afterProfile = (action: () => void) => { pending.current = action; setProfile(false); };
  return <>
    <View style={styles.header} testID="companion.header">
      <HomeHeaderGlassButton testID="companion.navigation" accessibilityLabel={t('devices.companions.openNavigation')} onPress={() => { Keyboard.dismiss(); onOpenNavigation(); }}>
        <PanelLeft size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
      </HomeHeaderGlassButton>
      <Pressable style={styles.identity} accessibilityRole="button" accessibilityLabel={name} accessibilityHint={t('devices.companions.title')} onPress={() => setPicker(true)} testID="companion.picker">
        <RemoteCompanionAvatar avatar={resource.display.avatar} name={name} deviceId={deviceId} online={online} size={AVATAR_SIZE} />
        <Text numberOfLines={1} style={styles.name}>{name}</Text>
        <ChevronDown size={iconSize.sm} color={colors.textSecondary} />
      </Pressable>
      <HomeHeaderGlassButton testID="companion.settings" accessibilityLabel={t('devices.companionProfile.settingsTitle')} onPress={() => setProfile(true)}>
        <Settings2 size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
      </HomeHeaderGlassButton>
    </View>
    <TeammatePicker visible={picker} onClose={() => setPicker(false)} onSelect={item => void navigation.openTeammate(item)}
      onCreate={() => { created.current = null; setCreating(true); }}
      current={{ deviceId, collectionId: resource.ref.collectionId, resourceKind: 'bot', resourceId: resource.ref.id }} />
    <CompanionCreateSheet visible={creating} onClose={() => setCreating(false)} deviceId={deviceId} deviceName={deviceName}
      collectionId={resource.ref.collectionId} online={online} onCreated={ref => { created.current = ref; }}
      onClosed={() => { const ref = created.current; created.current = null; if (ref) void navigation.openCreatedTeammate({ deviceId, deviceName }, ref); }} />
    <CompanionProfileSheet visible={profile} onClose={() => setProfile(false)} onClosed={() => { const action = pending.current; pending.current = null; action?.(); }}
      resource={resource} collectionId={resource.ref.collectionId} deviceId={deviceId} deviceName={deviceName} online={online}
      onDeleted={() => void navigation.chooseMode('teammates')}
      onOpenSearch={() => afterProfile(onSearch)} onOpenAutomation={() => afterProfile(() => setAutomation(true))} />
    <CompanionAutomationSheet visible={automation} onClose={() => setAutomation(false)} collectionId="routines"
      botId={resource.ref.id} deviceId={deviceId} deviceName={deviceName} online={online} />
  </>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: spacing.md, paddingHorizontal: spacing.lg },
  identity: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.sm },
  name: { flexShrink: 1, fontSize: typeScale.subtitle, fontWeight: fontWeight.medium, color: colors.textPrimary },
});
