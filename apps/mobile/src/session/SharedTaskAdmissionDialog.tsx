import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Compact invitation form; the management page stays mounted behind it. */
export function SharedTaskAdmissionDialog({ title, onClose, onShow, children }: {
  title: string; onClose(): void; onShow?(): void; children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return <Modal transparent visible animationType="fade" onRequestClose={onClose} onShow={onShow}>
    {/* Android Modal already resizes for the IME. A second height adjustment
        creates a layout loop while the invitation input is focused. */}
    <KeyboardAvoidingView style={styles.backdrop} enabled={Platform.OS === 'ios'} behavior="padding">
      <View style={styles.card} accessibilityViewIsModal testID="sharedTask.admissionDialog">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} bounces={false}>
          <Text style={styles.title} accessibilityRole="header">{title}</Text>
          {children}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.overlay },
  card: { width: '100%', maxWidth: 440, maxHeight: '85%', borderRadius: radius.container, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceElevated },
  content: { padding: spacing.lg },
  title: { fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold, color: colors.textPrimary, marginBottom: spacing.lg },
});
