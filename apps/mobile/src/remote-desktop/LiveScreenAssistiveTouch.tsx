import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { Text } from "@/components/AppText";
import {
  iconSize,
  iconStroke,
  radius,
  spacing,
  typeScale,
  useTheme,
} from "@/theme";

export interface LiveScreenMenuItem {
  key: string;
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onPress(): void;
}

const BALL = 56;
const MARGIN = spacing.xs;
/** Movement below this is a tap, not a drag. */
const TAP_SLOP = 6;
/** Untouched for this long, the ball fades so it covers less of the device. */
const IDLE_MS = 3000;
const IDLE_OPACITY = 0.45;
const MENU_COLUMNS = 3;
const MENU_CELL = 88;

type Side = "left" | "right";
type Bounds = { left: number; right: number; top: number; bottom: number };

/**
 * A device screen fills the phone, so its controls live in one movable ball:
 * drag it out of the way (it rests against the nearer side), tap it for the
 * menu. Its touches never reach the device.
 */
export function LiveScreenAssistiveTouch({
  items,
  caption,
  label,
  insets,
  hidden,
}: {
  items: LiveScreenMenuItem[];
  caption: string;
  /** Accessibility label of the ball. */
  label: string;
  insets: { top: number; bottom: number; left: number; right: number };
  /** Another panel is showing: step aside until it closes. */
  hidden?: boolean;
}) {
  const window = useWindowDimensions();
  const { colors } = useTheme();
  // Over any device picture, light or dark: the theme's media chrome.
  const backing = { backgroundColor: colors.mediaPlayBackground };
  const mark = colors.mediaPlayForeground;
  const [open, setOpen] = useState(false);
  const bounds = useMemo<Bounds>(
    () => ({
      left: insets.left + MARGIN,
      right: window.width - insets.right - MARGIN - BALL,
      top: insets.top + MARGIN,
      bottom: window.height - insets.bottom - MARGIN - BALL,
    }),
    [
      insets.bottom,
      insets.left,
      insets.right,
      insets.top,
      window.height,
      window.width,
    ],
  );
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  // Where the ball rests, as a side and a fraction of the usable height, so a
  // rotation or a resize keeps it on the same side at the same relative place.
  const rest = useRef<{ side: Side; y: number }>({ side: "right", y: 0.62 });
  const position = useRef(
    new Animated.ValueXY(restPoint(rest.current, bounds)),
  ).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    opacity.stopAnimation();
    opacity.setValue(1);
    idleTimer.current = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: IDLE_OPACITY,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }, IDLE_MS);
  };
  const wakeRef = useRef(wake);
  wakeRef.current = wake;
  useEffect(() => {
    wakeRef.current();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);
  useEffect(() => {
    position.setValue(restPoint(rest.current, bounds));
  }, [bounds, position]);

  const pan = useMemo(() => {
    let start = { x: 0, y: 0 };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // The ball keeps its gesture: nothing underneath it may take over.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        position.stopAnimation((value) => {
          start = value;
        });
        wakeRef.current();
      },
      onPanResponderMove: (_, g) => {
        const b = boundsRef.current;
        position.setValue({
          x: clamp(start.x + g.dx, b.left, b.right),
          y: clamp(start.y + g.dy, b.top, b.bottom),
        });
      },
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < TAP_SLOP && Math.abs(g.dy) < TAP_SLOP) {
          position.setValue(start);
          setOpen(true);
          return;
        }
        const b = boundsRef.current;
        const x = clamp(start.x + g.dx, b.left, b.right);
        const y = clamp(start.y + g.dy, b.top, b.bottom);
        rest.current = {
          side: x + BALL / 2 < (b.left + b.right + BALL) / 2 ? "left" : "right",
          y: b.bottom > b.top ? (y - b.top) / (b.bottom - b.top) : 0,
        };
        Animated.spring(position, {
          toValue: restPoint(rest.current, b),
          useNativeDriver: false,
          friction: 7,
        }).start();
        wakeRef.current();
      },
      onPanResponderTerminate: () => {
        position.setValue(restPoint(rest.current, boundsRef.current));
      },
    });
  }, [position]);

  const close = () => {
    setOpen(false);
    wakeRef.current();
  };
  const menuWidth = Math.min(
    MENU_COLUMNS * MENU_CELL + spacing.md * 2,
    window.width - insets.left - insets.right - spacing.lg * 2,
  );

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {!open && !hidden && (
        <Animated.View
          {...pan.panHandlers}
          accessible
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityActions={[{ name: "activate" }]}
          onAccessibilityAction={() => setOpen(true)}
          testID="liveScreen.assistiveTouch"
          style={[
            styles.ball,
            backing,
            { opacity, transform: position.getTranslateTransform() },
          ]}
        >
          {/* Three stacked discs, lighter towards the centre, like the system's. */}
          <View
            style={[styles.disc, styles.outer, { backgroundColor: mark }]}
          />
          <View
            style={[styles.disc, styles.middle, { backgroundColor: mark }]}
          />
          <View
            style={[styles.disc, styles.inner, { backgroundColor: mark }]}
          />
        </Animated.View>
      )}
      {open && !hidden && (
        <Pressable
          // Tapping outside closes, as with the system's; VoiceOver closes
          // with its escape gesture and reaches each item on its own.
          accessible={false}
          onPress={close}
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          testID="liveScreen.menuBackdrop"
        >
          <Pressable
            // Taps inside the panel but between items must not close it.
            onPress={() => undefined}
            accessible={false}
            accessibilityViewIsModal
            onAccessibilityEscape={close}
            style={[styles.menu, backing, { width: menuWidth }]}
            testID="liveScreen.menu"
          >
            <Text numberOfLines={1} style={[styles.caption, { color: mark }]}>
              {caption}
            </Text>
            <View style={styles.grid}>
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    accessibilityState={{ disabled: item.disabled }}
                    disabled={item.disabled}
                    onPress={() => {
                      close();
                      item.onPress();
                    }}
                    testID={`liveScreen.menu.${item.key}`}
                    style={({ pressed }) => [
                      styles.cell,
                      pressed && backing,
                      item.disabled && styles.cellDisabled,
                    ]}
                  >
                    <Icon
                      size={iconSize.xxl}
                      strokeWidth={iconStroke.thin}
                      color={mark}
                    />
                    <Text
                      numberOfLines={1}
                      style={[styles.cellLabel, { color: mark }]}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      )}
    </View>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function restPoint(rest: { side: Side; y: number }, b: Bounds) {
  return {
    x: rest.side === "left" ? b.left : Math.max(b.left, b.right),
    y: b.top + clamp(rest.y, 0, 1) * Math.max(0, b.bottom - b.top),
  };
}

const styles = StyleSheet.create({
  ball: {
    position: "absolute",
    left: 0,
    top: 0,
    width: BALL,
    height: BALL,
    borderRadius: radius.container,
    alignItems: "center",
    justifyContent: "center",
  },
  disc: { position: "absolute", borderRadius: radius.pill },
  outer: { width: 42, height: 42, opacity: 0.2 },
  middle: { width: 32, height: 32, opacity: 0.3 },
  inner: { width: 22, height: 22, opacity: 0.9 },
  backdrop: { alignItems: "center", justifyContent: "center" },
  menu: {
    borderRadius: radius.container,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  caption: {
    opacity: 0.7,
    fontSize: typeScale.caption,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center" },
  cell: {
    width: MENU_CELL,
    height: MENU_CELL,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    borderRadius: radius.container,
  },
  cellDisabled: { opacity: 0.4 },
  cellLabel: {
    fontSize: typeScale.caption,
    maxWidth: MENU_CELL - spacing.xs * 2,
  },
});
