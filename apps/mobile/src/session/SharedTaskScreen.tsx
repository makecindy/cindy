import { type ReactNode, type Ref } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, type View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MainWindowActionButton, type MainWindowAction } from '@/components/MobilePrimitives';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome/SimpleStackHeader';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';

/** Full-screen management; confirmations stay compact, with native material on iOS. */
export function SharedTaskScreen({ title, onClose, children }: {
  title: string; onClose(): void; children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.root}>
    <SimpleStackHeader title={title} onBack={onClose} />
    <KeyboardAvoidingView style={styles.body} enabled={Platform.OS === 'ios'} behavior="padding">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">{children}</ScrollView>
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
  action: { minHeight: 44, paddingHorizontal: spacing.lg },
  actionText: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  compactActionText: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  dangerText: { color: colors.sharedTaskConfirmBackground },
});
