/**
 * Controls for a device screen that fills the phone: one movable glass button
 * and the panel it opens beside itself.
 *
 * The button rests against the nearer side and, left alone, tucks half of
 * itself past the edge; its touches never reach the device. The panel holds
 * the device's own buttons, how the picture is turned and sized, volume,
 * settings and leaving. Glass is never faded (UIGlassEffect hollows out when
 * its opacity animates), so idle and opening use movement and scale only.
 */
import SegmentedControl from "@expo/ui/community/segmented-control";
import { GlassView } from "expo-glass-effect";
import {
  LogOut,
  Monitor,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/AppText";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";
import { BlurBackdrop } from "@/session/BlurBackdrop";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import {
  fontWeight,
  iconSize,
  iconStroke,
  radius,
  spacing,
  textStyles,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export interface LiveScreenAction {
  key: string;
  icon: LucideIcon;
  label: string;
  onPress(): void;
}

export type LiveScreenPicture = "fit" | "fill" | "zoom";

export interface LiveScreenControlsProps {
  platform?: string;
  name: string;
  status: { text: string; tone: "live" | "connecting" | "failed" };
  /** The device's own buttons, in the plugin's order (Home, App Switcher…). */
  actions: LiveScreenAction[];
  /** Volume down / up, when the device has them. */
  volume?: { down: LiveScreenAction; up: LiveScreenAction };
  /**
   * Turning the device a quarter at a time; absent when it cannot turn.
   * `follow` (when the device takes an absolute pose) turns it with the
   * phone; turning it by hand stops following.
   */
  orientation?: {
    following?: boolean;
    onFollow?(): void;
    rotate: { left: LiveScreenAction; right: LiveScreenAction };
  };
  /**
   * How the picture is sized. While `editing` a zoom, fingers zoom and pan
   * the picture instead of touching the device; `onDone` keeps that zoom.
   */
  picture: {
    value: LiveScreenPicture;
    editing: boolean;
    onChange(value: LiveScreenPicture): void;
    onDone(): void;
  };
  /** The device ignores input (view only, or not connected yet). */
  inputDisabled: boolean;
  onSettings(): void;
  onExit(): void;
  insets: { top: number; bottom: number; left: number; right: number };
  /** Another panel is showing: step aside until it closes. */
  hidden?: boolean;
  labels: {
    menu: string;
    orientation: string;
    follow: string;
    picture: string;
    pictures: Record<LiveScreenPicture, string>;
    zoomHint: string;
    zoomDone: string;
    volume: string;
    settings: string;
    exit: string;
  };
}

const BUTTON = 48;
const EDGE = spacing.sm;
/** Movement below this is a tap, not a drag. */
const TAP_SLOP = 6;
/** Left alone this long, the button tucks half of itself past the edge. */
const TUCK_MS = 2500;
const PANEL_WIDTH = 296;
const ACTION = 52;
const PICTURES: LiveScreenPicture[] = ["fit", "fill", "zoom"];

type Side = "left" | "right";
type Bounds = { left: number; right: number; top: number; bottom: number };

export function LiveScreenControls(props: LiveScreenControlsProps) {
  const { insets, hidden, labels } = props;
  const window = useWindowDimensions();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const reduceMotion = useReduceMotionEnabled();
  const [open, setOpen] = useState(false);
  const bounds = useMemo<Bounds>(
    () => ({
      left: insets.left + EDGE,
      right: window.width - insets.right - EDGE - BUTTON,
      top: insets.top + EDGE,
      bottom: window.height - insets.bottom - EDGE - BUTTON,
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
  // Where the button rests: a side and a fraction of the usable height, so a
  // rotation keeps it on the same side at the same relative place.
  const rest = useRef<{ side: Side; y: number }>({ side: "right", y: 0.62 });
  const [anchor, setAnchor] = useState(rest.current);
  const position = useRef(
    new Animated.ValueXY(restPoint(rest.current, bounds, false)),
  ).current;
  const tuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animate = (to: { x: number; y: number }) => {
    if (reduceMotion !== false) position.setValue(to);
    else
      Animated.spring(position, {
        toValue: to,
        useNativeDriver: false,
        friction: 8,
      }).start();
  };
  const animateRef = useRef(animate);
  animateRef.current = animate;
  const wake = () => {
    if (tuckTimer.current) clearTimeout(tuckTimer.current);
    tuckTimer.current = setTimeout(
      () =>
        animateRef.current(restPoint(rest.current, boundsRef.current, true)),
      TUCK_MS,
    );
  };
  const wakeRef = useRef(wake);
  wakeRef.current = wake;
  useEffect(() => {
    wakeRef.current();
    return () => {
      if (tuckTimer.current) clearTimeout(tuckTimer.current);
    };
  }, []);
  useEffect(() => {
    position.setValue(restPoint(rest.current, bounds, false));
    wakeRef.current();
  }, [bounds, position]);

  const pan = useMemo(() => {
    let start = { x: 0, y: 0 };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // The button keeps its gesture: nothing underneath may take it over.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        if (tuckTimer.current) clearTimeout(tuckTimer.current);
        position.stopAnimation();
        // A tucked button comes fully back out under the finger.
        start = restPoint(rest.current, boundsRef.current, false);
        position.setValue(start);
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
          setAnchor({ ...rest.current });
          setOpen(true);
          return;
        }
        const b = boundsRef.current;
        const x = clamp(start.x + g.dx, b.left, b.right);
        const y = clamp(start.y + g.dy, b.top, b.bottom);
        rest.current = {
          side:
            x + BUTTON / 2 < (b.left + b.right + BUTTON) / 2 ? "left" : "right",
          y: b.bottom > b.top ? (y - b.top) / (b.bottom - b.top) : 0,
        };
        animateRef.current(restPoint(rest.current, b, false));
        wakeRef.current();
      },
      onPanResponderTerminate: () => {
        position.setValue(restPoint(rest.current, boundsRef.current, false));
        wakeRef.current();
      },
    });
  }, [position]);

  const close = () => {
    setOpen(false);
    wakeRef.current();
  };
  const zooming = props.picture.editing;
  const DeviceIcon =
    props.platform === "ipados"
      ? Tablet
      : props.platform === "tvos"
        ? Monitor
        : Smartphone;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {zooming && !hidden && (
        <View
          pointerEvents="box-none"
          style={[styles.zoomBar, { top: insets.top + spacing.sm }]}
        >
          <Glass style={styles.zoomPill}>
            <Text numberOfLines={1} style={styles.zoomHint}>
              {labels.zoomHint}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={props.picture.onDone}
              hitSlop={spacing.sm}
              style={({ pressed }) => [
                styles.zoomDone,
                pressed && styles.pressed,
              ]}
              testID="liveScreen.zoomDone"
            >
              <Text style={styles.zoomDoneText}>{labels.zoomDone}</Text>
            </Pressable>
          </Glass>
        </View>
      )}
      {!open && !hidden && (
        <Animated.View
          {...pan.panHandlers}
          accessible
          accessibilityRole="button"
          accessibilityLabel={labels.menu}
          accessibilityActions={[{ name: "activate" }]}
          onAccessibilityAction={() => {
            setAnchor({ ...rest.current });
            setOpen(true);
          }}
          testID="liveScreen.controls"
          style={[
            styles.button,
            { transform: position.getTranslateTransform() },
          ]}
        >
          <Glass style={styles.buttonGlass}>
            <DeviceIcon
              size={iconSize.xl}
              strokeWidth={iconStroke.regular}
              color={colors.textPrimary}
            />
          </Glass>
        </Animated.View>
      )}
      {open && !hidden && (
        <LiveScreenPanel
          {...props}
          anchor={anchor}
          bounds={bounds}
          onClose={close}
          animated={reduceMotion === false}
        />
      )}
    </View>
  );
}

function LiveScreenPanel({
  name,
  status,
  actions,
  volume,
  orientation,
  picture,
  inputDisabled,
  onSettings,
  onExit,
  labels,
  insets,
  anchor,
  bounds,
  onClose,
  animated,
}: LiveScreenControlsProps & {
  anchor: { side: Side; y: number };
  bounds: Bounds;
  onClose(): void;
  animated: boolean;
}) {
  const window = useWindowDimensions();
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [height, setHeight] = useState(0);
  const scale = useRef(new Animated.Value(animated ? 0.92 : 1)).current;
  useEffect(() => {
    if (animated)
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        friction: 8,
        tension: 120,
      }).start();
  }, [animated, scale]);
  // A phone on its side has too little height for one column: the device
  // controls move beside the summary instead of below it.
  const wide = window.width > window.height;
  const width = Math.min(
    wide ? PANEL_WIDTH * 2 : PANEL_WIDTH,
    window.width - insets.left - insets.right - spacing.lg * 2,
  );
  // Beside the button, on the side it rests against, at its height.
  const button = restPoint(anchor, bounds, false);
  const left = clamp(
    anchor.side === "right"
      ? button.x - spacing.sm - width
      : button.x + BUTTON + spacing.sm,
    insets.left + spacing.lg,
    window.width - insets.right - spacing.lg - width,
  );
  const top = clamp(
    button.y + BUTTON / 2 - height / 2,
    insets.top + spacing.sm,
    window.height - insets.bottom - spacing.sm - height,
  );
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const dot =
    status.tone === "live"
      ? colors.statusReady
      : status.tone === "connecting"
        ? colors.statusAccent
        : colors.statusError;

  const footerControls = (
    <View style={styles.footer}>
      <FooterButton
        icon={SlidersHorizontal}
        label={labels.settings}
        color={colors.textPrimary}
        onPress={run(onSettings)}
        testID="liveScreen.settings"
      />
      <FooterButton
        icon={LogOut}
        label={labels.exit}
        color={colors.destructive}
        onPress={run(onExit)}
        testID="liveScreen.exit"
      />
    </View>
  );

  return (
    <Pressable
      // Tapping outside closes; VoiceOver uses its escape gesture.
      accessible={false}
      onPress={onClose}
      style={StyleSheet.absoluteFill}
      testID="liveScreen.panelBackdrop"
    >
      <Animated.View
        onLayout={({ nativeEvent }) => setHeight(nativeEvent.layout.height)}
        style={[
          styles.panel,
          {
            width,
            left,
            // Off screen until measured, so it never shows at the wrong
            // height (glass must not be faded in instead).
            top: height ? top : -window.height,
            transform: [{ scale }],
          },
        ]}
      >
        <Pressable
          // Taps between the controls must not close the panel.
          onPress={() => undefined}
          accessible={false}
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          testID="liveScreen.panel"
        >
          <Glass style={[styles.panelGlass, wide && styles.panelWide]}>
            <View style={wide ? styles.column : styles.stack}>
              <View style={styles.header}>
                <View style={[styles.dot, { backgroundColor: dot }]} />
                <View style={styles.headerText}>
                  <Text numberOfLines={1} style={styles.name}>
                    {name}
                  </Text>
                  <Text numberOfLines={1} style={styles.status}>
                    {status.text}
                  </Text>
                </View>
              </View>
              {actions.length > 0 && (
                <View style={styles.actions}>
                  {actions.map((action) => (
                    <ActionButton
                      key={action.key}
                      action={action}
                      disabled={inputDisabled}
                      onPress={run(action.onPress)}
                    />
                  ))}
                </View>
              )}
              {wide && <View style={styles.spacer} />}
              {wide && footerControls}
            </View>
            {wide && <View style={styles.verticalDivider} />}
            <View style={wide ? styles.column : styles.stack}>
              {orientation && (
                <Row label={labels.orientation}>
                  <View style={styles.volume}>
                    {orientation.onFollow && (
                      <Pressable
                        accessibilityRole="switch"
                        accessibilityLabel={labels.follow}
                        accessibilityState={{
                          checked: orientation.following === true,
                          disabled: inputDisabled,
                        }}
                        disabled={inputDisabled}
                        onPress={orientation.onFollow}
                        style={({ pressed }) => [
                          styles.follow,
                          orientation.following && styles.followOn,
                          pressed && styles.pressed,
                          inputDisabled && styles.disabled,
                        ]}
                        testID="liveScreen.follow"
                      >
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.followLabel,
                            orientation.following && styles.followLabelOn,
                          ]}
                        >
                          {labels.follow}
                        </Text>
                      </Pressable>
                    )}
                    {[orientation.rotate.left, orientation.rotate.right].map(
                      (action) => (
                        <ChipButton
                          key={action.key}
                          action={action}
                          disabled={inputDisabled}
                        />
                      ),
                    )}
                  </View>
                </Row>
              )}
              <Row label={labels.picture}>
                <SegmentedControl
                  values={PICTURES.map((value) => labels.pictures[value])}
                  selectedIndex={PICTURES.indexOf(picture.value)}
                  appearance={mode}
                  style={styles.segments}
                  onChange={({ nativeEvent }) => {
                    const value = PICTURES[nativeEvent.selectedSegmentIndex];
                    if (!value) return;
                    // Zooming takes over the fingers: close so they reach the picture.
                    if (value === "zoom") onClose();
                    picture.onChange(value);
                  }}
                  testID="liveScreen.picture"
                />
              </Row>
              {volume && (
                <Row label={labels.volume}>
                  <View style={styles.volume}>
                    {[volume.down, volume.up].map((action) => (
                      <ChipButton
                        key={action.key}
                        action={action}
                        disabled={inputDisabled}
                      />
                    ))}
                  </View>
                </Row>
              )}
              {!wide && <View style={styles.divider} />}
              {!wide && footerControls}
            </View>
          </Glass>
        </Pressable>
      </Animated.View>
    </Pressable>
  );
}

function ActionButton({
  action,
  disabled,
  onPress,
}: {
  action: LiveScreenAction;
  disabled: boolean;
  onPress(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const Icon = action.icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={`liveScreen.action.${action.key}`}
    >
      <View style={styles.actionCircle}>
        <Icon
          size={iconSize.xl}
          strokeWidth={iconStroke.regular}
          color={colors.textPrimary}
        />
      </View>
      <Text numberOfLines={1} style={styles.actionLabel}>
        {action.label}
      </Text>
    </Pressable>
  );
}

/** A pill that keeps the panel open, for presses that repeat. */
function ChipButton({
  action,
  disabled,
}: {
  action: LiveScreenAction;
  disabled: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const Icon = action.icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={action.onPress}
      style={({ pressed }) => [
        styles.volumeButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={`liveScreen.${action.key}`}
    >
      <Icon
        size={iconSize.lg}
        strokeWidth={iconStroke.regular}
        color={colors.textPrimary}
      />
    </Pressable>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text numberOfLines={1} style={styles.sectionLabel}>
        {label}
      </Text>
      <View style={styles.rowControl}>{children}</View>
    </View>
  );
}

function FooterButton({
  icon: Icon,
  label,
  color,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  color: string;
  onPress(): void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.footerButton, pressed && styles.pressed]}
      testID={testID}
    >
      <Icon size={iconSize.lg} strokeWidth={iconStroke.regular} color={color} />
      <Text style={[styles.footerLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** System Liquid Glass where available; otherwise the app's blurred sheet. */
function Glass({ style, children }: { style: object; children: ReactNode }) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const liquidGlass = useLiquidGlassAvailable();
  return liquidGlass ? (
    <GlassView colorScheme={mode} glassEffectStyle="regular" style={style}>
      {children}
    </GlassView>
  ) : (
    <View style={[style, styles.solid]}>
      <BlurBackdrop intensity={40} overlayColor={colors.sheetSurface} />
      {children}
    </View>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function restPoint(
  rest: { side: Side; y: number },
  b: Bounds,
  tucked: boolean,
) {
  // Tucked, half the button sits past the screen edge.
  const tuck = tucked ? BUTTON / 2 + EDGE : 0;
  return {
    x: rest.side === "left" ? b.left - tuck : Math.max(b.left, b.right) + tuck,
    y: b.top + clamp(rest.y, 0, 1) * Math.max(0, b.bottom - b.top),
  };
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
      position: "absolute",
      left: 0,
      top: 0,
      width: BUTTON,
      height: BUTTON,
    },
    buttonGlass: {
      flex: 1,
      borderRadius: radius.pill,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
    },
    solid: {
      overflow: "hidden",
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
    },
    panel: { position: "absolute" },
    panelGlass: {
      borderRadius: radius.container,
      overflow: "hidden",
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.lg,
      gap: spacing.md,
    },
    panelWide: { flexDirection: "row", gap: spacing.lg },
    stack: { gap: spacing.md },
    column: { flex: 1, gap: spacing.md },
    spacer: { flex: 1 },
    verticalDivider: {
      width: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    header: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    dot: { width: spacing.sm, height: spacing.sm, borderRadius: radius.pill },
    headerText: { flex: 1, minWidth: 0 },
    name: {
      ...textStyles.body,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
    },
    status: { ...textStyles.caption, color: colors.textTertiary },
    actions: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: spacing.xs,
    },
    action: { flex: 1, alignItems: "center", gap: spacing.xs },
    actionCircle: {
      width: ACTION,
      height: ACTION,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceChip,
      alignItems: "center",
      justifyContent: "center",
    },
    actionLabel: { ...textStyles.caption, color: colors.textSecondary },
    row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    sectionLabel: {
      ...textStyles.footnote,
      fontWeight: fontWeight.semibold,
      color: colors.textTertiary,
      width: spacing.xxl,
    },
    rowControl: { flex: 1 },
    segments: { height: spacing.xxl },
    volume: { flexDirection: "row", gap: spacing.sm },
    follow: {
      flex: 2,
      height: spacing.xxl,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceChip,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing.sm,
    },
    followOn: { backgroundColor: colors.cta },
    followLabel: {
      ...textStyles.bodySmall,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    followLabelOn: { color: colors.ctaText },
    volumeButton: {
      flex: 1,
      height: spacing.xxl,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceChip,
      alignItems: "center",
      justifyContent: "center",
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    footer: { flexDirection: "row", justifyContent: "space-between" },
    footerButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: BUTTON - spacing.xs,
      paddingHorizontal: spacing.xs,
    },
    footerLabel: { ...textStyles.body, fontWeight: fontWeight.medium },
    zoomBar: {
      position: "absolute",
      left: 0,
      right: 0,
      alignItems: "center",
    },
    zoomPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      borderRadius: radius.pill,
      overflow: "hidden",
      paddingLeft: spacing.lg,
      paddingRight: spacing.xs,
      paddingVertical: spacing.xs,
    },
    zoomHint: { ...textStyles.footnote, color: colors.textSecondary },
    zoomDone: {
      borderRadius: radius.pill,
      backgroundColor: colors.cta,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
    },
    zoomDoneText: {
      ...textStyles.bodySmall,
      fontWeight: fontWeight.medium,
      color: colors.ctaText,
    },
    pressed: { opacity: 0.6 },
    disabled: { opacity: 0.4 },
  });
