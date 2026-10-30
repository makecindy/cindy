import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { GestureHandlerRootView } from "@/platform/gestureHandler";
import { BlurBackdrop } from "@/session/BlurBackdrop";
import { motionDuration, motionEasing, spacing } from "@/theme/tokens";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";

export interface SessionActionSheetFrameProps {
  visible: boolean;
  onClose(): void;
  onClosed?(): void;
  children: ReactNode;
}

/** Compatibility presentation; Android resolves the Compose implementation. */
export function SessionActionSheetFrame({
  visible,
  onClose,
  onClosed,
  children,
}: SessionActionSheetFrameProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  // Unknown system preference must also avoid motion on the first frame.
  const animate = useReduceMotionEnabled() === false;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (!animate) {
        progress.setValue(1);
        return;
      }
      Animated.timing(progress, {
        duration: motionDuration.enter,
        easing: Easing.bezier(...motionEasing.out),
        toValue: 1,
        useNativeDriver: true,
      }).start();
    } else {
      if (!animate) {
        progress.setValue(0);
        setMounted(false);
        return;
      }
      Animated.timing(progress, {
        duration: motionDuration.exit,
        easing: Easing.bezier(...motionEasing.in),
        toValue: 0,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [animate, visible, progress]);

  // onClosed 等 Modal 真正从树上卸载后再触发(同 DeviceMenuModal:动画回调里同步挂
  // 第二个 Modal 会和本 Modal 的卸载挤进同一个 commit,iOS 可能吞掉新弹窗)。
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasMountedRef = useRef(mounted);
  useEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = mounted;
    if (wasMounted && !mounted) onClosedRef.current?.();
  }, [mounted]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CARD_SLIDE_DISTANCE, 0],
  });
  return (
    <Modal
      supportedOrientations={[
        "portrait",
        "portrait-upside-down",
        "landscape-left",
        "landscape-right",
      ]}
      animationType="none"
      onRequestClose={onClose}
      transparent
      visible={mounted}
    >
      <GestureHandlerRootView style={styles.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <BlurBackdrop />
          <Pressable
            accessibilityLabel={t("session.row.closeActionMenu")}
            onPress={onClose}
            style={styles.backdrop}
            testID="home.sessionActions.backdrop"
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.cardArea,
            {
              paddingBottom: Math.max(insets.bottom, spacing.md),
              transform: [{ translateY }],
            },
          ]}
          testID="home.sessionActions"
        >
          {children}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
const CARD_SLIDE_DISTANCE = 360;
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { flex: 1 },
  cardArea: { gap: spacing.sm, paddingHorizontal: spacing.md },
});
