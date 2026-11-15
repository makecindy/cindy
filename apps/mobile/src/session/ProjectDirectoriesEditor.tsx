import { useState } from "react";
import { View, Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react-native";
import type { ProjectDirectory } from "@cindy/maker-shared/project-alias-sync";
import { Text, TextInput } from "@/components/AppText";
import {
  MainWindowActionButton,
  MainWindowOptionButton,
} from "@/components/MobilePrimitives";
import {
  useTheme,
  spacing,
  radius,
  typeScale,
  lineHeight,
  iconSize,
} from "@/theme";

export function ProjectDirectoriesEditor({
  value,
  onChange,
  disabled,
  onBrowse,
}: {
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
        {label("additionalDirectories")}
      </Text>
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
          <View style={styles.row}>
            {(["read", "write"] as const).map((access) => (
              <MainWindowOptionButton
                key={access}
                label={label(access === "read" ? "readOnly" : "readWrite")}
                selected={item.access === access}
                disabled={disabled}
                onPress={() =>
                  onChange(
                    value.map((row, at) =>
                      at === index ? { ...row, access } : row,
                    ),
                  )
                }
              />
            ))}
          </View>
        </View>
      ))}
      {value.length < 10 && (
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
                if (clean && !value.some((item) => item.path === clean))
                  onChange([...value, { path: clean, access: "read" }]);
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
