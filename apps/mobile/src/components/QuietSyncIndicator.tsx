import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { LoaderCircle } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { iconSize, iconStroke, useTheme } from '@/theme';
import { motionDuration } from '@/theme/tokens';
import { useDelayedConnectionNotice } from './ConnectionNoticeOverlay';

/** Same working glyph and cadence as the task list; no idle placeholder. */
export function QuietSyncIndicator({ active, immediate = false }: { active: boolean; immediate?: boolean }) {
  const visible = useDelayedConnectionNotice(active, immediate);
  const reduceMotion = useReduceMotionEnabled();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible || reduceMotion !== false) return;
    const loop = Animated.loop(Animated.timing(rotation, {
      toValue: 1,
      duration: motionDuration.spinnerCycle,
      easing: Easing.linear,
      useNativeDriver: true,
      isInteraction: false,
    }));
    loop.start();
    return () => { loop.stop(); rotation.setValue(0); };
  }, [visible, reduceMotion, rotation]);
  if (!visible) return null;
  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View
    pointerEvents="none"
    style={{ flexShrink: 0, transform: [{ rotate }] }}
    accessible
    accessibilityLabel={t('deviceLink.recovery.syncing')}
    accessibilityState={{ busy: true }}
    testID="connection.quietSync"
  >
    <LoaderCircle color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
  </Animated.View>;
}
