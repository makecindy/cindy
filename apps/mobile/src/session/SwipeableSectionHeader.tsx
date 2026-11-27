import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { Ellipsis } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ReanimatedSwipeable, type SwipeableMethods } from '@/platform/gestureHandler';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import { useWallpaper } from '@/theme/wallpaper';
import { usePaneEdgeInset } from './SessionPaneDivider';
import type { SwipeRowRegistry } from './swipeRowRegistry';

const ACTION_SIZE = 56;
const GAP = spacing.md;
const TRAILING_WIDTH = ACTION_SIZE + GAP * 2;
const EDGE_HIT_SLOP = { left: -spacing.xl };

export interface SwipeableSectionHeaderProps {
  rowKey: string;
  registry?: SwipeRowRegistry;
  onOptions(): void;
  enabled?: boolean;
  testID?: string;
  actionTestID?: string;
  actionLabel?: string;
  children: ReactNode;
}

/** Wraps a Home section header row so swiping left reveals its trailing options action. */
export const SwipeableSectionHeader = memo(function SwipeableSectionHeader({
  rowKey,
  registry,
  onOptions,
  enabled = true,
  testID,
  actionTestID,
  actionLabel,
  children,
}: SwipeableSectionHeaderProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const methods = useRef<SwipeableMethods | null>(null);
  const edgeInset = usePaneEdgeInset();
  const hitSlop = useMemo(() => ({ ...EDGE_HIT_SLOP, right: -edgeInset }), [edgeInset]);
  const { selected } = useWallpaper();
  const [swiping, setSwiping] = useState<string | null>(null);
  const surface = selected === 'none' || swiping === rowKey ? styles.surface : undefined;
  const close = useCallback(() => methods.current?.close(), []);

  useEffect(() => {
    methods.current?.reset();
    return () => {
      registry?.onRowClose(rowKey);
    };
  }, [registry, rowKey]);

  const openOptions = useCallback(() => {
    registry?.onRowClose(rowKey);
    close();
    onOptions();
  }, [close, onOptions, registry, rowKey]);

  const gestureInputs = useRef({ registry, rowKey });
  useLayoutEffect(() => {
    gestureInputs.current = { registry, rowKey };
  });

  const handleOpenStartDrag = useCallback(() => {
    const { registry: activeRegistry, rowKey: activeKey } = gestureInputs.current;
    activeRegistry?.onRowOpen(activeKey, close);
    if (selected !== 'none') setSwiping(activeKey);
  }, [close, selected]);

  const handleClose = useCallback(() => {
    const { registry: activeRegistry, rowKey: activeKey } = gestureInputs.current;
    activeRegistry?.onRowClose(activeKey);
    setSwiping(null);
  }, []);

  if (!enabled || !registry) {
    return <>{children}</>;
  }

  return (
    <ReanimatedSwipeable
      ref={methods}
      testID={testID}
      containerStyle={surface}
      childrenContainerStyle={surface}
      hitSlop={hitSlop}
      overshootRight={false}
      onSwipeableOpenStartDrag={handleOpenStartDrag}
      onSwipeableClose={handleClose}
      renderRightActions={(_progress, offset) => (
        <View style={styles.trailingShell}>
          <SectionOptionsSwipeAction
            actionTestID={actionTestID}
            label={actionLabel ?? t('session.row.moreOptions')}
            onPress={openOptions}
            offset={offset}
            styles={styles}
            background={colors.swipeActionNeutral}
            foreground={colors.swipeActionText}
          />
        </View>
      )}
    >
      {children}
    </ReanimatedSwipeable>
  );
});

function SectionOptionsSwipeAction({
  actionTestID,
  label,
  onPress,
  offset,
  styles,
  background,
  foreground,
}: {
  actionTestID?: string;
  label: string;
  onPress(): void;
  offset: SharedValue<number>;
  styles: ReturnType<typeof makeStyles>;
  background: string;
  foreground: string;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const revealed = Math.max(0, -offset.value);
    const progress = Math.min(1, revealed / TRAILING_WIDTH);
    return {
      opacity: interpolate(progress, [0.15, 0.7], [0, 1], 'clamp'),
      transform: [{ scale: interpolate(progress, [0.15, 1], [0.5, 1], 'clamp') }],
      width: ACTION_SIZE,
    };
  });
  return (
    <Animated.View style={[styles.action, { backgroundColor: background }, animatedStyle]}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onPress}
        style={styles.pressable}
        testID={actionTestID}
      >
        <View style={styles.icon}>
          <Ellipsis size={iconSize.swipeAction} strokeWidth={iconStroke.regular} color={foreground} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    surface: { backgroundColor: colors.surface },
    trailingShell: { width: TRAILING_WIDTH, overflow: 'visible' },
    action: {
      borderRadius: radius.pill,
      height: ACTION_SIZE,
      position: 'absolute',
      right: GAP,
      top: '50%',
      marginTop: -ACTION_SIZE / 2,
      overflow: 'hidden',
    },
    pressable: { flex: 1 },
    icon: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: ACTION_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
