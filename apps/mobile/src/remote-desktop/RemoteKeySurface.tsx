import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { StyleSheet, View, type GestureResponderEvent } from "react-native";
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
  type ThemeColors,
} from "@/theme";
import {
  KEY_CAPS,
  KEY_FN,
  RemoteKeyInput,
  fnLayerCode,
  type RemoteKeyEvent,
  type KeyLatch,
} from "./remoteKeyInput";
import {
  ESCAPE_CELL,
  FN_CELL,
  KEY_PAGE,
  classicKeyboardRows,
  keyAt,
  keyRects,
  keyboardRows,
  type KeyStrip,
  type HostPlatform,
  type KeyCell,
  type KeyRect,
} from "./remoteKeyLayout";

export type SystemKeyAction = {
  id: string;
  label: string;
  Icon: LucideIcon;
  press(): void;
};

const INPUT_METHOD = "inputMethod";
const HINT_WIDTH = 160;
const STRIP_END = "stripEnd.";
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
  [KEY_CAPS]: ArrowBigUpDash,
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
  styles,
  palette,
  legend,
  shifted,
  Icon,
  label,
  subdued,
  pressed,
  latch,
  artwork,
  onActivate,
  disabled,
}: {
  rect: KeyRect;
  styles: ReturnType<typeof makeStyles>;
  palette: ThemeColors;
  legend?: string;
  shifted?: string;
  Icon?: LucideIcon;
  label: string;
  subdued: boolean;
  pressed: boolean;
  latch: KeyLatch | null;
  artwork: ReactNode;
  onActivate(id: string): void;
  disabled: boolean;
}) {
  const selected = latch !== null;
  const foreground = selected
    ? palette.ctaText
    : rect.bare || (subdued && !artwork)
      ? palette.textSecondary
      : palette.textPrimary;
  const small = (legend?.length ?? 0) > 1;
  return (
    <View
      testID={`remoteDesktop.key.${rect.id}`}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => onActivate(rect.id)}
      style={[
        styles.key,
        subdued && styles.keySubdued,
        rect.bare && styles.keyBare,
        artwork ? styles.keyArtwork : null,
        pressed && (artwork ? styles.keyArtworkPressed : styles.keyPressed),
        selected && styles.keySelected,
        {
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        },
      ]}
    >
      {selected ? null : artwork}
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

/**
 * The one remote keyboard: its layout, multi-finger input and function strip are
 * shared, while callers supply the size, compact layout and material around it.
 */
export function RemoteKeySurface({
  platform,
  enabled,
  allowInput,
  send,
  systemActions,
  undo,
  redo,
  keyLabel,
  onInputMethod,
  compact = false,
  mode = "keyboard",
  strip,
  stripEnd,
  palette,
  renderKeycap,
  renderOverlay,
  testID = "remoteDesktop.keys",
  resyncRef,
}: {
  platform: HostPlatform;
  enabled: boolean;
  allowInput(): boolean;
  send(message: object): void;
  systemActions: SystemKeyAction[];
  undo(): void;
  redo(): void;
  keyLabel(code: string): string;
  /** Adds the strip's key for the phone's own keyboard. */
  onInputMethod?: () => void;
  compact?: boolean;
  /**
   * classic: typing keys only, for hardware skins.
   * bar: only the top row, as an accessory above the phone's own keyboard.
   */
  mode?: "keyboard" | "classic" | "bar";
  strip?: KeyStrip;
  /** Non-key controls that take even cells at the strip's end, after a group gap. */
  stripEnd?: ReactNode[];
  /** Hardware skins keep their own colors in either app theme. */
  palette?: ThemeColors;
  renderKeycap?: (rect: KeyRect) => ReactNode;
  renderOverlay?: (rects: KeyRect[]) => ReactNode;
  testID?: string;
  /**
   * Filled with a function that presses again whatever this surface still holds.
   * The screen calls it after an action that released every host key.
   */
  resyncRef?: MutableRefObject<(() => void) | null>;
}) {
  const { t } = useTranslation();
  const { colors: themeColors } = useTheme();
  const colors = palette ?? themeColors;
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const input = useRef(new RemoteKeyInput()).current;
  const touches = useRef(new Map<string | number, KeyRect>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
  const [symbols, setSymbols] = useState(false);
  const [, refresh] = useState(0);

  const actions = useMemo(() => {
    const entries: Record<string, () => void> = {
      undo,
      redo,
      [KEY_PAGE]: () => setSymbols((value) => !value),
    };
    if (onInputMethod) entries[INPUT_METHOD] = onInputMethod;
    for (const action of systemActions) entries[action.id] = action.press;
    return entries;
  }, [undo, redo, onInputMethod, systemActions]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const systemKey = systemActions.map((action) => action.id).join();
  const hasInputMethod = Boolean(onInputMethod);
  const stripEndCount = stripEnd?.length ?? 0;
  const stripKey = strip ? `${strip.height},${strip.left},${strip.right}` : "";
  const allRects = useMemo(() => {
    if (mode === "classic")
      return keyRects(
        classicKeyboardRows(platform),
        size.width,
        size.height,
        false,
      );
    const gap = compact ? 0.3 : 0.6;
    const bareKey = (code: string): KeyCell => ({
      id: code,
      code,
      weight: 1,
      bare: true,
    });
    const typingStrip: KeyCell[] =
      mode === "bar"
        ? [
            ESCAPE_CELL,
            bareKey("Tab"),
            { ...bareKey("ArrowLeft"), groupGap: gap },
            bareKey("ArrowUp"),
            bareKey("ArrowDown"),
            bareKey("ArrowRight"),
          ]
        : [
            ESCAPE_CELL,
            ...(compact ? [bareKey("Tab")] : []),
            // A phone's bar has no room for these; the toolbar has them a tap away.
            ...(compact && strip
              ? []
              : systemKey
                  .split(",")
                  .filter(Boolean)
                  .map((id, index) => ({
                    id,
                    weight: 1,
                    bare: true,
                    groupGap: index === 0 ? gap : 0,
                  }))),
            { id: "undo", weight: 1, bare: true, groupGap: gap },
            { id: "redo", weight: 1, bare: true },
            { ...FN_CELL, groupGap: gap },
            ...(hasInputMethod
              ? [{ id: INPUT_METHOD, weight: 1, bare: true }]
              : []),
            ...Array.from({ length: stripEndCount }, (_, index) => ({
              id: `${STRIP_END}${index}`,
              weight: 1,
              bare: true,
              groupGap: index === 0 ? gap : 0,
            })),
          ];
    const rows =
      mode === "bar"
        ? [typingStrip]
        : keyboardRows(platform, typingStrip, compact, symbols);
    return keyRects(rows, size.width, size.height, strip ?? {});
    // stripKey stands for the strip's values, which callers rebuild each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stripEndCount,
    platform,
    systemKey,
    hasInputMethod,
    compact,
    symbols,
    size,
    mode,
    stripKey,
  ]);
  const rects = useMemo(
    () => allRects.filter((rect) => !rect.id.startsWith(STRIP_END)),
    [allRects],
  );
  if (resyncRef) resyncRef.current = () => emit(input.resync());
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  const emit = (events: RemoteKeyEvent[]) => {
    if (events.length) send({ type: "events", events });
  };
  const showPressed = () => {
    setPressed(new Set([...touches.current.values()].map((rect) => rect.id)));
    refresh((value) => value + 1);
  };
  const begin = (touch: string | number, rect: KeyRect) => {
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
    if (!rect.code && !cancelled && (rect.id === KEY_PAGE || allowInput())) {
      // A shortcut must reach the host alone: a key still down would change it.
      if (rect.id !== KEY_PAGE) emit(input.suspend());
      actionsRef.current[rect.id]?.();
      // Shortcuts bypass this input, so restore what it still holds.
      if (rect.id !== KEY_PAGE) emit(input.resync());
    }
    showPressed();
  };
  const touchId = (event: GestureResponderEvent) =>
    event.nativeEvent.identifier ?? "touch";

  // Keys never outlive the surface: a skin change, unfold or disconnect lets go.
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

  const label = (rect: KeyRect) => {
    if (rect.id === INPUT_METHOD) return t("remoteDesktop.inputMethod");
    if (rect.id === "undo") return t("remoteDesktop.keyUndo");
    if (rect.id === "redo") return t("remoteDesktop.keyRedo");
    if (rect.id === KEY_PAGE)
      return symbols ? "ABC" : t("remoteDesktop.functionKeys");
    const system = systemActions.find((action) => action.id === rect.id);
    if (system) return system.label;
    if (rect.id === KEY_FN) return "Fn";
    if (rect.id === KEY_CAPS) return "Caps Lock";
    if (rect.id === "Space") return t("remoteDesktop.keySpace");
    return keyLabel(rect.code ?? rect.id);
  };
  const legend = (rect: KeyRect, fn: boolean, uppercase: boolean) => {
    if (fn && rect.code) {
      const resolved = fnLayerCode(rect.code);
      if (resolved !== rect.code) return FN_LEGENDS[resolved] ?? resolved;
    }
    if (rect.legend)
      return /^Key/.test(rect.id) && !uppercase && mode !== "classic"
        ? rect.legend.toLowerCase()
        : rect.legend;
    if (rect.id === "Escape") return "esc";
    if (rect.id === KEY_FN) return "fn";
    if (rect.code === "MetaLeft") return platform === "win32" ? "Win" : "Super";
    return rect.code ? PC_LEGENDS[rect.code] : undefined;
  };
  const icon = (rect: KeyRect, fn: boolean) => {
    if (rect.id === INPUT_METHOD) return Keyboard;
    if (rect.id === "undo") return Undo2;
    if (rect.id === "redo") return Redo2;
    const system = systemActions.find((action) => action.id === rect.id);
    if (system) return system.Icon;
    if (!rect.code || rect.legend !== undefined) return undefined;
    if (fn && fnLayerCode(rect.code) !== rect.code) return undefined;
    return (
      KEY_ICONS[rect.code] ??
      (platform === "darwin" ? MAC_ICONS[rect.code] : undefined)
    );
  };
  // Icons carry no words, so holding one names it before the finger lifts.
  const hint = rects.find(
    (rect) => rect.bare && !rect.code && pressed.has(rect.id),
  );
  const fn = input.latch(KEY_FN) !== null;
  const uppercase = input.uppercase();
  const activateRef = useRef((_id: string) => {});
  activateRef.current = (id) => {
    // A view-only deck still shows its keys; they must not offer actions.
    if (!enabled) return;
    const rect = rectsRef.current.find((item) => item.id === id);
    if (!rect) return;
    begin("accessibility", rect);
    finish("accessibility", false);
  };
  const activate = useCallback((id: string) => activateRef.current(id), []);

  const keys = (
    // box-only keeps every finger's target and location on this one surface:
    // Android reports later fingers against the first finger's view.
    <View
      testID={testID}
      pointerEvents="box-only"
      style={styles.surface}
      onLayout={({ nativeEvent: { layout } }) =>
        setSize({ width: layout.width, height: layout.height })
      }
      onTouchStart={(event) => {
        if (!enabled) return;
        const { locationX, locationY } = event.nativeEvent;
        const rect = keyAt(rectsRef.current, locationX, locationY);
        if (rect) begin(touchId(event), rect);
      }}
      onTouchEnd={(event) => finish(touchId(event), false)}
      onTouchCancel={(event) => finish(touchId(event), true)}
    >
      {rects.map((rect) => (
        <Keycap
          key={rect.id}
          rect={rect}
          styles={styles}
          palette={colors}
          legend={legend(rect, fn, uppercase)}
          shifted={
            fn && rect.code && fnLayerCode(rect.code) !== rect.code
              ? undefined
              : rect.shifted
          }
          Icon={icon(rect, fn)}
          label={label(rect)}
          subdued={
            !rect.bare &&
            (Boolean(rect.control) || (!rect.legend && rect.id !== "Space"))
          }
          pressed={pressed.has(rect.id)}
          latch={rect.code ? input.latch(rect.code) : null}
          artwork={rect.bare ? null : renderKeycap?.(rect)}
          onActivate={activate}
          disabled={!enabled}
        />
      ))}
      {renderOverlay?.(rects)}
      {hint ? (
        <View
          testID="remoteDesktop.keyHint"
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
  );
  if (!stripEnd?.length) return keys;
  // Beside the box-only surface, not in it, so these keep their own touches.
  return (
    <View pointerEvents="box-none" style={styles.surface}>
      {keys}
      {stripEnd.map((node, index) => {
        const cell = allRects.find(
          (rect) => rect.id === `${STRIP_END}${index}`,
        );
        return cell ? (
          <View
            key={cell.id}
            style={[
              styles.stripEnd,
              {
                left: cell.x,
                top: cell.y,
                width: cell.width,
                height: cell.height,
              },
            ]}
          >
            {node}
          </View>
        ) : null;
      })}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    surface: { flex: 1, minHeight: 0 },
    stripEnd: {
      position: "absolute",
      alignItems: "center",
      justifyContent: "center",
    },
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
    keyArtwork: {
      backgroundColor: "transparent",
      borderWidth: 0,
      paddingBottom: spacing.xs,
    },
    keyPressed: { backgroundColor: colors.border },
    keyArtworkPressed: { opacity: 0.55 },
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
  });
