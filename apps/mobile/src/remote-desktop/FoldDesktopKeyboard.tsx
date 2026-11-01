import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import {
  ArrowBigUp,
  ArrowBigUpDash,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  CornerDownLeft,
  Delete,
  Ellipsis,
  Keyboard,
  Option,
  Redo2,
  Undo2,
  ArrowRightToLine,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { FoldTouchpad } from "./FoldTouchpad";
import {
  FOLD_CAPS,
  FOLD_FN,
  FoldKeyInput,
  foldFnCode,
  type FoldKeyEvent,
  type FoldKeyLatch,
} from "./foldKeyboardInput";
import {
  FOLD_ESCAPE,
  FOLD_FN_CELL,
  foldKeyAt,
  foldKeyRects,
  foldKeyboardRows,
  type FoldHostPlatform,
  type FoldKeyRect,
} from "./foldKeyboardLayout";

export type FoldSystemAction = {
  id: string;
  label: string;
  Icon: LucideIcon;
  press(): void;
};

const INPUT_METHOD = "inputMethod";
const HINT_WIDTH = 160;
const FN_LEGENDS: Record<string, string> = {
  Delete: "Del",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
};
const KEY_ICONS: Record<string, LucideIcon> = {
  Backspace: Delete,
  Tab: ArrowRightToLine,
  [FOLD_CAPS]: ArrowBigUpDash,
  Enter: CornerDownLeft,
  ShiftLeft: ArrowBigUp,
  ArrowLeft: ChevronLeft,
  ArrowRight: ChevronRight,
  ArrowUp: ChevronUp,
  ArrowDown: ChevronDown,
};
const MAC_ICONS: Record<string, LucideIcon> = {
  ControlLeft: ChevronUp,
  AltLeft: Option,
  MetaLeft: Command,
};
const PC_LEGENDS: Record<string, string> = {
  ControlLeft: "Ctrl",
  AltLeft: "Alt",
};

const Keycap = memo(function Keycap({
  rect,
  legend,
  shifted,
  Icon,
  label,
  subdued,
  pressed,
  latch,
  onActivate,
}: {
  rect: FoldKeyRect;
  legend?: string;
  shifted?: string;
  Icon?: LucideIcon;
  label: string;
  subdued: boolean;
  pressed: boolean;
  latch: FoldKeyLatch | null;
  onActivate(id: string): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const selected = latch !== null;
  const foreground = selected
    ? colors.ctaText
    : rect.bare || subdued
      ? colors.textSecondary
      : colors.textPrimary;
  const small = (legend?.length ?? 0) > 1;
  return (
    <View
      testID={`remoteDesktop.foldKey.${rect.id}`}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => onActivate(rect.id)}
      style={[
        styles.key,
        subdued && styles.keySubdued,
        rect.bare && styles.keyBare,
        pressed && styles.keyPressed,
        selected && styles.keySelected,
        {
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        },
      ]}
    >
      {shifted ? (
        <Text
          numberOfLines={1}
          style={[styles.shiftedLegend, selected && { color: foreground }]}
        >
          {shifted}
        </Text>
      ) : null}
      {Icon ? (
        <Icon
          size={rect.half ? iconSize.sm : iconSize.action}
          strokeWidth={iconStroke.regular}
          color={foreground}
        />
      ) : legend ? (
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          style={[
            small || shifted ? styles.smallLegend : styles.legend,
            { color: foreground },
          ]}
        >
          {legend}
        </Text>
      ) : null}
      {latch === "locked" ? (
        <View style={[styles.lockMark, { backgroundColor: foreground }]} />
      ) : null}
    </View>
  );
});

function RoundButton({
  testID,
  label,
  Icon,
  disabled,
  onPress,
}: {
  testID: string;
  label: string;
  Icon: LucideIcon;
  disabled?: boolean;
  onPress(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        pressed && styles.keyPressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon
        size={iconSize.action}
        strokeWidth={iconStroke.regular}
        color={colors.textPrimary}
      />
    </Pressable>
  );
}

/** The default tabletop deck: a full keyboard and trackpad that follow the app theme. */
export function FoldDesktopKeyboard({
  platform,
  enabled,
  allowInput,
  send,
  systemActions,
  undo,
  redo,
  keyLabel,
  onInputMethod,
  onOperations,
  clipboard,
  safeInsets,
  bottomReserve = 0,
}: {
  platform: FoldHostPlatform;
  enabled: boolean;
  allowInput(): boolean;
  send(message: object): void;
  systemActions: FoldSystemAction[];
  undo(): void;
  redo(): void;
  keyLabel(code: string): string;
  onInputMethod(): void;
  onOperations(): void;
  clipboard: ReactNode;
  safeInsets: { top: number; bottom: number; left: number; right: number };
  bottomReserve?: number;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const surface = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  const input = useRef(new FoldKeyInput()).current;
  const touches = useRef(new Map<string | number, FoldKeyRect>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
  const [, refresh] = useState(0);

  const actions = useMemo(() => {
    const entries: Record<string, () => void> = {
      undo,
      redo,
      [INPUT_METHOD]: onInputMethod,
    };
    for (const action of systemActions) entries[action.id] = action.press;
    return entries;
  }, [undo, redo, onInputMethod, systemActions]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const systemKey = systemActions.map((action) => action.id).join();
  const rects = useMemo(() => {
    const functionRow = [
      FOLD_ESCAPE,
      ...systemKey
        .split(",")
        .filter(Boolean)
        .map((id, index) => ({
          id,
          weight: 1,
          bare: true,
          groupGap: index === 0 ? 0.6 : 0,
        })),
      { id: "undo", weight: 1, bare: true, groupGap: 0.6 },
      { id: "redo", weight: 1, bare: true },
      FOLD_FN_CELL,
      { id: INPUT_METHOD, weight: 1, bare: true },
    ];
    return foldKeyRects(
      foldKeyboardRows(platform, functionRow),
      size.width,
      size.height,
    );
  }, [platform, systemKey, size.width, size.height]);
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  const emit = (events: FoldKeyEvent[]) => {
    if (events.length) send({ type: "events", events });
  };
  const showPressed = () => {
    setPressed(new Set([...touches.current.values()].map((rect) => rect.id)));
    refresh((value) => value + 1);
  };
  const begin = (touch: string | number, rect: FoldKeyRect) => {
    if (touches.current.has(touch)) return;
    touches.current.set(touch, rect);
    if (rect.code && allowInput()) emit(input.press(touch, rect.code));
    showPressed();
  };
  const finish = (touch: string | number, cancelled: boolean) => {
    const rect = touches.current.get(touch);
    if (!rect) return;
    touches.current.delete(touch);
    emit(input.release(touch, cancelled));
    if (!rect.code && !cancelled && allowInput())
      actionsRef.current[rect.id]?.();
    showPressed();
  };
  const touchId = (event: GestureResponderEvent) =>
    event.nativeEvent.identifier ?? "touch";

  // Keys never outlive the deck: a skin change, unfold or disconnect lets go.
  useEffect(() => {
    if (enabled) return;
    input.reset();
    touches.current.clear();
    setPressed(new Set());
    send({ type: "releaseInput" });
  }, [enabled, input, send]);
  useEffect(
    () => () => {
      input.reset();
      touches.current.clear();
      send({ type: "releaseInput" });
    },
    [input, send],
  );

  const label = (rect: FoldKeyRect) => {
    if (rect.id === INPUT_METHOD) return t("remoteDesktop.inputMethod");
    if (rect.id === "undo") return t("remoteDesktop.keyUndo");
    if (rect.id === "redo") return t("remoteDesktop.keyRedo");
    const system = systemActions.find((action) => action.id === rect.id);
    if (system) return system.label;
    if (rect.id === FOLD_FN) return "Fn";
    if (rect.id === FOLD_CAPS) return "Caps Lock";
    if (rect.id === "Space") return t("remoteDesktop.keySpace");
    return keyLabel(rect.code ?? rect.id);
  };
  const legend = (rect: FoldKeyRect, fn: boolean, uppercase: boolean) => {
    if (fn && rect.code) {
      const resolved = foldFnCode(rect.code);
      if (resolved !== rect.code) return FN_LEGENDS[resolved] ?? resolved;
    }
    if (rect.legend)
      return /^Key/.test(rect.id) && !uppercase
        ? rect.legend.toLowerCase()
        : rect.legend;
    if (rect.id === "Escape") return "esc";
    if (rect.id === FOLD_FN) return "fn";
    if (rect.code === "MetaLeft") return platform === "win32" ? "Win" : "Super";
    return rect.code ? PC_LEGENDS[rect.code] : undefined;
  };
  const icon = (rect: FoldKeyRect, fn: boolean) => {
    if (rect.id === INPUT_METHOD) return Keyboard;
    if (rect.id === "undo") return Undo2;
    if (rect.id === "redo") return Redo2;
    const system = systemActions.find((action) => action.id === rect.id);
    if (system) return system.Icon;
    if (!rect.code) return undefined;
    if (fn && foldFnCode(rect.code) !== rect.code) return undefined;
    return (
      KEY_ICONS[rect.code] ??
      (platform === "darwin" ? MAC_ICONS[rect.code] : undefined)
    );
  };
  // Icons carry no words, so holding one names it before the finger lifts.
  const hint = rects.find((rect) => !rect.code && pressed.has(rect.id));
  const fn = input.latch(FOLD_FN) !== null;
  const uppercase = input.uppercase();
  const activateRef = useRef((_id: string) => {});
  activateRef.current = (id) => {
    const rect = rectsRef.current.find((item) => item.id === id);
    if (!rect) return;
    begin("accessibility", rect);
    finish("accessibility", false);
  };
  const activate = useCallback((id: string) => activateRef.current(id), []);

  return (
    <View
      testID="remoteDesktop.foldKeyboard"
      style={[
        styles.deck,
        {
          paddingTop: safeInsets.top + spacing.sm,
          paddingBottom: safeInsets.bottom + bottomReserve + spacing.sm,
          paddingLeft: safeInsets.left + spacing.sm,
          paddingRight: safeInsets.right + spacing.sm,
        },
        !enabled && styles.disabled,
      ]}
    >
      <View
        ref={surface}
        testID="remoteDesktop.foldKeys"
        style={styles.keys}
        onLayout={({ nativeEvent: { layout } }) => {
          setSize({ width: layout.width, height: layout.height });
          surface.current?.measureInWindow?.((x, y) => {
            origin.current = { x, y };
          });
        }}
        onTouchStart={(event) => {
          if (!enabled) return;
          const { pageX, pageY } = event.nativeEvent;
          const rect = foldKeyAt(
            rectsRef.current,
            pageX - origin.current.x,
            pageY - origin.current.y,
          );
          if (rect) begin(touchId(event), rect);
        }}
        onTouchEnd={(event) => finish(touchId(event), false)}
        onTouchCancel={(event) => finish(touchId(event), true)}
      >
        {rects.map((rect) => (
          <Keycap
            key={rect.id}
            rect={rect}
            legend={legend(rect, fn, uppercase)}
            shifted={
              fn && rect.code && foldFnCode(rect.code) !== rect.code
                ? undefined
                : rect.shifted
            }
            Icon={icon(rect, fn)}
            label={label(rect)}
            subdued={!rect.legend && rect.id !== "Space" && !rect.bare}
            pressed={pressed.has(rect.id)}
            latch={rect.code ? input.latch(rect.code) : null}
            onActivate={activate}
          />
        ))}
        {hint ? (
          <View
            pointerEvents="none"
            testID="remoteDesktop.foldKeyHint"
            style={[
              styles.hint,
              {
                top: hint.y + hint.height + 2,
                left: Math.max(
                  0,
                  Math.min(
                    size.width - HINT_WIDTH,
                    hint.x + (hint.width - HINT_WIDTH) / 2,
                  ),
                ),
              },
            ]}
          >
            <Text numberOfLines={1} style={styles.hintText}>
              {label(hint)}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.lower}>
        <View style={styles.side}>
          <View style={styles.round}>{clipboard}</View>
        </View>
        <View style={styles.padZone}>
          <View pointerEvents="none" style={styles.pad} />
          {/* The whole palm rest moves the pointer; a thumb need not land on the visible pad. */}
          <View style={StyleSheet.absoluteFill}>
            <FoldTouchpad send={send} enabled={enabled} bare />
          </View>
        </View>
        <View style={styles.side}>
          <RoundButton
            testID="remoteDesktop.foldOperations"
            label={t("remoteDesktop.operations")}
            Icon={Ellipsis}
            onPress={onOperations}
          />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    deck: {
      flex: 1,
      gap: spacing.md,
      backgroundColor: colors.surface,
    },
    keys: { flex: 68, minHeight: 0 },
    key: {
      position: "absolute",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      borderRadius: radius.control,
      backgroundColor: colors.surfaceChip,
    },
    keySubdued: {
      backgroundColor: colors.surfaceElevated,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderTranslucent,
    },
    keyBare: { backgroundColor: "transparent", borderRadius: radius.pill },
    keyPressed: { backgroundColor: colors.border },
    keySelected: { backgroundColor: colors.cta },
    legend: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
    },
    smallLegend: {
      fontSize: typeScale.micro,
      lineHeight: lineHeight.micro,
      fontWeight: fontWeight.regular,
      paddingHorizontal: 2,
    },
    shiftedLegend: {
      fontSize: typeScale.micro,
      lineHeight: lineHeight.micro,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
    lockMark: {
      position: "absolute",
      bottom: 3,
      width: 12,
      height: 2,
      borderRadius: radius.pill,
    },
    lower: {
      flex: 32,
      minHeight: 96,
      flexDirection: "row",
      alignItems: "stretch",
    },
    padZone: { flex: 1, alignItems: "center" },
    // Close to a laptop trackpad's proportions, set by the deck height.
    pad: {
      height: "100%",
      aspectRatio: 1.6,
      maxWidth: "100%",
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderTranslucent,
      backgroundColor: colors.surfaceElevated,
    },
    side: { width: 44, justifyContent: "flex-end" },
    round: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
    },
    hint: {
      position: "absolute",
      width: HINT_WIDTH,
      alignItems: "center",
    },
    hintText: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      overflow: "hidden",
      backgroundColor: colors.surfaceGlassPanel,
    },
    disabled: { opacity: 0.4 },
  });
