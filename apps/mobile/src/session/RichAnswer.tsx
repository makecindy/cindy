import {
  Mail,
  CalendarDays,
  Folder,
  ChartColumn,
  Check,
  Info,
  Clock,
  MapPin,
  Coffee,
  Image,
  Users,
  Star,
} from "lucide-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  useMemo,
  useRef,
  useState,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  View,
  AppState,
  Pressable,
  Switch,
  StyleSheet,
  type GestureResponderEvent,
  type ViewStyle,
  type TextStyle,
  type StyleProp,
} from "react-native";
import { Text, TextInput } from "@/components/AppText";
import Svg, {
  Path,
  Rect,
  Ellipse,
  Polygon,
  Polyline,
  Line,
  Circle,
  Text as SvgText,
} from "react-native-svg";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/AuthContext";
import {
  useTheme,
  useThemedStyles,
  spacing,
  radius,
  textStyles,
  fontWeight,
  iconSize,
  iconStroke,
  type ThemeColors,
} from "@/theme";
import {
  splitRichAnswer,
  type RichValues,
  richVisualStyle,
  richColor,
  richVector,
  RichAnswerStream,
  RichSubmissionController,
  richSendText,
  RichInteractionMemory,
  richAction,
  richChart,
  richLinePlot,
  richResolvedValues,
  richCalculationUnavailable,
  richLabel,
  richMarkdown,
  richNumber,
  richOptions,
  richRange,
  richString,
  type RichNode,
  type RichPalette,
  type RichValue,
} from "@cindy/maker-shared/rich-answer";
import { useSessionQuickSend } from './SessionQuickSendContext';
import type { ChatFilePathContextValue } from './chatFilePathContext';

/** Answer colors are Cindy theme colors; the model only names a role. */
const richPalette = (colors: ThemeColors): RichPalette => ({
  primary: colors.textPrimary,
  secondary: colors.textSecondary,
  tertiary: colors.textTertiary,
  success: colors.statusDone,
  warning: colors.warningFg,
  danger: colors.statusError,
  border: colors.border,
});

const answerIcons = {
  mail: Mail,
  calendar: CalendarDays,
  folder: Folder,
  chart: ChartColumn,
  check: Check,
  info: Info,
  clock: Clock,
  location: MapPin,
  coffee: Coffee,
  image: Image,
  users: Users,
  star: Star,
};

const memory = new RichInteractionMemory({
  async read() {
    return AsyncStorage.getItem("cindy.richAnswer.viewState.v1");
  },
  async write(value) {
    await AsyncStorage.setItem("cindy.richAnswer.viewState.v1", value);
  },
});
/** Click-time copy: an export never changes the conversation's local controls. */
export function snapshotRichAnswerValues(
  source: string,
  scope: {
    userId: string | undefined;
    origin: Pick<ChatFilePathContextValue, 'deviceId' | 'sessionId'> | null;
    messageKey: string;
  },
): Readonly<Record<number, RichValues>> {
  const stateKey = `${scope.userId ?? 'signed-out'}:${scope.origin?.deviceId ?? ''}:${scope.origin?.sessionId ?? ''}:${scope.messageKey}`;
  return Object.fromEntries(
    splitRichAnswer(source)
      .filter((part) => part.kind === "rich")
      .map((part) => [part.key, { ...memory.get(`${stateKey}:${part.key}`) }]),
  );
}

const submissions = new RichSubmissionController(memory);

function RichSendAction({ node, text, receiptKey, ready, style, buttonTextStyle }: {
  node: RichNode; text: string | undefined; receiptKey: string; ready: boolean;
  style?: StyleProp<ViewStyle>; buttonTextStyle: TextStyle;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const sender = useSessionQuickSend();
  const status = useSyncExternalStore(submissions.subscribe, () => submissions.status(receiptKey, text));
  const disabled = !ready || !sender || !text || status === 'sending' || status === 'sent';
  return <View style={[styles.stack, style]}>
    {text ? <Text style={styles.caption}>{text}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled, busy: status === 'sending' }} disabled={disabled}
      style={styles.button}
      onPress={() => { if (!disabled) void submissions.submit(receiptKey, text, sender); }}>
      <Text style={buttonTextStyle}>{status === 'sending' ? t('message.richAnswer.sending') : status === 'sent' ? t('message.richAnswer.sent') : richString(node, 'label', richString(node, 'text')) || t('message.richAnswer.send')}</Text>
    </Pressable>
    {status === 'failed' ? <Text accessibilityRole="alert" style={styles.caption}>{t('message.richAnswer.sendFailed')}</Text> : null}
  </View>;
}
type Props = {
  source: string;
  complete: boolean;
  stateKey: string;
  renderMedia?: (node: RichNode) => ReactNode;
  renderMarkdown: (source: string, id: string) => ReactNode;
};
export function RichAnswer(props: Props) {
  const { user } = useAuth();
  const key = `${user?.id ?? "signed-out"}:${props.stateKey}`;
  return <RichDocumentView {...props} key={key} stateKey={key} />;
}
function RichDocumentView({
  source,
  complete,
  stateKey,
  renderMarkdown,
  renderMedia,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const palette = richPalette(colors);
  const [rootWidth, setRootWidth] = useState(0);
  const baseStyles = useThemedStyles(makeStyles);
  const styles = baseStyles;
  const parser = useRef(new RichAnswerStream());
  const doc = useMemo(
    () => parser.current.update(source, complete),
    [source, complete],
  );
  const edited = useSyncExternalStore(memory.subscribe, () =>
    memory.get(stateKey),
  );
  useEffect(() => {
    void memory.load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void memory.flush();
    });
    return () => {
      subscription.remove();
      void memory.flush();
    };
  }, []);
  const values = richResolvedValues(doc, edited);
  const change = (key: string, value: RichValue) => {
    memory.set(stateKey, { [key]: value });
  };
  const apply = (node: RichNode) => {
    memory.set(stateKey, richAction(node, values));
  };
  const render = (id: string, inherited: TextStyle = {}): ReactNode => {
    const node = doc.nodes.get(id);
    if (!node) return null;
    const visual = richVisualStyle(node, palette);
    const textStyle: TextStyle = { ...inherited };
    const viewStyle: ViewStyle = {};
    for (const [key, value] of Object.entries(visual)) {
      if (
        [
          "color",
          "fontSize",
          "fontWeight",
          "fontFamily",
          "fontStyle",
          "lineHeight",
          "letterSpacing",
          "textAlign",
          "textDecorationLine",
        ].includes(key)
      )
        (textStyle as Record<string, unknown>)[key] = value;
      else (viewStyle as Record<string, unknown>)[key] = value;
    }
    if (["image", "video", "audio"].includes(node.kind)) {
      delete viewStyle.height;
      delete viewStyle.minHeight;
      delete viewStyle.maxHeight;
    }
    // Answers written on a desktop are read here too: fixed widths stay within the screen.
    if (typeof viewStyle.width === "number" && viewStyle.maxWidth === undefined)
      viewStyle.maxWidth = "100%";
    if (typeof viewStyle.minWidth === "number")
      viewStyle.minWidth = rootWidth
        ? Math.min(viewStyle.minWidth, rootWidth)
        : undefined;
    const result = renderContent(id, textStyle);
    if (!isValidElement(result)) return result;
    const element = result as ReactElement<{
      style?: StyleProp<ViewStyle | TextStyle>;
    }>;
    return cloneElement(element, {
      style: [element.props.style, viewStyle],
    });
  };
  const renderContent = (id: string, textStyle: TextStyle): ReactNode => {
    const styledText = (base: TextStyle): TextStyle => {
      const size = Number(textStyle.fontSize ?? base.fontSize);
      const line = textStyle.lineHeight;
      return {
        ...base,
        ...textStyle,
        lineHeight:
          line === undefined
            ? (size * Number(base.lineHeight)) / Number(base.fontSize)
            : line <= 4
              ? size * line
              : line,
      };
    };
    const styles = {
      ...baseStyles,
      text: styledText(baseStyles.text),
      heading: styledText(baseStyles.heading),
      caption: styledText(baseStyles.caption),
      iconTitle: styledText(baseStyles.iconTitle),
      statValue: styledText(baseStyles.statValue),
      buttonText: styledText(baseStyles.buttonText),
      input: styledText(baseStyles.input),
    };
    const button = (label: string, action: () => void, selected?: boolean) => (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={action}
        style={[styles.button, selected && styles.selected]}
      >
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    );
    const node = doc.nodes.get(id);
    if (!node) return null;
    if (richCalculationUnavailable(node, values))
      return (
        <Text style={styles.caption}>
          {complete ? t("message.richAnswer.calculationUnavailable") : "…"}
        </Text>
      );
    const bind = richString(node, "bind", id),
      label = richString(node, "label");
    const children = node.children.map((child) => (
      <Fragment key={child}>{render(child, textStyle)}</Fragment>
    ));
    if (["image", "video", "audio"].includes(node.kind) && renderMedia)
      return (
        <View style={styles.content}>
          {renderMedia(node)}
          {richString(node, "caption") ? (
            <Text style={styles.caption}>{richString(node, "caption")}</Text>
          ) : null}
        </View>
      );
    const md = richMarkdown(node);
    if (md !== null)
      return (
        <View style={styles.content}>
          {renderMarkdown(md, id)}
          {richString(node, "caption") ? (
            <Text style={styles.caption}>{richString(node, "caption")}</Text>
          ) : null}
        </View>
      );
    switch (node.kind) {
      case "svg":
        return <AnswerVector node={node} palette={palette} />;
      case "text":
      case "heading":
        return (
          <Text
            selectable
            style={node.kind === "heading" ? styles.heading : styles.text}
          >
            {richLabel(node, values)}
          </Text>
        );
      case "icon": {
        const name = richString(node, "name");
        const Icon = Object.prototype.hasOwnProperty.call(answerIcons, name)
          ? answerIcons[name as keyof typeof answerIcons]
          : Info;
        return (
          <View style={styles.iconRow}>
            <Icon
              size={richNumber(node, "size", iconSize.action)}
              strokeWidth={richNumber(node, "strokeWidth", iconStroke.thin)}
              color={textStyle.color ?? colors.textPrimary}
              accessible={false}
            />
            <View style={styles.iconBody}>
              <Text style={styles.iconTitle}>{label || name}</Text>
              {richString(node, "text") ? (
                <Text style={styles.text}>{richString(node, "text")}</Text>
              ) : null}
            </View>
          </View>
        );
      }
      case "divider":
        return <View style={styles.divider} />;
      case "stack":
      case "group":
        return <View style={styles.stack}>{children}</View>;
      case "row":
      case "grid":
        return (
          <AnswerLayout
            node={node}
            palette={palette}
            renderChild={(child) => render(child, textStyle)}
          />
        );
      case "stat":
        return (
          <View style={styles.stat}>
            <Text style={styles.caption}>{label}</Text>
            <Text selectable style={styles.statValue}>
              {richLabel(node, values)}
            </Text>
          </View>
        );
      case "input":
        return (
          <View style={styles.stack}>
            <Text style={styles.text}>{label}</Text>
            <TextInput
              accessibilityLabel={label}
              value={String(values[bind] ?? "")}
              onChangeText={(v) => change(bind, v)}
              maxLength={4096}
              placeholder={richString(node, "placeholder")}
              placeholderTextColor={colors.textPlaceholder}
              style={styles.input}
            />
          </View>
        );
      case "range":
        return (
          <View>
            <View style={styles.labelRow}>
              <Text style={styles.text}>{label}</Text>
              <Text style={styles.text}>
                {richRange(node, values[bind]).value}
                {richString(node, "suffix")}
              </Text>
            </View>
            <AnswerRange
              node={node}
              value={values[bind]}
              onChange={(v) => change(bind, v)}
            />
          </View>
        );
      case "check":
        return (
          <View style={styles.labelRow}>
            <Text style={[styles.text, styles.content]}>
              {label || richString(node, "text")}
            </Text>
            <Switch
              accessibilityLabel={label}
              value={Boolean(values[bind])}
              onValueChange={(v) => change(bind, v)}
              trackColor={{
                false: colors.borderStrong,
                true: colors.textSecondary,
              }}
            />
          </View>
        );
      case "select":
        return (
          <View style={styles.stack}>
            <Text style={styles.text}>{label}</Text>
            <View style={styles.row}>
              {richOptions(node).map((option) => (
                <Fragment key={option.value}>
                  {button(
                    option.label,
                    () => change(bind, option.value),
                    values[bind] === option.value,
                  )}
                </Fragment>
              ))}
            </View>
          </View>
        );
      case "button":
        if (Object.prototype.hasOwnProperty.call(node.props, 'send'))
          return <RichSendAction node={node} text={richSendText(node, values)} receiptKey={`${stateKey}:sent:${id}`} ready={complete && !doc.issues} buttonTextStyle={styles.buttonText} />;
        return button(label || richString(node, "text"), () => apply(node));
      case "form":
        if (Object.prototype.hasOwnProperty.call(node.props, 'send'))
          return <View style={styles.stack}>{children}<RichSendAction node={node} text={richSendText(node, values)} receiptKey={`${stateKey}:sent:${id}`} ready={complete && !doc.issues} buttonTextStyle={styles.buttonText} /></View>;
        return (
          <View style={styles.stack}>
            {children}
            {label ? button(label, () => apply(node)) : null}
          </View>
        );
      case "details":
        return (
          <View style={styles.stack}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: Boolean(values[bind]) }}
              onPress={() => change(bind, !values[bind])}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{label}</Text>
            </Pressable>
            <View style={!values[bind] ? styles.hidden : undefined}>
              {children}
            </View>
          </View>
        );
      case "tabs": {
        const selected = node.children.includes(String(values[bind]))
          ? String(values[bind])
          : node.children[0];
        return (
          <View style={styles.stack}>
            <View style={styles.row}>
              {node.children.map((child) => (
                <Fragment key={child}>
                  {button(
                    richString(doc.nodes.get(child)!, "label", child),
                    () => change(bind, child),
                    selected === child,
                  )}
                </Fragment>
              ))}
            </View>
            {node.children.map((child) => (
              <View
                key={child}
                style={selected !== child ? styles.hidden : undefined}
              >
                {render(child, textStyle)}
              </View>
            ))}
          </View>
        );
      }
      case "chart": {
        const data = richChart(node, values),
          min = Math.min(0, ...data.map((item) => item.value)),
          max = Math.max(0, ...data.map((item) => item.value)),
          span = max - min || 1;
        return (
          <View style={styles.stack}>
            <Text style={styles.text}>{label}</Text>
            {richString(node, "variant") === "line" ? (
              <AnswerLineChart data={data} label={label} node={node} />
            ) : null}
            {richString(node, "variant") !== "line" &&
              data.map((item, index) => (
                <View key={index}>
                  <View style={styles.labelRow}>
                    <Text style={styles.caption}>{item.label}</Text>
                    <Text style={styles.caption}>{item.value}</Text>
                  </View>
                  {richString(node, "variant") !== "line" ? (
                    <View style={styles.track}>
                      <View
                        style={[
                          styles.bar,
                          {
                            backgroundColor:
                              richColor(
                                (node.props.colors as unknown[])?.[index],
                                palette,
                              ) ??
                              richColor(node.props.color, palette) ??
                              colors.textSecondary,
                            marginLeft: `${((Math.min(0, item.value) - min) / span) * 100}%`,
                            width: `${(Math.abs(item.value) / span) * 100}%`,
                          },
                        ]}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
          </View>
        );
      }
      default:
        return null;
    }
  };
  return (
    <View
      testID="message.richAnswer"
      style={styles.stack}
      onLayout={(e) => setRootWidth(e.nativeEvent.layout.width)}
    >
      {doc.roots.map((id) => (
        <Fragment key={id}>{render(id)}</Fragment>
      ))}
      {doc.issues ? (
        <Text style={styles.caption}>{t("message.richAnswer.incomplete")}</Text>
      ) : null}
    </View>
  );
}
function AnswerVector({
  node,
  palette,
  style,
}: {
  node: RichNode;
  palette: RichPalette;
  style?: StyleProp<ViewStyle>;
}) {
  const [width, setWidth] = useState(0);
  const vector = richVector(node, palette);
  const dims = vector.viewBox.split(" ").map(Number);
  const box = StyleSheet.flatten(style) ?? {};
  const height = Math.min(
    typeof box.maxHeight === "number" ? box.maxHeight : Infinity,
    Math.max(
      typeof box.minHeight === "number" ? box.minHeight : 0,
      typeof box.height === "number" ? box.height : (width * dims[3]) / dims[2],
    ),
  );
  const types = {
    path: Path,
    rect: Rect,
    circle: Circle,
    ellipse: Ellipse,
    line: Line,
    polyline: Polyline,
    polygon: Polygon,
    text: SvgText,
  };
  return (
    <View style={style} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Svg
        width="100%"
        height={height}
        viewBox={vector.viewBox}
        // Unpainted shapes take the host text color instead of SVG's default black.
        fill={palette.primary}
        accessibilityLabel={richString(node, "label", richString(node, "alt"))}
      >
        {vector.shapes.map((shape, index) =>
          createElement(
            types[shape.type] as React.ComponentType<any>,
            { ...shape.props, key: index },
            shape.text,
          ),
        )}
      </Svg>
    </View>
  );
}
function AnswerLayout({
  node,
  palette,
  renderChild,
  style,
}: {
  node: RichNode;
  palette: RichPalette;
  renderChild: (id: string) => ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [width, setWidth] = useState(0);
  const visual = richVisualStyle(node, palette);
  const aside = richString(node, "layout") === "aside";
  const mobile = width <= 600 && !aside;
  const weights = Array.isArray(node.props.weights)
    ? node.props.weights.filter(
        (v): v is number =>
          typeof v === "number" && Number.isFinite(v) && v > 0,
      )
    : aside
      ? [0.7, 1.8]
      : [];
  const columns =
    visual.flexDirection === "column"
      ? 1
      : Math.max(
          1,
          Math.round(
            mobile
              ? richNumber(node, "mobileColumns", 1)
              : weights.length || richNumber(node, "columns", 2),
          ),
        );
  const gap = Number(visual.gap ?? spacing.sm);
  const horizontalPadding =
    Number(visual.paddingLeft ?? visual.padding ?? 0) +
    Number(visual.paddingRight ?? visual.padding ?? 0);
  const usable = Math.max(
    0,
    width -
      horizontalPadding -
      2 * Number(visual.borderWidth ?? 0) -
      gap * (columns - 1),
  );
  return (
    <View
      style={[{ flexDirection: "row", flexWrap: "wrap", gap }, style]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {node.children.map((id, i) => (
        <View
          key={id}
          style={{
            width:
              !mobile && columns > 1 && weights.length
                ? (usable * weights[i % columns]) /
                  weights.reduce((a, b) => a + b, 0)
                : usable / columns,
            minWidth: 0,
          }}
        >
          {renderChild(id)}
        </View>
      ))}
    </View>
  );
}
function AnswerLineChart({
  data,
  label,
  node,
}: {
  data: { label: string; value: number }[];
  label: string;
  node: RichNode;
}) {
  const { colors } = useTheme();
  const color =
    richColor(node.props.color, richPalette(colors)) ?? colors.textPrimary;
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(320);
  const plot = richLinePlot(data, width, node.props);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Svg
        width="100%"
        height={plot.height}
        viewBox={`0 0 ${plot.width} ${plot.height}`}
        accessible
        accessibilityLabel={`${label}. ${data.map((item) => `${item.label}: ${item.value}`).join(", ")}`}
      >
        {plot.ticks.map((tick) => (
          <Fragment key={tick.value}>
            {node.props.showGrid !== false && (
              <Line
                x1={plot.left}
                x2={plot.width - plot.right}
                y1={tick.y}
                y2={tick.y}
                stroke={colors.border}
              />
            )}
            <SvgText
              x={plot.left - 6}
              y={tick.y + 4}
              textAnchor="end"
              fontSize={textStyles.footnote.fontSize}
              fill={colors.textSecondary}
            >
              {tick.label}
            </SvgText>
          </Fragment>
        ))}
        <Polyline
          fill="none"
          stroke={color}
          strokeWidth={richNumber(node, "strokeWidth", iconStroke.regular)}
          points={plot.points.map((p) => `${p.x},${p.y}`).join(" ")}
        />
        {plot.labels.map((tick, i) => (
          <SvgText
            key={`label-${i}`}
            x={tick.x}
            y={plot.labelY}
            textAnchor="middle"
            fontSize={textStyles.footnote.fontSize}
            fill={colors.textSecondary}
          >
            {tick.label}
          </SvgText>
        ))}
        {plot.points.map((p, i) => (
          <Fragment key={i}>
            {node.props.showPoints !== false && (
              <Circle
                cx={p.x}
                cy={p.y}
                r={richNumber(node, "pointRadius", 3)}
                fill={color}
              />
            )}
            {plot.showValues ? (
              <SvgText
                x={p.x}
                y={p.y - 10}
                textAnchor="middle"
                fontSize={textStyles.footnote.fontSize}
                fill={colors.textPrimary}
              >
                {p.value}
              </SvgText>
            ) : null}
          </Fragment>
        ))}
      </Svg>
    </View>
  );
}
function AnswerRange({
  node,
  value,
  onChange,
}: {
  node: RichNode;
  value: unknown;
  onChange: (value: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const range = richRange(node, value),
    usable = Math.max(1, width - 28);
  const clamp = (n: number) => Math.max(range.min, Math.min(range.max, n));
  const pick = (event: GestureResponderEvent) => {
    const ratio = Math.max(
      0,
      Math.min(1, (event.nativeEvent.locationX - 14) / usable),
    );
    onChange(
      clamp(
        range.min +
          Math.round((ratio * (range.max - range.min)) / range.step) *
            range.step,
      ),
    );
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={richString(node, "label")}
      accessibilityValue={{ min: range.min, max: range.max, now: range.value }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) =>
        onChange(
          clamp(
            range.value +
              (event.nativeEvent.actionName === "increment"
                ? range.step
                : -range.step),
          ),
        )
      }
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={pick}
      onResponderMove={pick}
      style={styles.range}
    >
      <View pointerEvents="none" style={styles.rangeTrack} />
      <View
        pointerEvents="none"
        style={[
          styles.thumb,
          {
            left:
              ((range.value - range.min) / (range.max - range.min)) * usable,
          },
        ]}
      />
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    iconRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.md,
    },
    iconBody: { flex: 1, gap: spacing.xs, minWidth: 0 },
    iconTitle: {
      ...textStyles.bodyLarge,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    stack: { gap: spacing.lg, minWidth: 0 },
    content: { minWidth: 0, flexShrink: 1 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    labelRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: spacing.md,
    },
    text: {
      ...textStyles.bodyLarge,
      color: colors.textPrimary,
      fontWeight: fontWeight.regular,
      flexShrink: 1,
    },
    heading: {
      ...textStyles.subtitle,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    caption: {
      ...textStyles.footnote,
      color: colors.textSecondary,
      fontWeight: fontWeight.regular,
    },
    stat: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingVertical: spacing.md,
      gap: spacing.xs,
    },
    statValue: {
      ...textStyles.headline,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    divider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.pill,
      alignSelf: "flex-start",
    },
    selected: { borderWidth: 1, borderColor: colors.borderStrong },
    buttonText: {
      ...textStyles.body,
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    input: {
      ...textStyles.body,
      color: colors.textPrimary,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.pill,
      minHeight: 44,
      paddingHorizontal: spacing.lg,
    },
    hidden: { display: "none" },
    track: {
      height: 8,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.micro,
      overflow: "hidden",
    },
    bar: { height: "100%", backgroundColor: colors.textSecondary },
    range: { height: 44, justifyContent: "center" },
    rangeTrack: {
      height: 4,
      marginHorizontal: 14,
      backgroundColor: colors.borderStrong,
      borderRadius: radius.pill,
    },
    thumb: {
      position: "absolute",
      height: 28,
      width: 28,
      borderRadius: radius.pill,
      backgroundColor: colors.textPrimary,
    },
  });
