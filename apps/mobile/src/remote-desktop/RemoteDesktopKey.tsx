import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  View,
  type StyleProp,
  type ViewStyle,
  type GestureResponderEvent,
} from "react-native";

/** Raw touch events keep each finger independent; RN's Pressable responder is
 * exclusive and cannot represent holding Command while touching another key. */
export function RemoteDesktopKey({
  disabled = false,
  label,
  testID,
  onDown,
  onUp,
  style,
  children,
}: {
  disabled?: boolean;
  label: string;
  testID?: string;
  onDown(): void;
  onUp(): void;
  style(pressed: boolean): StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const fingers = useRef(new Set<string | number>());
  const callbacks = useRef({ onDown, onUp });
  callbacks.current = { onDown, onUp };
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    setPressed(false);
    return () => {
      if (fingers.current.size) callbacks.current.onUp();
      fingers.current.clear();
    };
  }, [disabled]);
  const release = (event: GestureResponderEvent) => {
    if (!fingers.current.size) return;
    for (const touch of event.nativeEvent.changedTouches)
      fingers.current.delete(touch.identifier);
    if (!fingers.current.size) {
      callbacks.current.onUp();
      setPressed(false);
    }
  };
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: pressed }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(event) => {
        if (
          disabled ||
          fingers.current.size ||
          event.nativeEvent.actionName !== "activate"
        )
          return;
        callbacks.current.onDown();
        callbacks.current.onUp();
      }}
      onTouchStart={(event) => {
        if (disabled) return;
        const wasPressed = fingers.current.size > 0;
        // Fabric batches changedTouches across different keys. Its targetTouches
        // belongs to this target; Android dispatches one native touch per event.
        const touches = (
          event.nativeEvent as typeof event.nativeEvent & {
            targetTouches?: readonly { identifier: string | number }[];
          }
        ).targetTouches ?? [event.nativeEvent];
        for (const touch of touches) fingers.current.add(touch.identifier);
        if (!wasPressed && fingers.current.size) {
          callbacks.current.onDown();
          setPressed(true);
        }
      }}
      onTouchEnd={release}
      onTouchCancel={release}
      style={style(pressed)}
    >
      {children}
    </View>
  );
}
