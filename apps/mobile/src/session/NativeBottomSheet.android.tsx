import {
  Host,
  ModalBottomSheet,
  RNHostView,
  type ModalBottomSheetRef,
} from "@expo/ui/jetpack-compose";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { GestureHandlerRootView } from "@/platform/gestureHandler";
import { PaneViewportProvider } from "@/platform/AdaptiveWindowContext";
import { useTheme } from "@/theme";
import { NativeSheetContext } from "./NativeSheetContext";
import type { NativeBottomSheetProps } from "./NativeBottomSheet";

/** Used for single-level sheets; nested Back/draft-veto sheets keep their existing modal contract. */
export function NativeBottomSheet({
  visible,
  onClose,
  onClosed,
  children,
}: NativeBottomSheetProps) {
  const { colors, mode } = useTheme();
  const window = useWindowDimensions();
  const width = Math.min(window.width, 640);
  const height = window.height * 0.85;
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
    const closing = sheet.current;
    void closing?.hide().then(() => {
      if (!cancelled) setMounted(false);
      else if (visibleRef.current && sheet.current === closing)
        void closing.expand();
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);
  useEffect(() => {
    const closed = wasMounted.current && !mounted;
    wasMounted.current = mounted;
    if (closed && !visible) {
      const frame = requestAnimationFrame(() => onClosedRef.current?.());
      return () => cancelAnimationFrame(frame);
    }
  }, [mounted, visible]);
  const context = useMemo(
    () => ({
      height,
      expand: () => {
        void sheet.current?.expand();
      },
    }),
    [height],
  );
  if (!mounted) return null;
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      style={{ position: "absolute", width }}
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
          <GestureHandlerRootView style={{ maxHeight: height }}>
            <PaneViewportProvider value={{ width, height }}>
              <NativeSheetContext.Provider value={context}>
                {children}
              </NativeSheetContext.Provider>
            </PaneViewportProvider>
          </GestureHandlerRootView>
        </RNHostView>
      </ModalBottomSheet>
    </Host>
  );
}
