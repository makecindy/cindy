import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { showConfirm } from '@/platform/chrome/showActionMenu';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

type Confirmation = Parameters<typeof showConfirm>[0];

/** iOS owns native material; Android follows the shared-task dialog design tokens. */
export function useSharedTaskConfirmation() {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const cancelButton = useRef<View>(null);
  const styles = useThemedStyles(makeStyles);
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  const settle = useCallback((accepted: boolean) => {
    const resolve = resolver.current;
    resolver.current = null; setRequest(null); resolve?.(accepted);
  }, []);
  const confirm = useCallback((next: Confirmation): Promise<boolean> => {
    if (Platform.OS === 'ios') return showConfirm(next);
    if (resolver.current) return Promise.resolve(false);
    return new Promise((resolve) => { resolver.current = resolve; setRequest(next); });
  }, []);
  const dialog = request ? <Modal transparent animationType="fade" visible
    onRequestClose={() => settle(false)}
    onShow={() => { const handle = findNodeHandle(cancelButton.current); if (handle) AccessibilityInfo.setAccessibilityFocus(handle); }}>
    <View style={styles.backdrop} testID="sharedTask.confirmBackdrop">
      <View style={styles.card} accessibilityViewIsModal testID="sharedTask.confirmDialog">
        <ScrollView style={styles.content} contentContainerStyle={styles.copy} bounces={false}>
          <Text style={styles.title} accessibilityRole="header">{request.title}</Text>
          {!!request.message && <Text style={styles.body}>{request.message}</Text>}
        </ScrollView>
        <View style={styles.actions}>
          <MainWindowActionButton density="compact" buttonRef={cancelButton} style={styles.button}
            action={{ label: request.cancelLabel, onPress: () => settle(false), testID: 'sharedTask.confirmCancel' }} />
          <MainWindowActionButton density="compact" style={styles.button}
            action={{ label: request.confirmLabel, tone: request.destructive ? 'danger-solid' : 'primary', onPress: () => settle(true), testID: 'sharedTask.confirmAccept' }} />
        </View>
      </View>
    </View>
  </Modal> : null;
  return { confirm, dialog };
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.overlay, padding: spacing.xl },
  card: { width: '100%', maxWidth: 400, maxHeight: '80%', backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, padding: spacing.lg, gap: spacing.lg },
  content: { flexGrow: 0, flexShrink: 1 },
  copy: { gap: spacing.md },
  title: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.semibold, lineHeight: lineHeight.title },
  body: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: { minHeight: 44, minWidth: 120, flexGrow: 1, flexShrink: 0 },
});
