import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import type { useVoiceConversation } from './useVoiceConversation';

export function VoiceConversationBar({ conversation, notice }: { conversation: ReturnType<typeof useVoiceConversation>; notice?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  if (!conversation.visible) return notice ? <View style={styles.root}><Text style={styles.label}>{notice}</Text></View> : null;
  const paused = conversation.state === 'idle' || conversation.state === 'paused';
  return <View style={styles.root} testID="voiceConversation.bar">
    <Text style={styles.label} accessibilityLiveRegion="polite">
      {conversation.error ?? t(`session.voiceConversation.${conversation.state}`)}
    </Text>
    {conversation.state === 'listening' ? <Text style={styles.label}>{t('session.voiceConversation.autoSend')}</Text> : null}
    <View style={styles.actions}>
      {paused ? <MainWindowActionButton action={{ label: t('session.voiceConversation.resume'), onPress: conversation.resume }} density="compact" /> : null}
      {conversation.state === 'listening' ? <MainWindowActionButton action={{ label: t('session.voiceConversation.send'), onPress: conversation.submit }} density="compact" /> : null}
      <MainWindowActionButton action={{ label: t('session.voiceConversation.end'), onPress: conversation.stop }} density="compact" />
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surface },
  label: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
});
