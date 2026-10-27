import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { List, Search, SquarePen, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  ReanimatedSwipeable,
  SwipeDirection,
  type SwipeableMethods,
} from "@/platform/gestureHandler";
import type { SwipeRowRegistry } from "./swipeRowRegistry";
import {
  iconSize,
  iconStroke,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { radius, spacing } from "@/theme/tokens";

// Match the floating circular actions in SwipeableSessionRow on both platforms.
const ACTION_SIZE = 56;
const GAP = spacing.md;
const LEADING_WIDTH = ACTION_SIZE * 2 + GAP * 3;
const TRAILING_WIDTH = ACTION_SIZE + GAP * 2;
const EDGE_HIT_SLOP = { left: -spacing.xl };

interface Props {
  projectKey: string;
  registry: SwipeRowRegistry;
  onNewTask(): void;
  onOpenTasks(): void;
  onSearch(): void;
  children: ReactNode;
}

/** Only wraps the header, so expanded tasks never move with the project swipe. */
export const SwipeableProjectHeader = memo(function SwipeableProjectHeader({
  projectKey,
  registry,
  onNewTask,
  onOpenTasks,
  onSearch,
  children,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const methods = useRef<SwipeableMethods | null>(null);
  const translation = useRef<SharedValue<number> | null>(null);
  const rowKey = `project:${projectKey}`;
  const close = useCallback(() => methods.current?.close(), []);
  useEffect(() => {
    methods.current?.reset();
    return () => registry.onRowClose(rowKey);
  }, [registry, rowKey]);
  const run = useCallback(
    (action: () => void) => {
      registry.onRowClose(rowKey);
      close();
      action();
    },
    [close, registry, rowKey],
  );
  // Keep RNGH's worklet graph registered across list updates and rotation.
  // Release actions read the current committed project and full-swipe width.
  const gestureInputs = useRef({ registry, rowKey, width, run, onNewTask });
  useLayoutEffect(() => {
    gestureInputs.current = { registry, rowKey, width, run, onNewTask };
  });
  const handleOpenStartDrag = useCallback(() => {
    const { registry, rowKey } = gestureInputs.current;
    registry.onRowOpen(rowKey, close);
  }, [close]);
  const handleClose = useCallback(() => {
    const { registry, rowKey } = gestureInputs.current;
    registry.onRowClose(rowKey);
  }, []);
  const handleWillOpen = useCallback((direction: (typeof SwipeDirection)[keyof typeof SwipeDirection]) => {
    const { width, run, onNewTask } = gestureInputs.current;
    // Release only. Right swipes always require an explicit action tap.
    if (direction === SwipeDirection.LEFT && -(translation.current?.value ?? 0) >= width * 0.55) {
      run(onNewTask);
    }
  }, []);

  return (
    <ReanimatedSwipeable
      ref={methods}
      testID={`home.projectSwipe.${projectKey}`}
      containerStyle={styles.surface}
      childrenContainerStyle={styles.surface}
      // Leave the screen edge available to native back navigation.
      hitSlop={EDGE_HIT_SLOP}
      overshootLeft={false}
      onSwipeableOpenStartDrag={handleOpenStartDrag}
      onSwipeableClose={handleClose}
      onSwipeableWillOpen={handleWillOpen}
      renderLeftActions={(_progress, offset) => {
        translation.current = offset;
        return (
          <View style={styles.leadingShell}>
            <ProjectAction
              icon={List}
              label={t("devices.list.projectActions.allTasks")}
              onPress={() => run(onOpenTasks)}
              offset={offset}
              leading
              styles={styles}
              background={colors.swipeActionNeutral}
              foreground={colors.swipeActionText}
            />
            <ProjectAction
              icon={Search}
              label={t("devices.list.projectActions.search")}
              onPress={() => run(onSearch)}
              offset={offset}
              leading
              styles={styles}
              background={colors.swipeActionNeutral}
              foreground={colors.swipeActionText}
              index={1}
            />
          </View>
        );
      }}
      renderRightActions={(_progress, offset) => {
        translation.current = offset;
        return (
          <View style={styles.trailingShell}>
            <ProjectAction
              icon={SquarePen}
              label={t("devices.list.projectActions.newTask")}
              onPress={() => run(onNewTask)}
              offset={offset}
              styles={styles}
              background={colors.cta}
              foreground={colors.ctaText}
            />
          </View>
        );
      }}
    >
      {children}
    </ReanimatedSwipeable>
  );
});

function ProjectAction({
  icon: Icon,
  label,
  onPress,
  offset,
  leading = false,
  index = 0,
  styles,
  background,
  foreground,
}: {
  icon: LucideIcon;
  label: string;
  onPress(): void;
  offset: SharedValue<number>;
  leading?: boolean;
  index?: number;
  styles: ReturnType<typeof makeStyles>;
  background: string;
  foreground: string;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const revealed = Math.max(0, leading ? offset.value : -offset.value);
    const progress = Math.min(
      1,
      revealed / (leading ? LEADING_WIDTH : TRAILING_WIDTH),
    );
    return {
      opacity: interpolate(progress, [0.15, 0.7], [0, 1], "clamp"),
      transform: [
        { scale: interpolate(progress, [0.15, 1], [0.5, 1], "clamp") },
      ],
      width: leading ? ACTION_SIZE : Math.max(ACTION_SIZE, revealed - GAP * 2),
    };
  });
  return (
    <Animated.View
      style={[
        styles.action,
        { backgroundColor: background },
        leading ? { left: GAP + index * (ACTION_SIZE + GAP) } : { right: GAP },
        animatedStyle,
      ]}
    >
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onPress}
        style={styles.pressable}
      >
        <View style={styles.icon}>
          <Icon
            size={iconSize.swipeAction}
            strokeWidth={iconStroke.regular}
            color={foreground}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    surface: { backgroundColor: colors.surface },
    leadingShell: { width: LEADING_WIDTH, overflow: "visible" },
    trailingShell: { width: TRAILING_WIDTH, overflow: "visible" },
    action: {
      borderRadius: radius.pill,
      height: ACTION_SIZE,
      position: "absolute",
      top: "50%",
      marginTop: -ACTION_SIZE / 2,
      overflow: "hidden",
    },
    pressable: { flex: 1 },
    icon: {
      alignItems: "center",
      justifyContent: "center",
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      width: ACTION_SIZE,
    },
  });
