import {
  Host,
  ModalBottomSheet,
  RNHostView,
  type ModalBottomSheetRef,
} from "@expo/ui/jetpack-compose";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { GestureHandlerRootView } from "@/platform/gestureHandler";
import { useTheme } from "@/theme";
import { spacing } from "@/theme/tokens";
import type { SessionActionSheetFrameProps } from "./SessionActionSheetFrame";

/** Native dialog owns dragging, the scrim, Back and its dismiss animation. */
export function SessionActionSheetFrame({
  visible,
  onClose,
  onClosed,
  children,
}: SessionActionSheetFrameProps) {
  const { colors, mode } = useTheme();
  const { height, width } = useWindowDimensions();
  const sheet = useRef<ModalBottomSheetRef>(null);
  const [mounted, setMounted] = useState(visible);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasMounted = useRef(mounted);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    let cancelled = false;
    // hide resolves after the native animation; never use a guessed timer.
    const closingSheet = sheet.current;
    void closingSheet?.hide().then(() => {
      if (!cancelled) setMounted(false);
      else if (visibleRef.current && sheet.current === closingSheet) {
        // A new open can overtake hide(); restore the existing native dialog.
        void closingSheet.expand();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    const closed = wasMounted.current && !mounted;
    wasMounted.current = mounted;
    // Let the native unmount commit reach the UI thread before presenting a
    // sibling dialog; presenting in this effect can leave RN Modal invisible.
    if (closed && !visible) {
      const frame = requestAnimationFrame(() => onClosedRef.current?.());
      return () => cancelAnimationFrame(frame);
    }
  }, [mounted, visible]);

  if (!mounted) return null;
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      // Material's modal sheet caps its width at 640dp on wide windows. Match
      // the RN layout root to it so embedded actions cannot extend off-sheet.
      style={[styles.host, { width: Math.min(width, 640) }]}
    >
      <ModalBottomSheet
        ref={sheet}
        skipPartiallyExpanded
        containerColor={colors.surfaceElevated}
        contentColor={colors.textPrimary}
        scrimColor={colors.overlay}
        onDismissRequest={() => {
          // The native sheet has already started its dismiss animation. Keep
          // the host mounted until the controlled visible=false path awaits
          // hide(), then let onClosed run after the animation completes.
          onClose();
        }}
      >
        <RNHostView matchContents>
          <GestureHandlerRootView style={{ maxHeight: height * 0.8 }}>
            <ScrollView
              // Task tags and other expanded controls may host their own
              // vertical lists. Let Android negotiate the child scroll first
              // instead of locking gestures to the sheet viewport.
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.content}
              testID="home.sessionActions"
            >
              {children}
            </ScrollView>
          </GestureHandlerRootView>
        </RNHostView>
      </ModalBottomSheet>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: { position: "absolute" },
  content: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
});
