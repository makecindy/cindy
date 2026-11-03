import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import {
  fitGhostCardRecipients,
  ghostCardRecipients,
  GHOST_CARD_FORM_MAX_VALUE,
  type GhostCardFormField,
} from "@cindy/maker-shared/ghost-card-form";

type Props = {
  fields: GhostCardFormField[];
  disabled: boolean;
  readOnly?: boolean;
  onChange: (name: string, value: string) => void;
};

/** Mobile uses native text measurement and the same packing rule as Desktop. */
export function PluginCardRecipients({
  fields,
  disabled,
  readOnly = false,
  onChange,
}: Props) {
  const styles = useThemedStyles(makeStyles),
    { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [inputHeights, setInputHeights] = useState<Record<string, number>>({});
  return expanded ? (
    <View style={styles.root}>
      {fields.map((field, i) => (
        <View key={field.name} style={styles.editRow}>
          <Text style={[styles.label, styles.editLabel]}>{field.label}</Text>
          <TextInput
            accessibilityLabel={field.label}
            value={field.value}
            multiline
            scrollEnabled={false}
            onContentSizeChange={(event) => {
              const height = Math.max(
                44,
                Math.ceil(event.nativeEvent.contentSize.height),
              );
              setInputHeights((old) =>
                old[field.name] === height
                  ? old
                  : { ...old, [field.name]: height },
              );
            }}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={GHOST_CARD_FORM_MAX_VALUE}
            onChangeText={(value) => onChange(field.name, value)}
            style={[styles.input, { height: inputHeights[field.name] ?? 44 }]}
          />
          {i === 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: true }}
              style={styles.control}
              onPress={() => setExpanded(false)}
            >
              <Text style={styles.note}>{t("plugins.collapseFields")}</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  ) : (
    <RecipientSummary
      key={JSON.stringify(fields)}
      fields={fields.filter(
        (field) => field.name !== "bcc" && !field.collapsed,
      )}
      readOnly={readOnly}
      hasHiddenDetails={fields.some(
        (f) => (f.name === "bcc" || f.collapsed) && f.value.trim(),
      )}
      onExpand={() => setExpanded(true)}
    />
  );
}

function RecipientSummary({
  fields,
  onExpand,
  readOnly,
  hasHiddenDetails,
}: Omit<Props, "onChange" | "disabled"> & {
  onExpand: () => void;
  hasHiddenDetails: boolean;
}) {
  const styles = useThemedStyles(makeStyles),
    { t } = useTranslation();
  const [width, setWidth] = useState(0),
    [metrics, setMetrics] = useState<Record<string, number>>({});
  const entries = fields.map((field) => ghostCardRecipients(field.value));
  const more = (count: number) => (count ? `+${count}` : "+");
  const expand = t("plugins.expandFields");
  const groups = entries.map((items, i) => ({
    label: metrics[`label-${i}`],
    chips: items.map((_, j) => metrics[`chip-${i}-${j}`]),
    more: Array.from(
      { length: items.length + 1 },
      (_, j) => metrics[`more-${i}-${j}`],
    ),
  }));
  const ready =
    width > 0 &&
    metrics.toggle !== undefined &&
    groups.every((g) =>
      [g.label, ...g.chips, ...g.more].every((v) => v !== undefined),
    );
  const available = width - fields.length * spacing.sm;
  const fullCounts = ready
    ? fitGhostCardRecipients(available, groups, spacing.xs)
    : fields.map(() => 0);
  const canExpand =
    !readOnly ||
    hasHiddenDetails ||
    (ready &&
      entries.some(
        (items, i) =>
          fullCounts[i] < items.length ||
          items.some(
            (entry, j) =>
              entry.label !== entry.address || metrics[`chip-${i}-${j}`] >= 160,
          ),
      ));
  const counts =
    ready && canExpand
      ? fitGhostCardRecipients(available - metrics.toggle, groups, spacing.xs)
      : fullCounts;
  const record = (key: string, value: number) =>
    setMetrics((old) => (old[key] === value ? old : { ...old, [key]: value }));
  return (
    <View
      style={styles.root}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View style={styles.summary}>
        {fields.map((field, i) => (
          <View key={field.name} style={styles.group}>
            <Text style={styles.label}>{field.label}</Text>
            {entries[i].slice(0, counts[i]).map((entry, j) =>
              canExpand ? (
                <Pressable
                  key={j}
                  accessibilityRole="button"
                  accessibilityLabel={`${field.label}: ${entry.address}`}
                  style={styles.control}
                  onPress={onExpand}
                >
                  <Text numberOfLines={1} style={styles.chip}>
                    {entry.label}
                  </Text>
                </Pressable>
              ) : (
                <Text key={j} numberOfLines={1} style={styles.chip}>
                  {entry.label}
                </Text>
              ),
            )}
            {(counts[i] < entries[i].length || !entries[i].length) && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${field.label}: ${expand} (${entries[i].length})`}
                style={styles.control}
                onPress={onExpand}
              >
                <Text style={styles.more}>
                  {more(entries[i].length - counts[i])}
                </Text>
              </Pressable>
            )}
          </View>
        ))}
        {canExpand && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            style={[styles.control, styles.toggle]}
            onPress={onExpand}
          >
            <Text style={styles.note}>{expand}</Text>
          </Pressable>
        )}
      </View>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.measure}
      >
        <Text
          style={styles.note}
          onLayout={(e) => record("toggle", e.nativeEvent.layout.width)}
        >
          {expand}
        </Text>
        {fields.map((field, i) => (
          <View key={field.name} style={styles.measureGroup}>
            <Text
              style={styles.label}
              onLayout={(e) => record(`label-${i}`, e.nativeEvent.layout.width)}
            >
              {field.label}
            </Text>
            {entries[i].map((entry, j) => (
              <Text
                key={j}
                numberOfLines={1}
                style={styles.chip}
                onLayout={(e) =>
                  record(`chip-${i}-${j}`, e.nativeEvent.layout.width)
                }
              >
                {entry.label}
              </Text>
            ))}
            {Array.from({ length: entries[i].length + 1 }, (_, j) => (
              <Text
                key={`more-${j}`}
                style={styles.more}
                onLayout={(e) =>
                  record(`more-${i}-${j}`, e.nativeEvent.layout.width)
                }
              >
                {more(j)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: {
      width: "100%",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      overflow: "hidden",
    },
    summary: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 44,
    },
    group: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      flexShrink: 0,
    },
    control: {
      minHeight: 44,
      justifyContent: "center",
      borderRadius: radius.pill,
      flexShrink: 0,
    },
    toggle: { marginLeft: "auto" },
    label: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: c.textTertiary,
    },
    note: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: c.textSecondary,
    },
    chip: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: c.textPrimary,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: c.surfaceChip,
      maxWidth: 160,
    },
    more: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: c.textTertiary,
      paddingHorizontal: spacing.xs,
    },
    editRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.sm,
      paddingVertical: 0,
    },
    editLabel: { paddingTop: spacing.sm },
    input: {
      flex: 1,
      minWidth: 0,
      minHeight: 44,
      padding: spacing.xs,
      borderRadius: radius.control,
      textAlignVertical: "top",
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: c.textPrimary,
    },
    // Keep intrinsic widths unconstrained by the summary; never expose duplicate labels to accessibility.
    measure: {
      position: "absolute",
      top: 0,
      left: 0,
      opacity: 0,
      flexDirection: "row",
      width: 100000,
    },
    measureGroup: { flexDirection: "row", flexShrink: 0, alignItems: "center" },
  });
