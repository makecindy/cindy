/**
 * Controls for a device screen that fills the phone: one movable glass button
 * and the panel it opens beside itself.
 *
 * The button rests against the nearer side and, left alone, tucks half of
 * itself past the edge; its touches never reach the device. The panel holds
 * the device's own buttons, how the picture is turned and sized, volume,
 * settings and going back. Glass is never faded (UIGlassEffect hollows out when
 * its opacity animates), so idle and opening use movement and scale only.
 *
 * With Liquid Glass the panel is laid out like Control Center: the screen
 * behind blurs and darkens, and every control is its own interactive glass
 * piece (one container, so neighbours blend) instead of flat fills on a glass
 * slab, which would put glass on glass. It is always dark there, like the
 * scrim under it. Without Liquid Glass it stays a frosted card.
 */
import SegmentedControl from "@expo/ui/community/segmented-control";
import { GlassContainer, GlassView } from "expo-glass-effect";
import {
  ChevronLeft,
  Monitor,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  type LucideIcon,
} from "lucide-react-native";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  ThemeOverrideProvider,
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
  /** A foldable's postures (closed, half open, flat), when the device has a hinge. */
  posture?: LiveScreenAction[];
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
  /** Leave the full screen for the page before it; the device keeps running. */
  onBack(): void;
  insets: { top: number; bottom: number; left: number; right: number };
  /** Another panel is showing: step aside until it closes. */
  hidden?: boolean;
  labels: {
    menu: string;
    orientation: string;
    follow: string;
    posture: string;
    picture: string;
    pictures: Record<LiveScreenPicture, string>;
    zoomHint: string;
    zoomDone: string;
    volume: string;
    settings: string;
    back: string;
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
/** The device's buttons, this many to a row; more start another row. */
const ACTIONS_PER_ROW = 4;

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    rows.push(items.slice(i, i + size));
  return rows;
}

type Side = "left" | "right";

/** Whether the open panel draws its controls as separate Liquid Glass. */
const PanelGlass = createContext(false);
type Bounds = { left: number; right: number; top: number; bottom: number };

export function LiveScreenControls(props: LiveScreenControlsProps) {
  const { insets, hidden, labels } = props;
  const window = useWindowDimensions();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const reduceMotion = useReduceMotionEnabled();
  const liquidGlass = useLiquidGlassAvailable();
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
          <Glass interactive style={styles.buttonGlass}>
            <DeviceIcon
              size={iconSize.xl}
              strokeWidth={iconStroke.regular}
              color={colors.textPrimary}
            />
          </Glass>
        </Animated.View>
      )}
      {open && !hidden && (
        <ThemeOverrideProvider mode={liquidGlass ? "dark" : null}>
          <PanelGlass.Provider value={liquidGlass}>
            <LiveScreenPanel
              {...props}
              anchor={anchor}
              bounds={bounds}
              onClose={close}
              animated={reduceMotion === false}
            />
          </PanelGlass.Provider>
        </ThemeOverrideProvider>
      )}
    </View>
  );
}

function LiveScreenPanel({
  name,
  status,
  actions,
  volume,
  posture,
  orientation,
  picture,
  inputDisabled,
  onSettings,
  onBack,
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
  const glass = useContext(PanelGlass);
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
      <Tile
        icon={ChevronLeft}
        label={labels.back}
        onPress={run(onBack)}
        style={styles.footerTile}
        testID="liveScreen.back"
      />
      <Tile
        icon={SlidersHorizontal}
        label={labels.settings}
        onPress={run(onSettings)}
        style={styles.footerTile}
        testID="liveScreen.settings"
      />
    </View>
  );
  const Slab = glass ? GlassContainer : Glass;

  return (
    <Pressable
      // Tapping outside closes; VoiceOver uses its escape gesture.
      accessible={false}
      onPress={onClose}
      style={StyleSheet.absoluteFill}
      testID="liveScreen.panelBackdrop"
    >
      {glass && <BlurBackdrop />}
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
          <Slab
            // Glass pieces moved by a relayout (one column to two) can lose
            // their effect: build them afresh for each shape instead.
            key={wide ? "wide" : "tall"}
            spacing={spacing.sm}
            style={[
              glass ? styles.panelOpen : styles.panelGlass,
              wide && styles.panelWide,
            ]}
          >
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
                <View style={styles.actionRows}>
                  {chunk(actions, ACTIONS_PER_ROW).map((row) => (
                    <View key={row[0].key} style={styles.actions}>
                      {row.map((action) => (
                        <ActionButton
                          key={action.key}
                          action={action}
                          disabled={inputDisabled}
                          onPress={run(action.onPress)}
                        />
                      ))}
                      {/* Keep a short last row on the same columns as the rows above. */}
                      {actions.length > ACTIONS_PER_ROW &&
                        Array.from(
                          { length: ACTIONS_PER_ROW - row.length },
                          (_, index) => (
                            <View key={`gap-${index}`} style={styles.action} />
                          ),
                        )}
                    </View>
                  ))}
                </View>
              )}
              {wide && <View style={styles.spacer} />}
              {wide && footerControls}
            </View>
            {wide && !glass && <View style={styles.verticalDivider} />}
            <View style={wide ? styles.column : styles.stack}>
              {orientation && (
                <Row label={labels.orientation}>
                  <View style={styles.volume}>
                    {orientation.onFollow && (
                      <Tile
                        role="switch"
                        on={orientation.following === true}
                        label={labels.follow}
                        disabled={inputDisabled}
                        onPress={orientation.onFollow}
                        style={styles.follow}
                        testID="liveScreen.follow"
                      />
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
              {posture && (
                <Row label={labels.posture}>
                  <View style={styles.volume}>
                    {posture.map((action) => (
                      <ChipButton
                        key={action.key}
                        action={action}
                        disabled={inputDisabled}
                      />
                    ))}
                  </View>
                </Row>
              )}
              <Row label={labels.picture}>
                <SegmentedControl
                  values={PICTURES.map((value) => labels.pictures[value])}
                  selectedIndex={PICTURES.indexOf(picture.value)}
                  appearance={glass ? "dark" : mode}
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
              {!wide && !glass && <View style={styles.divider} />}
              {!wide && footerControls}
            </View>
          </Slab>
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
  const glass = useContext(PanelGlass);
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
        pressed && !glass && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={`liveScreen.action.${action.key}`}
    >
      <Surface style={styles.actionCircle}>
        <Icon
          size={iconSize.xl}
          strokeWidth={iconStroke.regular}
          color={colors.textPrimary}
        />
      </Surface>
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
  const styles = useThemedStyles(makeStyles);
  return (
    <Tile
      icon={action.icon}
      label={action.label}
      iconOnly
      disabled={disabled}
      onPress={action.onPress}
      style={styles.chip}
      testID={`liveScreen.${action.key}`}
    />
  );
}

/**
 * One control: a glass piece of its own with Liquid Glass (the system lights
 * and stretches it under the finger), a filled pill otherwise. `on` marks a
 * switch that is on with the prominent fill.
 */
function Tile({
  icon: Icon,
  label,
  iconOnly = false,
  color,
  role = "button",
  on,
  disabled = false,
  onPress,
  style,
  testID,
}: {
  icon?: LucideIcon;
  label: string;
  iconOnly?: boolean;
  color?: string;
  role?: "button" | "switch";
  on?: boolean;
  disabled?: boolean;
  onPress(): void;
  style: object;
  testID: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const glass = useContext(PanelGlass);
  const foreground = on ? colors.ctaText : (color ?? colors.textPrimary);
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={
        role === "switch" ? { checked: on === true, disabled } : { disabled }
      }
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        style,
        pressed && !glass && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Surface on={on} style={styles.tileSurface}>
        {Icon && (
          <Icon
            size={iconSize.lg}
            strokeWidth={iconStroke.regular}
            color={foreground}
          />
        )}
        {!iconOnly && (
          <Text
            numberOfLines={1}
            style={[styles.tileLabel, { color: foreground }]}
          >
            {label}
          </Text>
        )}
      </Surface>
    </Pressable>
  );
}

/** The fill under one control: interactive Liquid Glass, or a chip fill. */
function Surface({
  on,
  style,
  children,
}: {
  on?: boolean;
  style: object;
  children: ReactNode;
}) {
  const { colors, mode } = useTheme();
  const glass = useContext(PanelGlass);
  return glass ? (
    <GlassView
      colorScheme={mode}
      glassEffectStyle="regular"
      isInteractive
      tintColor={on ? colors.cta : undefined}
      style={style}
    >
      {children}
    </GlassView>
  ) : (
    <View
      style={[style, { backgroundColor: on ? colors.cta : colors.surfaceChip }]}
    >
      {children}
    </View>
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

/** System Liquid Glass where available; otherwise the app's blurred sheet. */
function Glass({
  interactive = false,
  style,
  children,
}: {
  interactive?: boolean;
  spacing?: number;
  style: object;
  children: ReactNode;
}) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const liquidGlass = useLiquidGlassAvailable();
  return liquidGlass ? (
    <GlassView
      colorScheme={mode}
      glassEffectStyle="regular"
      isInteractive={interactive}
      style={style}
    >
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
    // Liquid Glass: no slab, only the pieces over the blurred screen.
    panelOpen: { paddingVertical: spacing.sm, gap: spacing.md },
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
    actionRows: { gap: spacing.sm },
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
      overflow: "hidden",
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
    follow: { flex: 2, height: spacing.xxl },
    chip: { flex: 1, height: spacing.xxl },
    tileSurface: {
      flex: 1,
      flexDirection: "row",
      gap: spacing.sm,
      borderRadius: radius.pill,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing.sm,
    },
    tileLabel: { ...textStyles.bodySmall, fontWeight: fontWeight.medium },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    footer: { flexDirection: "row", gap: spacing.sm },
    footerTile: { flex: 1, height: BUTTON - spacing.xs },
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
