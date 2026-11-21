import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "@/platform/gestureHandler";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";
import { motionDuration, motionEasing } from "@/theme/tokens";
import { useComposerDockKeyboardHeight } from "@/session/useComposerDockKeyboardHeight";

function useZeroKeyboardHeight() {
  return useSharedValue(0);
}
// Android already resizes its window for the IME.
const useSystemHeight =
  Platform.OS === "ios" ? useComposerDockKeyboardHeight : useZeroKeyboardHeight;

/** Move the key deck as a single surface, including its toolbar. In portrait
 * the shrinking margin gives the live desktop back exactly the space revealed. */
export function useRemoteKeyboardMotion({
  active,
  overlay,
  height,
  dismiss,
  systemDock,
}: {
  active: boolean;
  overlay: boolean;
  height: number;
  dismiss: () => void;
  systemDock: "none" | "overlay" | "spacer";
}) {
  const reduceMotion = useReduceMotionEnabled();
  const duration = reduceMotion === false ? motionDuration.fast : 0;
  const systemHeight = useSystemHeight();
  const offset = useSharedValue(0);
  useEffect(() => {
    if (!active) offset.value = 0;
  }, [active, offset]);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(active)
        .maxPointers(1)
        .activeOffsetY(12)
        .failOffsetX([-24, 24])
        .onUpdate((e) => {
          offset.value = Math.max(0, Math.min(height, e.translationY));
        })
        .onEnd((e) => {
          const close =
            e.translationY > 48 &&
            (e.translationY > height / 3 || e.velocityY > 400);
          offset.value = withTiming(
            close ? height : 0,
            { duration, easing: Easing.bezier(...motionEasing.move) },
            (finished) => {
              if (finished && close) runOnJS(dismiss)();
            },
          );
        })
        .onFinalize((_, success) => {
          if (!success) {
            offset.value = withTiming(0, {
              duration,
              easing: Easing.bezier(...motionEasing.move),
            });
          }
        }),
    [active, height, offset, dismiss, duration],
  );
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          (overlay && active ? offset.value : 0) -
          (systemDock === "overlay" ? systemHeight.value : 0),
      },
    ],
    marginBottom: !overlay && active ? -offset.value : 0,
  }));
  const spacerStyle = useAnimatedStyle(() => ({
    height: systemDock === "spacer" ? systemHeight.value : 0,
  }));
  return { gesture, panelStyle, spacerStyle };
}

export function RemoteKeyboardLayout({
  spacerStyle,
  phoneKeyboard,
  deckGesture,
  onDismiss,
  style,
  children,
}: {
  spacerStyle: ReturnType<typeof useRemoteKeyboardMotion>["spacerStyle"];
  phoneKeyboard: boolean;
  deckGesture: ReturnType<typeof Gesture.Pan>;
  onDismiss(): void;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const scrollY = useSharedValue(0);
  const trackScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  // UIKit needs a scrollable surface for interactive dismissal. Cancel its
  // rubber-band translation so the desktop stays under the moving keyboard.
  const anchored = useAnimatedStyle(() => ({
    transform: [{ translateY: phoneKeyboard ? scrollY.value : 0 }],
  }));
  return (
    <View testID="remoteDesktop.layout" style={style}>
      <GestureDetector gesture={deckGesture}>
        <Animated.ScrollView
          testID="remoteDesktop.keyboardGesture"
          style={styles.fill}
          contentContainerStyle={styles.fill}
          scrollEnabled={Platform.OS === "ios" && phoneKeyboard}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "none"}
          keyboardShouldPersistTaps="always"
          alwaysBounceVertical
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={trackScroll}
          onTouchStart={(event) => {
            if (Platform.OS !== "android" || !phoneKeyboard) return;
            const { pageX: x, pageY: y, touches } = event.nativeEvent;
            swipeStart.current = touches.length === 1 ? { x, y } : null;
          }}
          onTouchCancel={() => {
            swipeStart.current = null;
          }}
          onTouchEnd={(event) => {
            const start = swipeStart.current;
            swipeStart.current = null;
            if (!start || !phoneKeyboard) return;
            const dy = event.nativeEvent.pageY - start.y;
            if (dy > 48 && dy > Math.abs(event.nativeEvent.pageX - start.x))
              onDismiss();
          }}
        >
          <Animated.View style={[styles.fill, anchored]}>
            {children}
          </Animated.View>
        </Animated.ScrollView>
      </GestureDetector>
      <Animated.View
        testID="remoteDesktop.keyboardSpacer"
        pointerEvents="none"
        style={spacerStyle}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
