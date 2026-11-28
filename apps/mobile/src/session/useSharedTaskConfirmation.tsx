import type { ViewInstance } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, findNodeHandle, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { showConfirm } from '@/platform/chrome/showActionMenu';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { ScrollFade, ScrollThumb, useScrollOverflow } from '@/components/ScrollOverflow';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** A confirmation, or (no `cancelLabel`) a notice with one button that only closes it. */
type Confirmation = Omit<Parameters<typeof showConfirm>[0], 'cancelLabel'> & { cancelLabel?: string };

/** iOS owns native material; Android follows the shared-task dialog design tokens. */
export function useSharedTaskConfirmation() {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const cancelButton = useRef<ViewInstance>(null);
  const styles = useThemedStyles(makeStyles), { colors } = useTheme();
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  const settle = useCallback((accepted: boolean) => {
    const resolve = resolver.current;
    resolver.current = null; setRequest(null); resolve?.(accepted);
  }, []);
  const confirm = useCallback((next: Confirmation): Promise<boolean> => {
    if (Platform.OS === 'ios') {
      if (next.cancelLabel !== undefined) return showConfirm({ ...next, cancelLabel: next.cancelLabel });
      return new Promise((resolve) => Alert.alert(next.title, next.message, [{ text: next.confirmLabel, onPress: () => { next.onConfirm?.(); resolve(true); } }],
        { cancelable: true, onDismiss: () => resolve(false) }));
    }
    if (resolver.current) return Promise.resolve(false);
    return new Promise((resolve) => { resolver.current = resolve; setRequest(next); });
  }, []);
  const dialog = request ? <Modal transparent animationType="fade" visible
    onRequestClose={() => settle(false)}
    onShow={() => { const handle = findNodeHandle(cancelButton.current); if (handle) AccessibilityInfo.setAccessibilityFocus(handle); }}>
    <View style={styles.backdrop} testID="sharedTask.confirmBackdrop">
      <View style={styles.card} accessibilityViewIsModal testID="sharedTask.confirmDialog">
        <ConfirmationCopy title={request.title} message={request.message} styles={styles} surface={colors.surfaceElevated} />
        <View style={styles.actions}>
          {request.cancelLabel !== undefined ? <MainWindowActionButton density="compact" buttonRef={cancelButton} style={styles.button}
            action={{ label: request.cancelLabel, onPress: () => settle(false), testID: 'sharedTask.confirmCancel' }} /> : null}
          <MainWindowActionButton density="compact" style={styles.button}
            action={{ label: request.confirmLabel, tone: request.destructive ? 'danger-solid' : 'primary', onPress: () => { request.onConfirm?.(); settle(true); }, testID: 'sharedTask.confirmAccept' }} />
        </View>
      </View>
    </View>
  </Modal> : null;
  return { confirm, dialog };
}

/**
 * The title and message, scrolling above the buttons. When they do not fit, a fade over the lower edge and a scroll thumb
 * that stays visible say there is more, in light and dark mode (dispatcher Q-4: a German notice at the largest text size
 * on a short screen showed only half a last line).
 */
function ConfirmationCopy({ title, message, styles, surface }: { title: string; message?: string; styles: ReturnType<typeof makeStyles>; surface: string }) {
  const copy = useScrollOverflow();
  return (
    <View style={styles.content}>
      <ScrollView style={styles.content} contentContainerStyle={[styles.copy, copy.thumbGutter]} bounces={false} showsVerticalScrollIndicator={false} testID="sharedTask.confirmCopy"
        onLayout={copy.onLayout} onContentSizeChange={copy.onContentSizeChange} onScroll={copy.onScroll} scrollEventThrottle={64}>
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {!!message && <Text style={styles.body}>{message}</Text>}
      </ScrollView>
      {copy.more ? <ScrollFade testID="sharedTask.confirmFade" color={surface} height={COPY_FADE_HEIGHT} /> : null}
      <ScrollThumb overflow={copy} testID="sharedTask.confirmThumb" />
    </View>
  );
}
const COPY_FADE_HEIGHT = 24;

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
