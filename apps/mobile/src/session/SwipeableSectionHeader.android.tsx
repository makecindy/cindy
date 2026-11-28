import { memo, useCallback, useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Ellipsis } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ClassicSwipeable, type ClassicSwipeableMethods } from '@/platform/gestureHandler';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import { usePaneEdgeInset } from './SessionPaneDivider';
import type { SwipeableSectionHeaderProps } from './SwipeableSectionHeader';

type Translation = Parameters<NonNullable<React.ComponentProps<typeof ClassicSwipeable>['renderRightActions']>>[1];

const ACTION_SIZE = 56;
const GAP = spacing.md;
const TRAILING_WIDTH = ACTION_SIZE + GAP * 2;

/** Android section header shares task/project-row scroll arbitration via ClassicSwipeable. */
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
  const edgeInset = usePaneEdgeInset();
  const methods = useRef<ClassicSwipeableMethods | null>(null);
  const close = useCallback(() => methods.current?.close(), []);

  useEffect(() => {
    methods.current?.reset();
    return () => {
      registry?.onRowClose(rowKey);
    };
  }, [registry, rowKey]);

  if (!enabled || !registry) {
    return <>{children}</>;
  }

  const openOptions = () => {
    registry.onRowClose(rowKey);
    close();
    onOptions();
  };

  const renderRightActions = (_progress: Translation, offset: Translation) => {
    const progress = offset.interpolate({
      inputRange: [-TRAILING_WIDTH, 0],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });
    return (
      <View style={styles.trailingShell}>
        <Animated.View
          style={[
            styles.action,
            {
              backgroundColor: colors.swipeActionNeutral,
              opacity: progress.interpolate({ inputRange: [0.15, 0.7], outputRange: [0, 1], extrapolate: 'clamp' }),
              transform: [
                { scale: progress.interpolate({ inputRange: [0.15, 1], outputRange: [0.5, 1], extrapolate: 'clamp' }) },
              ],
            },
          ]}
        >
          <Pressable
            accessibilityLabel={actionLabel ?? t('session.row.moreOptions')}
            accessibilityRole="button"
            onPress={openOptions}
            style={styles.pressable}
            testID={actionTestID}
          >
            <View style={styles.icon}>
              <Ellipsis size={iconSize.swipeAction} strokeWidth={iconStroke.regular} color={colors.swipeActionText} />
            </View>
          </Pressable>
        </Animated.View>
      </View>
    );
  };

  return (
    <ClassicSwipeable
      ref={methods}
      testID={testID}
      containerStyle={styles.surface}
      childrenContainerStyle={styles.surface}
      hitSlop={{ left: -spacing.xl, right: -edgeInset }}
      overshootRight={false}
      useNativeAnimations={false}
      onSwipeableOpenStartDrag={() => registry.onRowOpen(rowKey, close)}
      onSwipeableClose={() => registry.onRowClose(rowKey)}
      renderRightActions={renderRightActions}
    >
      {children}
    </ClassicSwipeable>
  );
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    surface: { backgroundColor: colors.surface },
    trailingShell: { width: TRAILING_WIDTH, overflow: 'visible' },
    action: {
      borderRadius: radius.pill,
      height: ACTION_SIZE,
      width: ACTION_SIZE,
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
