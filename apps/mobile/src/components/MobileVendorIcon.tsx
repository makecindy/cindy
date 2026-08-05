import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useTheme } from '@/theme';

import { MobileAgentMark } from './MobileAgentMark';

interface MobileVendorIconProps {
  color?: string;
  running?: boolean;
  size?: number;
  vendor: 'cc' | 'codex' | string;
}

export function MobileVendorIcon({ color: colorOverride, running = false, size = 12, vendor }: MobileVendorIconProps) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(running ? 0.3 : 1)).current;
  const color = colorOverride ?? (running ? colors.statusAccent : colors.textTertiary);

  useEffect(() => {
    opacity.stopAnimation();
    if (!running) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.3);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.3,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, running]);

  return (
    <Animated.View
      accessible
      accessibilityLabel={vendor === 'codex' ? 'Codex' : 'Claude Code'}
      accessibilityRole="image"
      style={{ alignItems: 'center', height: size, justifyContent: 'center', opacity, width: size }}
    >
      <MobileAgentMark
        agentKind={vendor === 'codex' ? 'codex' : 'claude-code'}
        color={color}
        size={size}
      />
    </Animated.View>
  );
}
