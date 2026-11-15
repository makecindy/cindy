import { useState } from "react";
import { View, Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, Copy, X } from "lucide-react-native";
import type { ProjectDirectory } from "@cindy/maker-shared/project-alias-sync";
import { Text, TextInput } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import {
  useTheme,
  spacing,
  radius,
  typeScale,
  lineHeight,
  iconSize,
} from "@/theme";

export function ProjectDirectoriesEditor({
  mainDirectory,
  onMainDirectoryChange,
  copied,
  onCopy,
  allowAdd = true,
  value,
  onChange,
  disabled,
  onBrowse,
}: {
  mainDirectory: string;
  onMainDirectoryChange?: (path: string) => void;
  copied: boolean;
  onCopy: () => void;
  allowAdd?: boolean;
  value: readonly ProjectDirectory[];
  onChange(value: ProjectDirectory[]): void;
  disabled: boolean;
  onBrowse?: () => void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`settings.projectInfo.${key}`);
  const { colors } = useTheme();
  const [path, setPath] = useState("");
  return (
    <View style={styles.group}>
      <Text style={[styles.body, { color: colors.textPrimary }]}>
        {label("directories")}
      </Text>
      {mainDirectory && (
        <View style={[styles.item, { borderColor: colors.border }]}>
          <View style={styles.row}>
            <View style={{ flex: 1, gap: spacing.xs }}>
              <Text
                selectable
                style={[styles.body, { color: colors.textPrimary }]}
              >
                {mainDirectory}
              </Text>
              <Text style={[styles.note, { color: colors.textSecondary }]}>
                {label("mainDirectory")}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={label(
                onMainDirectoryChange
                  ? "removeDirectory"
                  : copied
                    ? "copied"
                    : "copy",
              )}
              disabled={disabled}
              style={styles.remove}
              onPress={() => {
                if (onMainDirectoryChange) {
                  onMainDirectoryChange(value[0]?.path ?? "");
                  onChange(value.slice(1));
                } else onCopy();
              }}
            >
              {onMainDirectoryChange ? (
                <X size={iconSize.md} color={colors.textSecondary} />
              ) : copied ? (
                <Check size={iconSize.md} color={colors.textSecondary} />
              ) : (
                <Copy size={iconSize.md} color={colors.textSecondary} />
              )}
            </Pressable>
          </View>
        </View>
      )}
      {value.map((item, index) => (
        <View
          key={item.path}
          style={[styles.item, { borderColor: colors.border }]}
        >
          <View style={styles.row}>
            <Text
              selectable
              style={[styles.body, { flex: 1, color: colors.textPrimary }]}
            >
              {item.path}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={label("removeDirectory")}
              disabled={disabled}
              style={styles.remove}
              onPress={() => onChange(value.filter((_, at) => at !== index))}
            >
              <X size={iconSize.md} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>
      ))}
      {allowAdd && value.length < 10 && (
        <View style={styles.group}>
          {onBrowse && (
            <MainWindowActionButton
              action={{
                label: label("browseDirectory"),
                tone: "secondary",
                disabled,
                onPress: onBrowse,
              }}
            />
          )}
          <TextInput
            value={path}
            onChangeText={setPath}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
            accessibilityLabel={label("directoryPath")}
            placeholder={label("directoryPath")}
            placeholderTextColor={colors.textPlaceholder}
            style={[
              styles.input,
              {
                color: colors.textPrimary,
                backgroundColor: colors.surfaceChip,
              },
            ]}
          />
          <MainWindowActionButton
            action={{
              label: label("addDirectory"),
              disabled: disabled || !path.trim(),
              tone: "secondary",
              onPress: () => {
                const clean = path.trim();
                if (
                  clean &&
                  clean !== mainDirectory &&
                  !value.some((item) => item.path === clean)
                ) {
                  if (!mainDirectory && onMainDirectoryChange)
                    onMainDirectoryChange(clean);
                  else onChange([...value, { path: clean, access: "write" }]);
                }
                setPath("");
              },
            }}
          />
        </View>
      )}
      <Text style={[styles.note, { color: colors.textSecondary }]}>
        {label("directoriesHint")}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  group: { gap: spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  item: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.container,
    padding: spacing.md,
  },
  remove: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.container,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
  },
});
