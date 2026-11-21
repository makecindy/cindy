import { useRef, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";

export function RemoteKeyboardLayout({
  avoid,
  phoneKeyboard,
  onDismiss,
  style,
  children,
}: {
  avoid: boolean;
  phoneKeyboard: boolean;
  onDismiss(): void;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  return (
    <KeyboardAvoidingView
      testID="remoteDesktop.layout"
      enabled={avoid}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={style}
    >
      <ScrollView
        testID="remoteDesktop.keyboardGesture"
        style={styles.fill}
        contentContainerStyle={styles.fill}
        scrollEnabled={Platform.OS === "ios" && phoneKeyboard}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "none"}
        keyboardShouldPersistTaps="always"
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
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
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
