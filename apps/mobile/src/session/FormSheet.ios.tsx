import { useRef } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { ScreenStack, ScreenStackItem } from 'react-native-screens';
import { spacing, useTheme } from '@/theme';
import type { FormSheetProps } from './FormSheet';

/** A single native stack owns presentation and touch handling. */
export function FormSheet({
  visible, title, onClose, onClosed, onShow, preventDismiss = false,
  leadingAction, trailingAction, children, testID,
}: FormSheetProps) {
  const { mode, colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const presented = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const finishClose = () => {
    if (!presented.current) return;
    presented.current = false;
    onClosed?.();
  };
  return (
    <ScreenStack style={[styles.anchor, visible && { width, height }]} pointerEvents="box-none"
      onFinishTransitioning={() => { if (!visible) finishClose(); }}>
      <ScreenStackItem screenId="form-sheet-anchor" activityState={2}
        pointerEvents="none" style={StyleSheet.absoluteFill} headerConfig={{ hidden: true }} />
      {visible ? <ScreenStackItem
          stackPresentation="pageSheet"
          gestureEnabled={!preventDismiss}
          preventNativeDismiss={preventDismiss}
          onAppear={() => { presented.current = true; onShow?.(); }}
          onDismissed={() => { if (visibleRef.current) onClose(); finishClose(); }}
          screenId={testID ?? 'form-sheet'}
          activityState={2}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]}
          contentStyle={{ backgroundColor: colors.surface }}
          headerConfig={{
            title,
            hidden: false,
            hideBackButton: true,
            hideShadow: true,
            translucent: false,
            backgroundColor: colors.surface,
            color: colors.textPrimary,
            titleColor: colors.textPrimary,
            experimental_userInterfaceStyle: mode,
            headerLeftBarButtonItems: [{
              type: 'button',
              icon: { type: 'sfSymbol', name: 'xmark' },
              variant: 'plain',
              accessibilityLabel: leadingAction.accessibilityLabel ?? leadingAction.label,
              identifier: leadingAction.testID,
              disabled: !!leadingAction.disabled || !!leadingAction.busy,
              onPress: leadingAction.onPress,
            }],
            headerRightBarButtonItems: [{
              type: 'button',
              title: trailingAction.label,
              // iOS 26 aliases `done` to `prominent`, which fills the glass.
              variant: 'plain',
              accessibilityLabel: trailingAction.accessibilityLabel ?? trailingAction.label,
              identifier: trailingAction.testID,
              disabled: !!trailingAction.disabled || !!trailingAction.busy,
              onPress: trailingAction.onPress,
            }],
          }}
        >
          <ScrollView
            testID={testID}
            style={styles.fill}
            contentContainerStyle={styles.content}
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {children}
          </ScrollView>
          {trailingAction.busy ? <ActivityIndicator style={styles.progress} color={colors.textSecondary}
            accessibilityLabel={trailingAction.accessibilityLabel ?? trailingAction.label} /> : null}
        </ScreenStackItem> : null}
    </ScreenStack>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', width: 0, height: 0 },
  fill: { flex: 1 },
  progress: { paddingVertical: spacing.sm },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg },
});
