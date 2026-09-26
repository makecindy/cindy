import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/AppText";
import Svg, { Circle, Path } from "react-native-svg";
import { useTranslation } from "react-i18next";
import {
  emptyRateHistory,
  loadCachedRateHistory,
  recordRunningTokenRate,
  saveCachedRateHistory,
  RATE_SAMPLE_FRESH_MS,
  type RateHistory,
} from "@cindy/maker-shared/usage-format";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import {
  fontWeight,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme/tokens";
import { usePaneViewport } from "@/platform/AdaptiveWindowContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LayoutRect } from "@/platform/windowGeometry";

export function formatTokenRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return "—";
  if (rate === 0) return "0";
  return rate < 0.1
    ? "<0.1"
    : rate >= 100
      ? rate.toFixed(0)
      : rate.toFixed(1).replace(/\.0$/, "");
}

/** Key this component by account/device/session so gestures and counters never cross tasks. */
export function RunningTokenRatePopover({
  sessionKey,
  startedAt,
  outputTokens,
  generationDurationMs,
  generationReliable,
  children,
  label,
  availableRegion,
  enabled = true,
  history: managedHistory,
}: {
  sessionKey: string;
  startedAt: number | null;
  outputTokens: number;
  generationDurationMs: number;
  generationReliable: boolean;
  children: ReactNode;
  label: string;
  availableRegion?: LayoutRect;
  enabled?: boolean;
  /** When the status row already sampled, reuse that history instead of recording twice. */
  history?: RateHistory;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const viewport = usePaneViewport();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const anchorRef = useRef<View>(null);
  const [anchor, setAnchor] = useState({ x: 0, y: 0, width: 0 });
  const [cardHeight, setCardHeight] = useState(0);
  const measureAnchor = () =>
    anchorRef.current?.measureInWindow((x, y, width) => {
      setAnchor({ x, y, width });
    });
  const outsideTouch = useRef({ x: 0, y: 0, moved: false });
  // The composer owns region selection, including folds, occlusions and keyboard.
  const region = availableRegion ?? {
    x: insets.left,
    y: insets.top,
    width: window.width - insets.left - insets.right,
    height: window.height - insets.top - insets.bottom,
  };
  const cardWidth = Math.max(
    1,
    Math.min(
      304,
      viewport.width - spacing.xl * 2,
      region.width - spacing.lg * 2,
    ),
  );
  const maxCardHeight = Math.max(
    1,
    region.height - spacing.lg * 2,
  );
  const cardLeft = Math.max(
    region.x + spacing.lg,
    Math.min(
      anchor.x + anchor.width - cardWidth,
      region.x + region.width - spacing.lg - cardWidth,
    ),
  );
  const cardTop = Math.max(
    region.y + spacing.lg,
    Math.min(
      anchor.y - cardHeight,
      region.y + region.height - spacing.lg - cardHeight,
    ),
  );
  const [mode, setMode] = useState<"closed" | "pinned" | "held">("closed");
  useEffect(() => {
    if (!enabled) setMode("closed");
  }, [enabled]);
  // A pane can move or resize without changing the native window dimensions.
  useEffect(
    () => setMode("closed"),
    [
      window.width,
      window.height,
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height,
      region.x,
      region.y,
      region.width,
      region.height,
    ],
  );
  const longPressed = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [internalHistory, setInternalHistory] = useState(() => {
    const cached = loadCachedRateHistory(sessionKey);
    return cached
      ? { ...cached, baseline: null, lastReport: null, latestRate: null }
      : emptyRateHistory(null);
  });
  useEffect(() => {
    if (managedHistory) return;
    setInternalHistory((previous) =>
      recordRunningTokenRate(previous, {
        startedAt,
        outputTokens,
        generationDurationMs,
        generationReliable,
      }),
    );
  }, [managedHistory, startedAt, outputTokens, generationDurationMs, generationReliable]);
  const history = managedHistory ?? internalHistory;
  useEffect(() => {
    if (managedHistory) return;
    saveCachedRateHistory(sessionKey, internalHistory);
  }, [managedHistory, sessionKey, internalHistory]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (history.latestSampleAt === undefined) return;
    setNow(Date.now());
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, history.latestSampleAt + RATE_SAMPLE_FRESH_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [history.latestSampleAt]);
  // Keep observing counters before the first rate is available. Only the
  // interaction surface is conditional; it must not own sampling lifetime.
  if (!enabled) return <View pointerEvents="none">{children}</View>;
  const recent =
    generationReliable &&
    (startedAt === null || startedAt === history.startedAt) &&
    history.latestSampleAt !== undefined &&
    Math.max(now, Date.now()) - history.latestSampleAt < RATE_SAMPLE_FRESH_MS
      ? history.latestRate
      : null;
  const average =
    generationReliable && generationDurationMs > 0 && outputTokens > 0
      ? (outputTokens * 1000) / generationDurationMs
      : null;
  const samples = history.samples;
  const firstTime = samples[0]?.durationMs ?? 0;
  const span = (samples.at(-1)?.durationMs ?? 0) - firstTime;
  const ceiling = Math.max(1, ...samples.map((sample) => sample.rate));
  const points = samples.map((sample) => ({
    x: span > 0 ? 4 + ((sample.durationMs - firstTime) / span) * 108 : 112,
    y: 44 - (sample.rate / ceiling) * 36,
  }));
  const line = points
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");
  const last = points.at(-1);
  const rateText = (rate: number | null) =>
    rate === null
      ? "—"
      : t("session.screen.tokenRate", { rate: formatTokenRate(rate) });
  const card = (
    <View
      pointerEvents={mode === "held" ? "none" : "auto"}
      onStartShouldSetResponder={() => true}
      onAccessibilityEscape={() => setMode("closed")}
      testID="session.tokenRate.card"
      onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
      style={[
        styles.card,
        {
          width: cardWidth,
          maxHeight: maxCardHeight,
          left: cardLeft - (mode === "held" ? anchor.x : 0),
          top: cardTop - (mode === "held" ? anchor.y : 0),
          opacity: cardHeight > 0 ? 1 : 0,
        },
      ]}
      accessibilityLabel={t("session.screen.tokenRateDescription")}
    >
      <ScrollView
        style={{ maxHeight: maxCardHeight - 2 }}
        contentContainerStyle={styles.cardContent}
      >
        <View style={styles.top}>
          <View style={styles.metric}>
            <Text style={styles.label}>{t("session.screen.currentRate")}</Text>
            <Text style={styles.value}>
              {formatTokenRate(recent)}{" "}
              <Text style={styles.label}>
                {t("session.screen.tokenRateUnit")}
              </Text>
            </Text>
          </View>
          <Svg
            width={120}
            height={48}
            viewBox="0 0 120 48"
            accessibilityLabel={t("session.screen.rateHistory")}
          >
            <Path d="M4 44H112" stroke={colors.textPrimary} opacity={0.12} />
            {points.length > 1 && (
              <>
                <Path
                  d={`${line} L112,44 L${points[0].x},44 Z`}
                  fill={colors.textPrimary}
                  opacity={0.08}
                />
                <Path
                  d={line}
                  fill="none"
                  stroke={colors.textPrimary}
                  strokeWidth={iconStroke.thin}
                  strokeLinejoin="round"
                />
              </>
            )}
            {last && (
              <Circle
                cx={last.x}
                cy={last.y}
                r={2.5}
                fill={colors.textPrimary}
              />
            )}
          </Svg>
        </View>
        <View style={styles.top}>
          {[
            ["averageRate", rateText(average)],
            [
              "outputTotal",
              t("session.screen.tokenCount", {
                tokens:
                  outputTokens >= 1000
                    ? `${(outputTokens / 1000).toFixed(1)}k`
                    : outputTokens,
              }),
            ],
            ["observedPeak", rateText(samples.length ? history.peak : null)],
          ].map(([key, value]) => (
            <View style={styles.metric} key={key}>
              <Text style={styles.label}>{t(`session.screen.${key}`)}</Text>
              <Text style={styles.detail}>{value}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
  return (
    <View
      ref={anchorRef}
      collapsable={false}
      style={styles.anchor}
      onLayout={measureAnchor}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: mode !== "closed" }}
        testID="session.tokenRate.trigger"
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
        onPressIn={(event) => {
          measureAnchor();
          longPressed.current = false;
          touchStart.current = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
          };
        }}
        onLongPress={() => {
          longPressed.current = true;
          setMode("held");
        }}
        onPress={() => {
          if (longPressed.current) return;
          if (mode === "pinned") {
            setMode("closed");
            return;
          }
          measureAnchor();
          setMode("pinned");
        }}
        onPressOut={() =>
          setMode((value) => (value === "held" ? "closed" : value))
        }
        onTouchCancel={() =>
          setMode((value) => (value === "held" ? "closed" : value))
        }
        onTouchMove={(event) => {
          const start = touchStart.current;
          if (
            start &&
            Math.hypot(
              event.nativeEvent.pageX - start.x,
              event.nativeEvent.pageY - start.y,
            ) > 8
          ) {
            longPressed.current = true;
          }
        }}
      >
        {children}
      </Pressable>
      {mode === "held" && card}
      <Modal
        supportedOrientations={[
          "portrait",
          "portrait-upside-down",
          "landscape-left",
          "landscape-right",
        ]}
        visible={mode === "pinned"}
        transparent
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setMode("closed")}
      >
        <View style={styles.overlay}>
          <Pressable
            testID="session.tokenRate.backdrop"
            style={StyleSheet.absoluteFill}
            accessible={false}
            onPressIn={(event) => {
              outsideTouch.current = {
                x: event.nativeEvent.pageX,
                y: event.nativeEvent.pageY,
                moved: false,
              };
            }}
            onTouchMove={(event) => {
              const start = outsideTouch.current;
              if (
                Math.hypot(
                  event.nativeEvent.pageX - start.x,
                  event.nativeEvent.pageY - start.y,
                ) > 8
              )
                start.moved = true;
            }}
            onPress={() => {
              if (!outsideTouch.current.moved) setMode("closed");
            }}
          />
          {card}
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: { flex: 1 },
    anchor: { position: "relative", flexShrink: 0 },
    trigger: {
      minHeight: 44,
      minWidth: 44,
      justifyContent: "center",
      borderRadius: radius.pill,
    },
    pressed: { opacity: 0.72 },
    card: {
      position: "absolute",
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.container,
      overflow: "hidden",
    },
    cardContent: {
      padding: spacing.md,
      gap: spacing.md,
    },
    top: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    metric: { flex: 1, gap: spacing.xs },
    label: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    value: {
      color: colors.textPrimary,
      fontSize: typeScale.headline,
      lineHeight: lineHeight.headline,
      fontWeight: fontWeight.medium,
      fontVariant: ["tabular-nums"],
    },
    detail: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
      fontVariant: ["tabular-nums"],
    },
  });
