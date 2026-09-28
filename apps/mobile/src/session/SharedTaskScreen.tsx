import { type ReactNode, type Ref } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MainWindowActionButton, ScreenBackButton, type MainWindowAction } from '@/components/MobilePrimitives';
import { Text } from '@/components/AppText';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome/SimpleStackHeader';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Full-screen management; confirmations stay compact, with native material on iOS. */
export function SharedTaskScreen({ title, onClose, children, management = false }: {
  title: string; onClose(): void; children: ReactNode; management?: boolean;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.root}>
    {(!management || Platform.OS === 'ios') && <SimpleStackHeader title={management ? t('settings.title') : title} onBack={onClose} />}
    <KeyboardAvoidingView style={styles.body} enabled={Platform.OS === 'ios'} behavior="padding">
      <ScrollView contentContainerStyle={[styles.content, management && styles.managementContent]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {management && Platform.OS !== 'ios' && <View style={styles.managementNavigation}>
          <ScreenBackButton onPress={onClose} style={styles.managementBack} testID="sharedTask.backToSettings" />
          <Text style={styles.navigationLabel}>{t('settings.title')}</Text>
        </View>}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

export function SharedTaskAction({ action, grow = false, compact = false, buttonRef }: { action: MainWindowAction; grow?: boolean; compact?: boolean; buttonRef?: Ref<View> }) {
  const styles = useThemedStyles(makeStyles);
  return <MainWindowActionButton action={action} grow={grow} buttonRef={buttonRef} density="compact" style={styles.action} textStyle={[compact ? styles.compactActionText : styles.actionText, action.tone === 'danger' && styles.dangerText]} />;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  body: { flex: 1 },
  content: { padding: spacing.lg },
  managementContent: { paddingHorizontal: spacing.lg + spacing.xs, paddingTop: 0, paddingBottom: spacing.xxl },
  managementNavigation: { height: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginLeft: -spacing.sm, marginBottom: spacing.xl },
  managementBack: { width: 44, height: 44, marginLeft: 0, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill },
  navigationLabel: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  action: { minHeight: 44, paddingHorizontal: spacing.lg },
  actionText: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  compactActionText: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  dangerText: { color: colors.sharedTaskConfirmBackground },
});
