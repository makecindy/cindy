import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme/tokens';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function MessageListActionButton({
  accessibilityLabel,
  children,
  disabled = false,
  onPress,
  style,
  testID,
  hitSlop,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  hitSlop?: number;
}) {
  const interactionDisabled = disabled || !onPress;
  // Animate only when reduced motion is explicitly disabled.
  const reduceMotionEnabled = useReduceMotionEnabled();
  const appear = useRef(new Animated.Value(reduceMotionEnabled === false ? 0 : 1)).current;
  useEffect(() => {
    if (reduceMotionEnabled !== false) {
      appear.setValue(1);
      return;
    }
    Animated.timing(appear, {
      duration: motionDuration.fast,
      easing: Easing.bezier(...motionEasing.out),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: true,
    }).start();
    // 仅 mount 播一次:reduceMotionEnabled 运行中翻转不重放入场。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const appearStyle = {
    opacity: appear,
    transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
  };
  // AnimatedPressable cannot resolve Animated.Value inside a style callback.
  const [pressed, setPressed] = useState(false);
  return (
    <AnimatedPressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: interactionDisabled }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        style,
        appearStyle,
        pressed && !interactionDisabled && styles.pressed,
        interactionDisabled && styles.disabled,
      ]}
      testID={testID}
      hitSlop={hitSlop}
    >
      {children}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({ pressed: { opacity: 0.72 }, disabled: { opacity: 0.42 } });
