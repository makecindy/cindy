import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useTheme } from '@/theme';

import { MobileAgentMark } from './MobileAgentMark';

/**
 * 运行中呼吸的半程时长(ms)。这是常驻循环的「运行中」状态信号,不是交互过渡,
 * 不套 motionDuration 交互档位;减弱动态效果下静止在全不透明。
 */
const RUNNING_BREATH_HALF_CYCLE_MS = 750;
const RUNNING_BREATH_MIN_OPACITY = 0.3;

interface MobileVendorIconProps {
  color?: string;
  running?: boolean;
  size?: number;
  vendor: 'cc' | 'codex' | string;
}

export function MobileVendorIcon({ color: colorOverride, running = false, size = 12, vendor }: MobileVendorIconProps) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotionEnabled();
  const animate = running && reduceMotion === false;
  const opacity = useRef(new Animated.Value(animate ? RUNNING_BREATH_MIN_OPACITY : 1)).current;
  const color = colorOverride ?? (running ? colors.statusAccent : colors.textTertiary);

  useEffect(() => {
    opacity.stopAnimation();
    if (!animate) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(RUNNING_BREATH_MIN_OPACITY);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: RUNNING_BREATH_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: RUNNING_BREATH_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          toValue: RUNNING_BREATH_MIN_OPACITY,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [animate, opacity]);

  return (
    <Animated.View
      accessible
      accessibilityLabel={vendor === 'codex' ? 'Codex' : vendor === 'pi' ? 'Pi' : 'Claude Code'}
      accessibilityRole="image"
      style={{ alignItems: 'center', height: size, justifyContent: 'center', opacity, width: size }}
    >
      <MobileAgentMark
        agentKind={vendor === 'codex' || vendor === 'pi' ? vendor : 'claude-code'}
        color={color}
        size={size}
      />
    </Animated.View>
  );
}
